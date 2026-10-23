# tilt-mcp

A local stdio MCP server for starting the two development environments and using
Tilt to inspect builds, deployments, logs and tests.

## Run through Codex

```sh
npm ci
npm run build
```

Use the local STDIO definition in `mcp.example.toml`. It runs Node with this
repository's `build/index.js` and supplies the development tools' `PATH`.
After changing the build, restart the MCP server in Codex to load it.

## Start and stop

Call `local_dev` with exactly these two fields:

```json
{"environment":"db-operator","execute":"start"}
```

`environment` is `db-operator` or `wasm-platform`; `execute` is `start` or `stop`.
The repositories must sit beside this one under `~/Code/wasm`.

Start stops the current Tilt session, tears down the other environment with
`make cluster-down`, and runs `make cluster-up` when the selected cluster needs
creating. An already running selected cluster is reused. A stopped selected
cluster is recreated through those Makefile targets.

Tilt runs as a foreground exec session held in memory by this MCP. Repeating
start reuses the running Tilt session. Switching environments, calling stop,
or closing the MCP stops that session. Stop also runs `make cluster-down`.
MCP shutdown leaves the cluster available; its next start can reuse it.
Use one MCP process to manage these environments.

Stop can interrupt an in-flight start for the same environment, waits for its
command cleanup, then tears down that cluster. Concurrent stops share cleanup;
overlapping starts and stops for another environment are rejected. Cancelling
an MCP lifecycle request interrupts its commands. Each lifecycle operation has
a five-minute deadline; cancelled command cleanup is bounded.

The managed Tilt process receives `SIGINT`, then `SIGKILL` after five seconds
if necessary, with a further two-second shutdown deadline. Lifecycle commands
use `SIGTERM` before the same escalation. Signals target only owned child
processes and their POSIX process groups. Failed shutdown retains the handle
for diagnostics and retry.

The Makefiles own cluster, registry and kubeconfig setup. Tilt uses their
`~/.scratch/<environment>.yaml` kubeconfig and the fixed local port `10350`.
Its console output goes to MCP stderr; stdout is reserved for MCP messages.

## Tilt process diagnostics

If Tilt exits or its API tools fail, call `local_dev_diagnostics`:

```json
{"environment":"wasm-platform","maxBytes":16384}
```

This read-only tool works without Tilt's API. It returns the managed process's
status, PID, start/exit times, exit code or signal, launch error, and a combined
stdout/stderr tail. Status is `not_started`, `running`, `exited`, `stopped`
(stop requested by MCP), or `failed` (process could not launch).

`maxBytes` is optional, defaults to 16 KiB, and accepts integers from 1 to 64 KiB.
The output reports returned UTF-8 bytes and dropped bytes, including both buffer
eviction and a smaller requested tail. Console output is treated as log data.

Only the latest Tilt launch attempt for each environment is retained, through
crashes, stop and environment switches. A new launch replaces that environment's
record. Data stays in bounded memory and is lost when the MCP restarts; output
from processes launched before capture was enabled cannot be recovered.
Diagnostics accepts no commands, paths, URLs, PIDs or environment overrides and
does not execute commands, read files, query the network or restart Tilt.

## Build and test feedback

After start, use `get-session` and `list-resources` to inspect startup. Use
`get-resource` and `get-resource-logs` for failures. To verify a fresh build or
test run, call `trigger-resource`, then `wait-for-build` with its resource name.
A successful start launches Tilt; build and test success must be checked separately.

Use `cancel-resource` with a resource name to request cancellation of its active
build or test:

```json
{"name":"execution-host: regression-tests"}
```

Cancellation uses Tilt's generated Stop Build button. It returns
`cancel_requested` after Tilt accepts the request; inspect the resulting build
with `get-resource` or `wait-for-build`. An idle resource returns `not_building`.
Queued-only tasks cannot be cancelled through this action, and a queued rebuild
behind an active build remains queued. The request targets the observed build's
start timestamp so it cannot cancel a later replacement build.

Call `trigger-resource` to run the build again and `wait-for-build` to verify its
fresh completion. Cancelling a wait stops observation; use `cancel-resource` to
stop the underlying build. Both build actions accept only a resource name and
honour MCP request cancellation. Cancelling builds leaves services and the
development cluster running.

The db-operator suites are `test-migrations`, `test-postgres`, `test-redis`,
`test-nats` and `test-migration-sets`. wasm-platform has automatic `e2e-tests`
and manual `wp: unit-tests` and `wp: integration-tests`.

Wait checks complete snapshots, deployment readiness and build/runtime errors.
Manual tests that have not run are reported as skipped. Trigger freshness is
tracked within the current MCP process; trigger explicitly after code edits.

Logs and rebuild requests use the installed Tilt CLI, which authenticates to
the running server. Log reads return the latest 2,000 records, filtered by
resource and source. Status, waits and Stop Build requests use Tilt's
authenticated TLS API. CLI commands have a ten-second deadline and bounded
output; cancellation stops the owned command process.

## Kubernetes reads

Three read-only tools access the selected environment's Kubernetes API directly,
including while Tilt is stopped:

| Tool | Result |
|---|---|
| `list_kubernetes_api_resources` | Served group/version/kind, collection name, namespace scope and supported verbs; failed API versions appear in `errors` |
| `list_kubernetes_resources` | A page of objects containing only `apiVersion`, `kind` and `metadata` |
| `get_kubernetes_resource` | One complete resource object, including its spec and status |

All require `environment`. List and get also require `group`, `version` and
`kind`; use `group: ""` for core resources. For example, list Pods with:

```json
{"environment":"wasm-platform","group":"","version":"v1","kind":"Pod"}
```

Lists span all namespaces unless `namespace` is supplied. Single-object reads
require `name`, plus `namespace` for namespaced kinds. Omit namespace for
cluster-scoped kinds. Discovery resolves the kind to its collection name and
includes custom resources; subresources are excluded.

Lists default to 100 objects and accept `limit` from 1 to 500. Pass a returned
`metadata.continue` value as `continue` with the same resource selection to read
the next page. Only metadata is returned, even if an aggregated API falls back
to a full object response.

Access uses `~/.scratch/<environment>.yaml` and its `k3d-<environment>` context.
The server must be HTTPS on loopback (`0.0.0.0` is mapped to `127.0.0.1`).
Authentication uses embedded CA and client certificate/key data or a token;
credential files, exec plugins, proxies and disabled TLS verification are rejected.
Requests are GET only, time out after 10 seconds and accept at most 4 MiB.
Discovery has a 30-second deadline, at most four concurrent reads, and caps of
256 API versions and 10,000 resource definitions. Inputs cannot select commands,
flags, URLs, kubeconfigs, contexts, arbitrary paths, watches or mutations.

## Development

The lifecycle implementation is in `src/local-dev.ts`; managed Tilt process
capture is in `src/tilt/process.ts`. Commands and the Tilt session factory are
injected so tests can use fakes without Docker or privileges.
Bounded subprocess termination is shared through `src/process.ts`.
Kubernetes connection and discovery are in `src/kubernetes/`. MCP registration
is in `src/tools/local-dev.ts` and `src/tools/kubernetes.ts`.

```sh
npm run test:unit
```

The existing integration tests require a running Tilt environment:

```sh
npm run test:integration
```
