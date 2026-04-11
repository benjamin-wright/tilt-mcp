# Project Standards

Coding conventions, testing strategy, and project-wide rules. For technology decisions and system design, see [architecture.md](architecture.md). For development setup, see [contributions.md](contributions.md).

---

## General

### Reuse Over Reinvention

Before writing anything new — utility, pattern, convention, or routine — check whether an equivalent already exists in the project or an existing dependency. If it does, use it. If it does not, create it in an appropriate shared location so others can reuse it.

- Never duplicate a helper inline across files; parameterise a shared function to cover variant contexts.
- Shared data types that define cross-component contracts (serialisation payloads, protocol types, common infrastructure) must live in a `lib/` crate so the contract is enforced at compile time, not by convention. If two components independently define the same type, extract it.
- Follow the conventions established in sibling components. Consistency takes priority over local preference.
- Prefer library-provided functions over hand-rolled logic for serialisation, encoding, etc.

### Code Clarity

- Names (functions, variables, types) must be descriptive enough to make their purpose obvious without a comment. Prefer renaming or restructuring over adding an explanatory comment.
- Doc-comments on public functions and types are encouraged — they improve IDE tooling and serve as the API contract.
- Inline comments are reserved for cases where the code's *current structure* cannot convey the reasoning — e.g. a non-obvious ordering constraint or a subtlety that naming alone cannot capture.
- Comments must not duplicate information that belongs elsewhere. Architectural decisions belong in `docs/architecture.md`, behavioural contracts belong in component READMEs, and historical context belongs in version control. Code comments are not a distributed changelog or a substitute for documentation.
- If a comment explains *what* the code does rather than *why* it does it that way, the code should be refactored until the comment is unnecessary.

### Single Responsibility Principle

- Code must be well composed, with clear responsibilities for each component. This applies both in terms of subject matter (separate components for separate concerns) and in terms of clients (how something is done) and orchestrators (when something is done).
- Responsibility boundaries must be structural — enforced by distinct types or modules — not cosmetic.

### External Dependency Ownership

All interaction with an external system (database, message broker, HTTP service) must be encapsulated in a single module behind an exported interface. Other modules depend on the interface, never on the external system directly. This ensures that consumers can be tested with fakes and that external-system concerns live in one place.

## Security

### Dependency Management

The npm ecosystem has a significant supply chain attack surface. Every new package must be vetted before it is added to the project.

- **Never** add a package by editing `package.json` directly or running `npm install <pkg>` / `yarn add <pkg>`.
- **Always** install new packages through [npq](https://github.com/lirantal/npq), which audits each package against CVE databases, checks package age, download count, maintainer integrity, pre/post install scripts, and more before handing off to npm:
  ```sh
  npq install <package>
  ```
- This applies to both direct and development dependencies.
- AI agents must not silently add packages. They must instruct the human to run `npq install <package>` and wait for approval before a dependency appears in `package.json`.
