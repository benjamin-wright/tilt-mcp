# tilt-mcp

An MCP server that gives your AI assistant visibility into a running [Tilt](https://tilt.dev/) session. Ask it what's broken, what's building, and what's happening — without leaving your editor.

---

## What it does

When you're working on a multi-service project with Tilt, your AI assistant is blind to what Tilt is actually doing. You have to context-switch to the Tilt UI, copy errors, paste them into chat, and repeat every time something changes.

tilt-mcp bridges that gap. It connects to Tilt's built-in API and exposes a set of tools that your AI assistant can call to inspect the current state of your dev environment — build failures, runtime status, session errors — and reason about them alongside your code.

---

## Tools

| Tool | What it does |
|---|---|
| `list-resources` | List all Tilt resources with their current build and runtime status at a glance |
| `get-resource` | Get the full status detail for a specific resource — build history, errors, pod phase |
| `get-session` | Get overall session state — Tilt version, start time, and any fatal Tiltfile errors |

**Planned:**

| Tool | What it does |
|---|---|
| `trigger-resource` | Trigger a manual rebuild of a resource |
| `get-logs` | Fetch recent log output for a resource |

---

## Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (macOS / Windows) or Docker Engine (Linux)
- [Tilt](https://tilt.dev/) running locally (`tilt up`)

---

## Quick start

### VS Code

Add to your workspace MCP config (`.vscode/mcp.json`):

```json
{
  "servers": {
    "tilt": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "TILT_HOST=host.docker.internal",
				"-v", "${env:HOME}/.tilt-dev/config:/root/.tilt-dev/config:ro",
        "benjaminwright/tilt-mcp:v0.0.5"
      ]
    }
  }
}
```

On **Linux**, add `"--add-host=host.docker.internal:host-gateway"` to the `args` list before the image name.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tilt": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "TILT_HOST=host.docker.internal",
        "benjaminwright/tilt-mcp"
      ]
    }
  }
}
```

---

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `TILT_HOST` | `localhost` | Hostname where Tilt is running |
| `TILT_PORT` | `10350` | Port Tilt's API server listens on |

---

## How it works

tilt-mcp runs as a Docker container launched on demand by your AI client. Communication uses MCP's stdio transport — your client pipes JSON-RPC messages through stdin/stdout to the container, which in turn queries Tilt's REST API at `http://<TILT_HOST>:10350`. The container exits cleanly when the conversation ends.

No ports are exposed. No background processes. No persistent state.

---

## Building from source

```sh
git clone https://github.com/benjamin-wright/tilt-mcp.git
cd tilt-mcp
make build       # builds benjaminwright/tilt-mcp:latest
make push        # pushes to Docker Hub
```

See [docs/contributions.md](docs/contributions.md) for the full development setup.
