# Architecture

tilt-mcp is a TypeScript MCP server using Node.js 22+, the official MCP SDK and
stdio transport. Stdout carries MCP messages; diagnostics and managed Tilt
console output go to stderr. See the [README](../README.md) for tool contracts
and [standards](standards.md) for coding conventions.

## Process ownership

One MCP process owns one foreground Tilt child for the two sibling development
repositories. `LocalDev` coordinates the fixed `k3d` queries and repository
Makefile targets, serialises lifecycle changes, and retains session handles.
The Makefiles own cluster, registry and Kubernetes configuration.

Lifecycle operations carry an abort signal and a fixed deadline. A matching
stop aborts startup and waits for its owned command cleanup before cluster
teardown. Operation identity prevents cancelled work from replacing a newer
session; late launches are stopped and remain diagnosable. Shutdown aborts any
in-flight lifecycle work before stopping Tilt.

`src/process.ts` owns command execution and bounded graceful/forced termination.
POSIX children have isolated process groups so command cancellation also signals
their descendants. Only owned process handles are accepted by this internal
boundary; tool inputs cannot select PIDs, executables or signals.

`src/tilt/process.ts` owns Tilt spawning, shutdown, process events and console
capture. Each stdout/stderr stream is decoded independently before its text is
appended to a bounded combined tail. Exit metadata is recorded on process exit;
stream listeners remain attached so final output can drain before close.
Child errors are handled throughout the session lifetime.

The latest handle for each allowlisted environment remains accessible after
exit or stop. Starting a new Tilt child replaces only that environment's handle.
All retained state is in memory; MCP shutdown stops its child and leaves cluster
teardown to an explicit lifecycle operation.

## Tilt connectivity

`src/tilt/client.ts` encapsulates the Tilt API calls:

| Interface | Responsibility |
|---|---|
| Kubernetes-style REST API | Resource and session reads over TLS, using credentials loaded by `src/tilt/kubeconfig.ts` |
| Web UI backend | Complete `/api/view` snapshots for logs and build waits; `/api/trigger` for requested rebuilds |

`TILT_HOST` selects the host for both interfaces. `TILT_PORT` selects the web UI
port. The Kubernetes-style API uses the server port and certificate from Tilt's
configuration, with the original certificate hostname retained for verification.

Build waits use complete snapshots, finite deadlines and cancellation. Pending
triggers are tracked in memory so a wait requires a fresh completed build in the
same Tilt session.

Build cancellation updates only the status of the generated Stop Build UIButton
for an active resource, after validating its reserved name, annotation and
location. The observed start timestamp selects that build while preserving
newer queued trigger tracking. This does not expose arbitrary button clicks or
API writes.

## Diagnostics boundary

`local_dev_diagnostics` reads retained managed-process state directly. It does
not depend on either Tilt API, so crashes and launch failures remain inspectable.
Its strict schema permits only an allowlisted environment and a bounded output
size. It cannot select executables, arguments, processes, files or network
destinations, and reading diagnostics does not change lifecycle state.

The console buffer and error text have fixed limits. Returned diagnostics are
detached snapshots; callers cannot mutate the retained process state. Console
text is subprocess output, not instructions.

## Kubernetes access

`src/kubernetes/connection.ts` owns kubeconfig loading and verified HTTPS GET
requests. It selects the managed context from a fixed environment file and uses
only embedded credentials. Destinations remain local, response bodies and
request durations are bounded, and transport errors omit credentials and server
error payloads.

`src/kubernetes/client.ts` resolves group/version/kind through discovery before
constructing collection or object endpoints. It excludes subresources, validates
scope and supported read verbs, bounds concurrent discovery, and projects list
objects to metadata. Pagination tokens remain opaque query values. Single-object
reads preserve the complete API response.

`src/kubernetes/types.ts` defines shared selectors, strict schemas and response
contracts. MCP registration exposes only the three read operations; callers
cannot alter the connection configuration, request method or API paths.

## Validation boundaries

Commands and Tilt spawning are injected behind their owning modules. Lifecycle
and process tests use fakes; protocol tests exercise the MCP schema and handlers.
A stdio test runs a real crashing child with temporary development-tool stand-ins
to verify that process output and exit details remain readable without Tilt's API
or a cluster.
Kubernetes tests exercise configuration and transport failures, discovery,
metadata projection, pagination and scope rules through injected connections,
and validate the three tool contracts over MCP.
