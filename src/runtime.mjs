import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { restoreOCI } from './image-cache.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The ci tag is the one mutable reference the action accepts: LocalCloud moves it only to a released image that
// passed qualification, so the action needs no change per release. Any other image must be pinned by digest.
export const CI_IMAGE = 'agentcloud/localcloud:ci';
export const DEFAULT_IMAGE = CI_IMAGE;
const PINNED_IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const OWNER_LABEL = 'cloud.local.setup-localcloud.owner';
const SKIPPED_KEYS = new Set();
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const CONTEXT_KEYS = new Set(['GOOGLE_CLOUD_PROJECT', 'GCLOUD_PROJECT', 'GOOGLE_PROJECT', 'CLOUDSDK_CORE_PROJECT', 'LOCALCLOUD_USER', 'LOCALCLOUD_PRINCIPAL', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN']);

export function options(env = process.env) {
  const get = (name, fallback = '') => env[`INPUT_${name.toUpperCase()}`]?.trim() || fallback;
  const services = [...new Set(get('services', 'gcs,pubsub,bigquery').split(',').map(s => s.trim()))];
  if (!services.length || services.length > 40 || services.some(s => !/^[a-z][a-z0-9]*$/.test(s))) throw new Error('services must be comma-separated LocalCloud service IDs');
  const project = get('project-id', 'localcloud-ci');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) throw new Error('project-id must be a 6–30 character Google Cloud project ID');
  const seconds = Number(get('timeout', '120'));
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800) throw new Error('timeout must be 1–1800 seconds');
  const image = get('image', DEFAULT_IMAGE);
  if (image !== CI_IMAGE && !PINNED_IMAGE.test(image)) throw new Error(`image must be ${CI_IMAGE} or pinned with @sha256:<64 hex characters>`);
  if (image === CI_IMAGE && get('image-cache')) throw new Error('image-cache requires an image pinned with @sha256:<64 hex characters>');
  let url = get('runtime-url');
  const ports = JSON.parse(get('port-map', '{}'));
  if (!ports || Array.isArray(ports) || typeof ports !== 'object' || Object.entries(ports).some(([key,value])=>!/^\d{1,5}$/.test(key) || Number(key)<1 || Number(key)>65535 || !Number.isInteger(value) || value<1 || value>65535)) throw Error('port-map must map canonical ports to integer ports between 1 and 65535');
  if (!url && Object.keys(ports).length) throw Error('port-map requires runtime-url');
  if (url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('runtime-url must be an HTTP(S) gateway origin without credentials, path or query');
    if (/(^|\.)(googleapis\.com|google\.com|gcr\.io|pkg\.dev)$/i.test(parsed.hostname)) throw new Error('runtime-url cannot be a real Google endpoint');
    if (parsed.protocol !== 'http:') throw new Error('Existing runtime must use a local HTTP gateway; TLS SDK configuration is not automatic');
    const gatewayPort=Number(parsed.port || '80');
    if (ports['5380'] && ports['5380'] !== gatewayPort) throw Error('port-map gateway must match runtime-url');
    ports['5380']=gatewayPort;
    url = parsed.origin;
  }
  const controlToken = get('control-token');
  // LocalCloud's control-token rules: at least 32 printable ASCII characters, none of space " , ; or \.
  if (controlToken && (controlToken.length < 32 || !/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/.test(controlToken))) throw Error('control-token must be at least 32 printable ASCII characters without spaces, double quotes, commas, semicolons or backslashes');
  const boolean = name => {const value=get(name,'false');if(!['true','false'].includes(value))throw Error(`${name} must be true or false`);return value==='true';};
  return { services, project, seconds, image, url, ports, imageCache:get('image-cache'), controlToken, dockerAccess:boolean('docker-access'), mcp:boolean('mcp') };
}

