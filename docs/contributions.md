# Contributing

Development setup, build targets, and workflow guides. For coding conventions, see [standards.md](standards.md). For technology decisions, see [architecture.md](architecture.md).

---

## Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) — for building and running the image
- [npq](https://github.com/lirantal/npq) — required for adding npm packages safely:
  ```sh
  brew install npq
  # or: npm install -g npq
  ```
- [Tilt](https://tilt.dev/) — to run a local Tilt session for testing

## Installing Dependencies

**Never run `npm install <pkg>` or edit `package.json` directly to add a package.** All new packages must be vetted through npq first — see [standards.md](standards.md) for the full policy.

To install all project dependencies after cloning:

```sh
npm install
```

To add a new package:

```sh
npq install <package>
```

## Build

```sh
npm run build    # compile TypeScript → build/
```

## Running Locally (without Docker)

While developing, run the server directly with Node. Add this to your VS Code MCP config (`.vscode/mcp.json`):

```json
{
  "servers": {
    "tilt": {
      "type": "stdio",
      "command": "node",
      "args": ["./build/index.js"],
      "env": { "TILT_HOST": "localhost" }
    }
  }
}
```

## Running via Docker

Build and run the image locally:

```sh
make build
docker run -i --rm -e TILT_HOST=host.docker.internal benjaminwright/tilt-mcp
```

VS Code MCP config for the Docker image (`.vscode/mcp.json`):

```json
{
  "servers": {
    "tilt": {
      "type": "stdio",
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

On Linux, add `"--add-host=host.docker.internal:host-gateway"` to the `args` array before the image name.

## Make Targets

| Target | Description |
|---|---|
| `make build` | Build the Docker image tagged `benjaminwright/tilt-mcp:latest` |
| `make push` | Push the image to Docker Hub |

## Project Layout

```
├── src/
│   ├── index.ts          # Entry point — MCP server with stdio transport
│   └── tilt/
│       ├── client.ts     # HTTP client for Tilt's v1alpha1 API
│       └── types.ts      # TypeScript types for Tilt API resources
├── build/                # Compiled output (git-ignored)
├── Dockerfile            # Multi-stage build → minimal Node.js runtime image
├── Makefile              # build and push targets
├── package.json
├── tsconfig.json
└── docs/
    ├── architecture.md   # Technology decisions and system design
    ├── contributions.md  # This file
    ├── standards.md      # Coding conventions
    └── todo.md           # Active implementation plan
```
