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

The Makefiles own cluster, registry and kubeconfig setup. Tilt uses their
`~/.scratch/<environment>.yaml` kubeconfig and the fixed local port `10350`.
Its console output goes to MCP stderr; stdout is reserved for MCP messages.

## Build and test feedback

After start, use `get-session` and `list-resources` to inspect startup. Use
`get-resource` and `get-resource-logs` for failures. To verify a fresh build or
test run, call `trigger-resource`, then `wait-for-build` with its resource name.
A successful start launches Tilt; build and test success must be checked separately.

The db-operator suites are `test-migrations`, `test-postgres`, `test-redis`,
`test-nats` and `test-migration-sets`. wasm-platform has automatic `e2e-tests`
and manual `wp: unit-tests` and `wp: integration-tests`.

Wait checks complete snapshots, deployment readiness and build/runtime errors.
Manual tests that have not run are reported as skipped. Trigger freshness is
tracked within the current MCP process; trigger explicitly after code edits.

## Development

The lifecycle implementation is in `src/local-dev.ts`. Commands and the Tilt
session factory are injected so tests can use fakes without Docker or privileges.
The MCP registration is in `src/tools/local-dev.ts`.

```sh
npm run test:unit
```

The existing integration tests require a running Tilt environment:

```sh
npm run test:integration
```