export function docker(args) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${(result.stderr || result.stdout).trim().slice(-3000)}`);
  return result.stdout.trim();
}

export function githubFile(file, key, value) {
  value = String(value);
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) || /[\r\n\0]/.test(value)) throw new Error('Invalid GitHub environment-file entry');
  if (file) appendFileSync(file, `${key}=${value}\n`);
}

export function acquireImage(config, command = docker) {
  const server = JSON.parse(command(['version', '--format', '{{json .Server}}']));
  const platform = {os:server.Os, architecture:server.Arch};
  if (platform.os !== 'linux' || !platform.architecture) throw Error('LocalCloud requires a Linux Docker server with a known architecture');
  let reference = config.image;
  let inspected;
  let pulled = '';
  // The ci tag is always pulled, so a warm runner never keeps an outdated ci image.
  const moving = config.image === CI_IMAGE;
  if (!moving) {
    try { inspected = command(['image', 'inspect', reference]); }
    catch (error) { if (!/No such image/i.test(error.message)) throw error; }
  }
  if (!inspected && config.imageCache) {
    try {
      reference = restoreOCI(config.imageCache, config.image, platform, command);
      inspected = command(['image', 'inspect', reference]);
    } catch (cacheError) {
      console.error(`LocalCloud image cache unavailable; using pinned registry image: ${cacheError.message.slice(0,300)}`);
      reference = config.image;
    }
  }
  if (!inspected) {
    try { pulled = command(['pull', '--platform', `${platform.os}/${platform.architecture}`, config.image]); }
    catch (pullError) {
      const guidance = /toomanyrequests|rate.?limit|429/i.test(pullError.message)
        ? 'Registry limit reached. Configure registry credentials before setup or use a verified mirror; retrying immediately will not reset a quota.'
        : /unauthorized|authentication|denied/i.test(pullError.message)
          ? 'Registry authentication failed. Check docker login credentials and access to the requested image.'
          : 'Image acquisition failed before LocalCloud startup. Check registry connectivity and the image reference.';
      throw new Error(`${guidance}\n${pullError.message}`, {cause:pullError});
    }
    inspected = command(['image', 'inspect', config.image]);
  }
  const image = JSON.parse(inspected)[0];
  if (!image || !/^sha256:[a-f0-9]{64}$/.test(image.Id || '') || !image.Config) throw Error('Invalid Docker image inspection');
  if (image.Os !== platform.os || image.Architecture !== platform.architecture) throw Error(`LocalCloud image platform ${image.Os}/${image.Architecture} does not match Docker ${platform.os}/${platform.architecture}`);
  if (reference.startsWith('sha256:') && image.Id !== reference) throw Error('Loaded image configuration digest mismatch');
  let digest = config.image.includes('@') ? config.image : '';
  if (moving) {
    const repository = CI_IMAGE.split(':')[0];
    const fromPull = /Digest:\s*(sha256:[a-f0-9]{64})/.exec(pulled || '')?.[1];
    const recorded = (image.RepoDigests || []).map(d => d.replace(/^docker\.io\//, '')).filter(d => d.split('@')[0] === repository);
    digest = fromPull ? `${repository}@${fromPull}` : recorded.length === 1 ? recorded[0] : '';
    if (!PINNED_IMAGE.test(digest)) throw Error(`Could not resolve ${CI_IMAGE} to a registry digest`);
    console.log(`LocalCloud image ${CI_IMAGE} resolved to ${digest}`);
    // Run the exact image that was pulled, even if the local tag moves before docker run.
    reference = image.Id;
  }
  return {image, reference, platform, digest};
}

export function startRuntime(config, { command = docker, stateFile = process.env.GITHUB_STATE } = {}) {
  if (config.url) return { url: config.url, ports: config.ports || {'5380':Number(new URL(config.url).port || 80)}, strictPorts:new URL(config.url).port !== '5380' || Object.keys(config.ports || {}).length>1, record: null };
  if (process.platform !== 'linux' && !process.env.LOCALCLOUD_ACTION_LOCAL_TEST) throw new Error('Starting LocalCloud requires a Linux Docker runner; use runtime-url to connect to an existing runtime');
  const owner = randomUUID();
  const {image, reference, platform, digest} = acquireImage(config, command);
  const ports = Object.keys(image.Config.ExposedPorts || {}).filter(p => /^\d+\/tcp$/.test(p)).map(p => Number(p.split('/')[0]));
  if (!ports.includes(5380) || ports.length > 100 || ports.some(p => p < 1 || p > 65535)) throw new Error('Image must expose the LocalCloud gateway on 5380/tcp');
  const name = `localcloud-ci-${owner}`;
  // Save ownership before creation so post cleanup can recover a partially failed docker run.
  const record = { id: name, owner, network:name, volume:`${name}-data` };
  record.hash=ownershipHash(record.network,record.volume);
  githubFile(stateFile, 'localcloud_record', JSON.stringify(record));
  const labels={[OWNER_LABEL]:owner,'com.localcloud.managed':'true','com.localcloud.volume-name':record.volume,'com.localcloud.config-hash':record.hash};
  const labelArgs=Object.entries(labels).flatMap(([key,value])=>['--label',`${key}=${value}`]);
  const args = ['run', '--platform', `${platform.os}/${platform.architecture}`, '-d', '--pull', 'never', '--name', name, ...labelArgs, '--network',record.network,'--network-alias','localcloud','--mount',`type=volume,src=${record.volume},dst=/var/lib/localcloud`, '--memory', '4g', '-e', `LOCALCLOUD_SERVICES=${config.services.join(',')}`, '-e', `LOCALCLOUD_PROJECT=${config.project}`, '-e', `LOCALCLOUD_DOCKER_ACCESS=${config.dockerAccess}`, '-e', 'LOCALCLOUD_TELEMETRY=false','-e',`LOCALCLOUD_RUNTIME_NETWORK=${record.network}`,'-e',`LOCALCLOUD_DATA_VOLUME=${record.volume}`,'-e',`LOCALCLOUD_CONFIG_HASH=${record.hash}`,'-e','LOCALCLOUD_MCP_WRITE=false','-e','LOCALCLOUD_MCP_DESTRUCTIVE=false'];
  if(config.controlToken) args.push('-e',`LOCALCLOUD_CONTROL_TOKEN=${config.controlToken}`);
  if(config.dockerAccess) args.push('--mount','type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock','-e','DOCKER_HOST=unix:///var/run/docker.sock');
  for (const port of ports) args.push('-p', `127.0.0.1::${port}`);
  try {
    command(['network','create',...labelArgs,record.network]);
    command(['volume','create',...labelArgs,record.volume]);
    const id = command([...args, reference]);
    record.id = id;
    githubFile(stateFile, 'localcloud_record', JSON.stringify(record));
    const container = JSON.parse(command(['container','inspect', id]))[0];
    const mapped = Object.fromEntries(ports.map(port => {
      const bindings = container.NetworkSettings.Ports[`${port}/tcp`];
      if (!bindings?.length || bindings[0].HostIp !== '127.0.0.1') throw new Error(`Missing loopback publication for ${port}`);
      return [String(port), Number(bindings[0].HostPort)];
    }));
    return { url: `http://127.0.0.1:${mapped['5380']}`, ports: mapped, record, network:record.network, imageReference:reference, imageDigest:digest, platform };
  } catch (error) {
    cleanup(record, command);
    throw error;
  }
}

