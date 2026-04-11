# Project Guidelines

## Documentation Map

- [README.md](../README.md) — project overview and quick start. Begin here for orientation.
- [docs/architecture.md](../docs/architecture.md) — technology decisions, system design, and component responsibilities. Read before making design-level changes.
- [docs/contributions.md](../docs/contributions.md) — development setup, build targets, project layout, and workflow guides. Read before making changes.
- [docs/standards.md](../docs/standards.md) — coding conventions, testing strategy, and project-wide rules. Read before writing or reviewing code.
- [docs/todo.md](../docs/todo.md) — the active implementation plan. All planned work lives here. Read before starting any implementation task.

## Agent Posture

**Gather context freely. Reason proactively. Decide nothing without approval.**

- Read broadly — search the codebase, read documentation, run tests. Never guess when you can look.
- When you identify multiple valid approaches, present them with trade-offs and a recommendation. Do not pick one silently.
- Question directives that conflict with existing code, standards, or architecture — cite the specific conflict and ask for resolution.
- Suggest simpler or more effective alternatives when you see them, even if not asked.
- Never make design decisions, deviate from `docs/todo.md`, or take irreversible actions without explicit approval.
- Never write generated files by hand (e.g. lock files, generated code). Run the tool or note the exact command.
- Never add npm packages by editing `package.json` directly or running `npm install`. Always tell the user to run `npq install <package>` and wait for them to confirm it is installed before proceeding.

## Diagnostics and Error Checking

**Prefer LSP diagnostics over running builds to check for errors.**

- Always use `get_errors` to query LSP diagnostics before running a build. The IDE has already computed these — running a build to re-discover them is slow and redundant.
- Only run a build when LSP diagnostics are clean and you need to catch things outside the LSP's scope (missing files, codegen, runtime config), or when explicitly asked.
- After editing a file, call `get_errors` on the changed file to validate the change before moving on.
- If `get_errors` returns no results for a file that should have LSP coverage (e.g. a `.ts` file), flag this to the user — it may mean the language server isn't running or is misconfigured.
- If LSP errors exist that you are intentionally ignoring (e.g. they pre-existed and are unrelated to the current task), say so explicitly. Do not silently skip past them.
- Persistent unexplained LSP errors across the workspace are worth flagging — they often indicate a misconfigured linter, missing tsconfig, or broken extension.

## Context Before Action

Before changing code, read the relevant sources — do not rely on memory or assumptions.

| Change type | Required reading |
|---|---|
| Any implementation | `docs/todo.md`, `docs/standards.md` |
| Design or structural | `docs/architecture.md` |
| Build, deploy, or workflow | `docs/contributions.md` |
