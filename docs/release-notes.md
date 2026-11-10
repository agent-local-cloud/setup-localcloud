# v0.1.1

## Runtime image: `agentcloud/localcloud:ci`

- The default `image` is now `agentcloud/localcloud:ci`. LocalCloud moves this tag to each new release only after it passes qualification, so new LocalCloud releases need no action or workflow change.
- v0.1.0's default image (LocalCloud 0.1.5, `agentcloud/localcloud@sha256:88e85b86…`) is no longer on Docker Hub, so v0.1.0 fails to pull unless `image` is set. Upgrade to v0.1.1, or pass `image: agentcloud/localcloud@sha256:<digest>` on v0.1.0.
- `image` accepts `agentcloud/localcloud:ci` or an image pinned with `@sha256:`; other tags are still refused. The `ci` tag is pulled on every run; the action logs the digest it resolved to and returns it as the new `image-digest` output. The container is started from the exact image that was pulled.
- Runtime environment keys the action does not recognise are skipped with a warning instead of failing the job, so a newer `ci` runtime cannot break setup by reporting a new key. Unknown keys are never exported. `LOCALCLOUD_GATEWAY`, which current runtimes report, is exported and rewritten to the published gateway port.
- `image-cache` requires a digest-pinned `image`. The cache and mirror workflows resolve `ci` to its digest before caching or copying.

## Integration updates since v0.1.0

- Reuse an exact locally cached runtime image and select the Docker server's platform explicitly. Optional OCI cache restoration verifies the pinned manifest, platform, configuration and layer hashes before use.
- Get service IDs, environment keys and execution requirements from the selected runtime. Unknown, unsupported, disabled and missing-prerequisite selections fail before project creation.
- Connect to remapped existing HTTP runtimes with `port-map`, and provide runner/container SDK environment files.
- Start each owned runtime with a unique network and data volume. Native workload execution uses explicitly enabled Docker socket access. Cleanup verifies ownership before removing job resources, including recovery from partial startup.
- Generate an optional job-local read-only MCP configuration targeting the same runtime and project. The stdio bridge forwards native MCP messages, cancellation and callbacks without installing the CLI or starting another runtime.
- Keep the explicit Storage, Pub/Sub and BigQuery examples. Firestore remains outside default/example selection. Service choice and runtime-image choice are independent of action releases.
- Add catalog, application-container, MCP, native-workload and cache qualification workflows, plus an explicitly dispatched digest-preserving registry mirror workflow.

See the [evidence ledger](release-evidence.md) for the qualified revision. No binary attachment is needed for this JavaScript action.