async function request(url, { method = 'GET', body, milliseconds = 10_000, token = '', headers = {} } = {}) {
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(milliseconds), headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { 'X-LocalCloud-Control-Token': token } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('LocalCloud response exceeds 1 MiB');
  if (!response.ok) {
    const tokenHint = response.status === 401 && /control token/i.test(text)
      ? (token ? 'The control-token input does not match the runtime\'s control token. ' : 'This runtime requires its control token (it is on whenever remote access is enabled). Pass the same value as the runtime\'s LOCALCLOUD_CONTROL_TOKEN through the control-token input. ')
      : '';
    const error = new Error(`${tokenHint}LocalCloud ${method} ${new URL(url).pathname} returned HTTP ${response.status}: ${text.slice(0,800)}`);
    error.status = response.status;
    throw error;
  }
  return JSON.parse(text);
}

export async function configure(config, runtime) {
  const call = (url, settings = {}) => request(url, { ...settings, token: config.controlToken });
  const deadline = Date.now() + config.seconds * 1000;
  let last = 'no readiness response';
  let catalog;
  while(Date.now()<deadline) {
    try {catalog=await call(`${runtime.url}/services`,{milliseconds:Math.max(1,Math.min(5000,deadline-Date.now()))});break;}
    catch(error) {if(error.status && error.status!==503)throw error;last=error.message;await delay(Math.min(1000,Math.max(0,deadline-Date.now())));}
  }
  if(!Array.isArray(catalog?.services)) throw Error(`LocalCloud service catalog unavailable: ${last}`);
  for(const id of config.services) {
    const matches=catalog.services.filter(s=>s.id===id);
    if(matches.length!==1)throw Error(`Unknown LocalCloud service ID: ${id}. See the selected runtime's /services catalog.`);
    const service=matches[0];
    if(service.coverage_status==='unsupported' || service.availability==='unavailable' || service.startable===false)throw Error(`LocalCloud service ${id} is unsupported or unavailable in this image`);
    for(const dependency of service.runtime_dependencies || []) {
      if(dependency.required && dependency.status!=='available')throw Error(`LocalCloud ${id} requires ${dependency.id}: ${dependency.message || dependency.status}. ${dependency.id==='docker'?'For an owned runtime set docker-access: true; existing runtime prerequisites remain with its owner.':''} ${(dependency.resolution_steps || []).join(' ')}`);
    }
    if(service.enabled===false)throw Error(`LocalCloud service ${id} is disabled in this runtime; enable it in the runtime owner's configuration and check its tier requirements.`);
  }
  runtime.catalog=catalog.services;
  runtime.endpointKeys=new Set(catalog.services.map(s=>s.env_var).filter(key=>typeof key==='string' && key.endsWith('_HOST')));
  while (Date.now() < deadline) {
    try {
      const ready = await call(`${runtime.url}/readiness?services=${config.services.join(',')}`, { milliseconds: Math.max(1, Math.min(5000, deadline - Date.now())) });
      if (ready.ready === true && config.services.every(id => ready.services?.some(s => s.service_id === id && s.ready === true))) break;
      last = 'selected services are not ready';
    } catch (error) {
      if (error.status && error.status !== 503) throw error;
      last = error.message;
    }
    await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
  if (Date.now() >= deadline) throw new Error(`LocalCloud readiness timed out after ${config.seconds}s: ${last}`);
  const projects = await call(`${runtime.url}/projects`);
  if (!Array.isArray(projects)) throw new Error('Unexpected LocalCloud projects response');
  if (!projects.some(p => p.project_id === config.project)) await call(`${runtime.url}/projects`, { method: 'POST', body: { project_id: config.project, display_name: config.project } });
  const env = await call(`${runtime.url}/env?format=json&project=${encodeURIComponent(config.project)}`);
  runtime.canonicalEnv=env;
  const configured=environment(env, runtime);
  if(configured.GOOGLE_CLOUD_PROJECT!==config.project)throw Error('LocalCloud env returned the wrong project');
  if(config.mcp) {
    // LocalCloud lists its write and destructive MCP tools only when those permissions are on, so their absence
    // shows the runtime is read-only for agents. create_project and delete_project stand for each group.
    const rpc = async (id, method, params = {}) => {
      const reply = await call(`${runtime.url}/mcp`, { method:'POST', body:{ jsonrpc:'2.0', id, method, params }, headers:{ 'X-LocalCloud-Project':config.project } });
      if (reply?.jsonrpc !== '2.0' || reply.id !== id || reply.error || !reply.result) throw Error(`LocalCloud MCP ${method} failed: ${JSON.stringify(reply?.error || reply).slice(0,300)}`);
      return reply.result;
    };
    const server = (await rpc(1, 'initialize', { protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{ name:'setup-localcloud', version:'0.1.1' } })).serverInfo;
    if (server?.name !== 'localcloud') throw Error('runtime-url does not serve the LocalCloud MCP server');
    const tools = (await rpc(2, 'tools/list')).tools;
    if (!Array.isArray(tools) || !tools.some(tool => tool?.name === 'localcloud_list_services')) throw Error('LocalCloud MCP returned an unexpected tool list');
    if (tools.some(tool => ['localcloud_create_project','localcloud_delete_project'].includes(tool?.name))) throw Error('MCP CI profile requires the same LocalCloud runtime with MCP write/destructive permissions disabled');
  }
  return configured;
}

export function environment(payload, runtime) {
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new Error('LocalCloud env must be a JSON object');
  const hostname = new URL(runtime.url).hostname;
  const result = {};
  for (const [key, value] of Object.entries(payload)) {
    const endpoint = key === 'LOCALCLOUD_GATEWAY' || key.endsWith('_EMULATOR_HOST') || runtime.endpointKeys?.has(key) || key.startsWith('CLOUDSDK_API_ENDPOINT_OVERRIDES_') || /^GOOGLE_.+_CUSTOM_ENDPOINT$/.test(key) || /^LOCALCLOUD_[A-Z0-9]+_(GRPC_AUTHORITY|REST_URL)$/.test(key);
    // The default ci image moves to newer runtimes, which may report keys this action does not know yet. Skip them
    // rather than fail the job; only known context and endpoint keys are ever exported.
    if (!endpoint && !CONTEXT_KEYS.has(key)) {
      if (!SKIPPED_KEYS.has(key)) { SKIPPED_KEYS.add(key); console.warn(`Skipping runtime environment key this action does not recognise: ${key}`); }
      continue;
    }
    if (typeof value !== 'string' || /[\r\n\0]/.test(value) || !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Invalid runtime environment value: ${key}`);
    if (endpoint) {
      const hasScheme = /^https?:\/\//.test(value);
      const parsed = new URL(hasScheme ? value : `http://${value}`);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || (!LOCAL_HOSTS.has(parsed.hostname) && parsed.hostname !== hostname)) throw new Error(`Nonlocal or invalid SDK endpoint: ${key}`);
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const mapped = runtime.ports[port];
      if ((runtime.record || runtime.strictPorts) && !mapped) throw new Error(`SDK endpoint uses an unpublished port or omitted port mapping: ${key}`);
      parsed.hostname = hostname;
      if (mapped) parsed.port = String(mapped);
      // SDK emulator roots without a slash must stay slashless (Storage concatenates its API path).
      const path = parsed.pathname === '/' && !/^https?:\/\/[^/?#]+\//i.test(value) ? '' : parsed.pathname;
      result[key] = hasScheme ? `${parsed.origin}${path}${parsed.search}` : `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}`;
    } else result[key] = value;
  }
  if (!result.GOOGLE_CLOUD_PROJECT) throw new Error('LocalCloud env omitted GOOGLE_CLOUD_PROJECT');
  return result;
}

export function ownershipHash(network, volume) {
  let hash=0;for(const character of `${network}\0${volume}`)hash=(Math.imul(hash,31)+character.charCodeAt(0))|0;
  return (hash>>>0).toString(16);
}

export function jobFiles(config,runtime,env,base=process.env.RUNNER_TEMP || tmpdir()) {
  const directory=mkdtempSync(join(base,'localcloud-ci-'));
  const envFile=join(directory,'sdk.env');
  writeFileSync(envFile,Object.entries(env).map(([key,value])=>`${key}=${value}\n`).join(''),{mode:0o600});
  let dockerEnvFile='';
  if(runtime.record && runtime.canonicalEnv) {
    dockerEnvFile=join(directory,'container.env');
    const containerEnv=environment(runtime.canonicalEnv,{url:'http://localcloud:5380',ports:{},record:null,endpointKeys:runtime.endpointKeys});
    writeFileSync(dockerEnvFile,Object.entries(containerEnv).map(([key,value])=>`${key}=${value}\n`).join(''),{mode:0o600});
  }
  let mcpConfig='';
  if(config.mcp) {
    mcpConfig=join(directory,'mcp.json');
    const connection={url:runtime.url,ports:runtime.ports,project:config.project,...(config.controlToken?{token:config.controlToken}:{})};
    writeFileSync(mcpConfig,JSON.stringify({mcpServers:{localcloud:{command:process.execPath,args:[fileURLToPath(new URL('./mcp-stdio.mjs',import.meta.url))],env:{LOCALCLOUD_MCP_CONNECTION:JSON.stringify(connection)}}}},null,2)+'\n',{mode:0o600});
  }
  return {envFile,dockerEnvFile,mcpConfig};
}

export function cleanup(record, command = docker) {
  if (!record) return;
  if (!/^[a-f0-9-]{36}$/.test(record.owner) || !/^(?:[a-f0-9]{64}|localcloud-ci-[a-f0-9-]{36})$/.test(record.id)) throw new Error('Invalid LocalCloud ownership record');
  if(record.network && (record.network!==`localcloud-ci-${record.owner}` || record.volume!==`${record.network}-data` || record.hash!==ownershipHash(record.network,record.volume)))throw Error('Invalid execution ownership record');
  let container;
  try { container = JSON.parse(command(['container','inspect', record.id]))[0]; }
  catch (error) { if (!/No such (?:object|container)/i.test(error.message)) throw error; }
  if(container) {
    if (container.Config.Labels?.[OWNER_LABEL] !== record.owner) throw new Error('Refusing to remove a container not owned by this action');
    if(record.network)command(['stop','--time','20',container.Id]);
  }
  if(record.network) {
    const expected={'com.localcloud.managed':'true','com.localcloud.volume-name':record.volume,'com.localcloud.config-hash':record.hash};
    const children=command(['ps','-aq','--no-trunc',...Object.entries(expected).flatMap(([key,value])=>['--filter',`label=${key}=${value}`])]).split(/\s+/).filter(Boolean);
    for(const id of children) {
      if(id===container?.Id)continue;
      let child;
      try {child=JSON.parse(command(['container','inspect',id]))[0];}
      catch(error) {if(/No such (object|container)/i.test(error.message))continue;throw error;}
      if(!Object.entries(expected).every(([key,value])=>child.Config.Labels?.[key]===value))throw Error('Refusing to remove a child owned by another runtime');
      command(['rm','-f','-v',child.Id]);
    }
  }
  if(container)command(['rm', '-f', '-v', container.Id]);
  if(record.network) {
    for(const [kind,name] of [['network',record.network],['volume',record.volume]]) {
      let resource;
      try {resource=JSON.parse(command([kind,'inspect',name]))[0];}
      catch(error) {if(/No such (?:network|volume)|network .+ not found/i.test(error.message))continue;throw error;}
      if(resource.Labels?.[OWNER_LABEL]!==record.owner || resource.Labels?.['com.localcloud.volume-name']!==record.volume || resource.Labels?.['com.localcloud.config-hash']!==record.hash || resource.Labels?.['com.localcloud.managed']!=='true')throw Error(`Refusing to remove ${kind} not owned by this action`);
      command([kind,'rm',name]);
    }
  }
}

export async function main() {
  const config = options();
  if (config.controlToken) console.log(`::add-mask::${config.controlToken}`);
  const runtime = startRuntime(config);
  try {
    const env = await configure(config, runtime);
    const files=jobFiles(config,runtime,env);
    for (const [key, value] of Object.entries(env)) {
      if (/TOKEN/.test(key)) console.log(`::add-mask::${value}`);
      githubFile(process.env.GITHUB_ENV, key, value);
    }
    for (const [key,value] of Object.entries({ 'runtime-url': runtime.url, 'container-id': runtime.record?.id || '', 'image-digest': runtime.imageDigest || '', 'project-id': config.project,network:runtime.network || '', 'env-file':files.envFile,'docker-env-file':files.dockerEnvFile,'mcp-url':config.mcp?`${runtime.url}/mcp`:'','mcp-config':files.mcpConfig })) githubFile(process.env.GITHUB_OUTPUT, key, value);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### LocalCloud ready\n\nProject: \`${config.project}\`\n\nServices: ${config.services.join(', ')}\n\nGateway: ${runtime.url}\n\n${runtime.record ? `Image: \`${runtime.imageDigest || config.image}\`\n\nThis action removes its container and anonymous volume after the job.` : 'Existing runtime: lifecycle remains with its owner.'}\n`);
    console.log(`LocalCloud ready at ${runtime.url}; project ${config.project}; services ${config.services.join(', ')}`);
  } catch (error) {
    cleanup(runtime.record);
    throw error;
  }
}
