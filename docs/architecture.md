# Architecture

Technology decisions, system design, and design constraints for tilt-mcp. For coding conventions, see [standards.md](standards.md). For project overview and quick-start, see the [README](../README.md).

---

## 1. Key Technology Decisions

### Language & Runtime: TypeScript (Node.js)

| Option | Strengths | Weaknesses |
|---|---|---|
| **TypeScript (Node.js)** | Official MCP SDK, native `fetch` (Node.js ≥ 22), excellent types, small images | Runtime type gaps, npm supply chain risk |
| Go | Single binary, minimal image | Weaker MCP tooling |
| Rust | Smallest binary, fastest | Most setup overhead, immature MCP SDK |

**Decision:** TypeScript. The `@modelcontextprotocol/sdk` is the most mature MCP SDK. `fetch` is built-in to Node.js 22 — no additional HTTP client dependency needed.

### MCP Transport: stdio

MCP supports multiple transports. stdio is chosen because:

- VS Code (and Claude Desktop) spawn the server as a child process and pipe stdin/stdout for JSON-RPC 2.0 messages.
- No port needs to be exposed on the container.
- `docker run -i --rm` gives clean, stateless invocations — no lingering containers.

The server is invoked as:

```sh
docker run -i --rm -e TILT_HOST=host.docker.internal benjaminwright/tilt-mcp
```

### Tilt Connectivity: `host.docker.internal`

Tilt exposes a Kubernetes-style REST API at `http://localhost:10350/apis/tilt.dev/v1alpha1/`. When running inside Docker on macOS, `localhost` resolves to the container — not the host. Docker Desktop provides `host.docker.internal` as a DNS name that resolves to the host machine.

| Platform | Solution |
|---|---|
| macOS (Docker Desktop) | `host.docker.internal` — available automatically |
| Linux (Docker Engine) | Pass `--add-host=host.docker.internal:host-gateway` to `docker run` |

The Tilt host and port are configurable via `TILT_HOST` and `TILT_PORT` environment variables (defaults: `localhost`, `10350`).

### Distribution: Docker Hub

Images are built locally and pushed to Docker Hub under `benjaminwright/tilt-mcp`. No CI/CD publish pipeline — this is a personal tool intended for easy use across machines.

---

## 2. System Design

```
VS Code / Claude Desktop (host machine)
          │
          │  stdin / stdout  (MCP JSON-RPC 2.0)
          ▼
 docker run -i --rm tilt-mcp
          │
          │  HTTP GET  http://host.docker.internal:10350/apis/tilt.dev/v1alpha1/...
          ▼
 Tilt API server (host machine, port 10350)
```

The server is intentionally **stateless** — every tool call queries Tilt's API fresh. There is no caching or background polling.

---

## 3. Tilt API

Tilt embeds a Kubernetes-style API server. Resources are accessed at:

```
http://<host>:<port>/apis/tilt.dev/v1alpha1/<resource>[/<name>]
```

Resources used by this server:

| Resource | Purpose |
|---|---|
| `uiresources` | Per-resource build and runtime status |
| `uisessions` | Overall Tilt session state |
| `cmds` | Custom commands registered in the Tiltfile |
| `filewatches` | File watch configuration and last-seen timestamps |

All responses are JSON and follow Kubernetes list/object conventions (`items`, `metadata`, `status`).

---

## 4. Project Constraints

- **Read-only by default.** MCP tools that mutate state (e.g. trigger a resource rebuild) must be explicitly justified before being added.
- **No persistent state.** The server holds no state between invocations. Each tool call is self-contained.
- **Single process.** No worker threads, no subprocesses. The MCP server handles one request at a time via the stdio transport.
