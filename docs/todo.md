# TODO

Active implementation plan for tilt-mcp.

---

## MCP Server MVP

---

### Phase 1: Project Scaffold ✅

Set up the TypeScript project with its build pipeline, a minimal MCP server, and the integration test infrastructure.

#### Tasks

- [x] Initialise TypeScript project (`package.json`, `tsconfig.json`)
- [x] Create minimal MCP server entry point (`src/index.ts`) with stdio transport
- [x] Add `src/tilt/client.ts` — HTTP client stub
- [x] Add `src/tilt/types.ts` — type stubs for Tilt API resources
- [x] Write `Dockerfile` (multi-stage, Node.js 22 Alpine)
- [x] Write `Makefile` (`build`, `push`, `test` targets)
- [x] Write `docs/architecture.md`, `docs/contributions.md`
- [x] Create root `Tiltfile` loading three example resources
- [x] Add `examples/always-succeeds`, `examples/always-fails-build`, `examples/always-fails-runtime`
- [x] Add integration tests in `src/tests/integration/resources.test.ts` using `node:test`

#### Verification

`npm run build` exits 0. `docker build .` exits 0. `make test` passes against a running `tilt up` session.

---

### Phase 2: Tilt API Client + Resource Tools

Implement the Tilt API HTTP client and the first set of MCP tools for reading resource status.

#### Design

The Tilt API is a Kubernetes-style REST API at `http://<host>:<port>/apis/tilt.dev/v1alpha1/`. All requests are unauthenticated GETs. The client wraps native `fetch` and returns typed responses.

Three tools for this phase:

- `list-resources` — list all Tilt resources with name and current build/runtime status
- `get-resource` — fetch full status and spec for a named resource
- `get-session` — return overall Tilt session state (error count, build status, start time)
- `get-resource-logs` — fetch the build log output for the most recent build of a named resource

#### Tasks

- [ ] Implement `src/tilt/client.ts` with `get` and `list` helpers configurable via `TILT_HOST` / `TILT_PORT`
- [ ] Fill out `src/tilt/types.ts` with `UIResource`, `UIResourceList`, `UISession`, and status sub-fields
- [ ] Implement `list-resources` and `get-resource` tools in `src/tools/resources.ts`
- [ ] Implement `get-session` tool in `src/tools/session.ts`
- [ ] Register all tools in `src/index.ts`
- [ ] Manual smoke test: start a local Tilt session, confirm tools return meaningful output

#### Verification

Tools respond correctly when Tilt is running. Tools return a clear, actionable error message when Tilt is not reachable.

---

### Phase 3: Docker Image Distribution

Publish the image to Docker Hub and validate the full Docker-based workflow.

#### Tasks

- [ ] Run `make push` and confirm image is accessible at `docker.io/benjaminwright/tilt-mcp`
- [ ] Validate VS Code MCP config (`docker run -i --rm`) against a live Tilt session
- [ ] Document the VS Code config snippet in `README.md`
- [ ] Tag a `v0.1.0` release

#### Verification

A fresh `docker run -i --rm -e TILT_HOST=host.docker.internal benjaminwright/tilt-mcp` starts without error and all MCP tools respond correctly from VS Code.
