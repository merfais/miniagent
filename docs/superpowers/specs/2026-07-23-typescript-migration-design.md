# MiniAgent TypeScript Migration Design

**Date:** 2026-07-23

## Goal

Convert the entire MiniAgent codebase from JavaScript to TypeScript, switch the project to ESM, keep the CLI and public module surface usable, and support both direct source execution and compiled execution with direct execution as the default developer workflow.

## Confirmed Decisions

- Source files under `src/` and tests under `test/` will all migrate from `.js` to `.ts`.
- The repository will switch from CommonJS to ESM.
- TypeScript will run with `strict` mode enabled.
- The repository must support both:
  - direct execution from TypeScript sources for day-to-day development and testing,
  - compiled execution from `dist/` for packaged and post-build validation.
- Direct execution is the primary workflow.
- The CLI must remain usable.
- Public exports currently exposed from `src/index.js` must remain available as ESM exports after migration.
- Backward compatibility for external CommonJS consumers is out of scope.

## Current State

The repository is currently a small Node.js CLI project with these characteristics:

- `package.json` uses `"type": "commonjs"`.
- `main`, `bin`, and `start` point directly at `src/index.js`.
- Tests use Node's built-in `node:test` runner and import JavaScript source files directly.
- Runtime modules exchange loose object shapes for messages, tool calls, provider responses, session records, and logger events.
- No TypeScript configuration or build output exists today.

## Design Summary

The migration will turn the repository into a single ESM TypeScript codebase with one source of truth: TypeScript under `src/` and `test/`.

Development and local verification will run directly against `.ts` files. Build output in `dist/` will exist as a supported secondary surface for packaging, compiled-runtime validation, and public ESM imports.

The migration intentionally avoids dual-module complexity. We will not maintain parallel CommonJS and ESM outputs. Instead, we will standardize on ESM everywhere and use the build output as the published runtime surface.

## Non-Goals

This migration does not include:

- preserving CommonJS `require()` compatibility for external consumers,
- changing feature behavior unrelated to the module/runtime transition,
- redesigning session persistence data formats,
- introducing a new test framework,
- adding a bundler,
- broad refactoring of module boundaries beyond what the TypeScript migration requires.

## Repository Shape After Migration

The high-level repository shape will become:

```text
src/
  agent/
  cli/
  core/
  providers/
  tools/
  index.ts
test/
  ...
tsconfig.json
package.json
dist/
  src/
  test/
```

Key rules:

- TypeScript source remains under `src/` and tests remain under `test/`.
- `dist/` mirrors the source layout closely enough that compiled validation is easy to understand.
- The project will not mix `.js` and `.ts` source files after the migration is complete.

## Module System

The project will switch to Node ESM:

- `package.json` will use `"type": "module"`.
- TypeScript will use Node-native ESM semantics via `module: "NodeNext"` and `moduleResolution: "NodeNext"`.
- Relative imports inside `.ts` source files will use explicit `.js` suffixes so emitted JavaScript runs correctly under Node ESM.

Example:

```ts
import { startCli } from './cli/chat-cli.js';
```

This is a deliberate trade-off. It keeps source imports aligned with emitted runtime imports and avoids hidden resolution behavior.

## Execution Model

### 1. Direct TypeScript Execution

This is the default developer workflow.

Use direct execution for:

- local development,
- ad-hoc CLI runs,
- local test runs,
- quick validation while iterating.

This surface will run the `.ts` files directly through a TypeScript-capable runtime such as `tsx`.

### 2. Compiled Execution

This is the secondary runtime surface.

Use compiled execution for:

- verifying the emitted package shape,
- validating that `tsc` output is runnable,
- backing the published CLI entrypoint,
- backing public ESM imports from the built package.

This surface will run emitted files from `dist/` using Node directly.

## Package and Script Design

The package will expose both development-time and build-time workflows.

### Development-Oriented Scripts

- `npm run dev`: run the CLI from `src/index.ts`
- `npm start`: same default direct-run path as development
- `npm test`: run TypeScript tests directly
- `npm run typecheck`: run TypeScript static checking without emitting

### Build-Oriented Scripts

- `npm run build`: compile TypeScript into `dist/`
- `npm run start:dist`: run the compiled CLI from `dist/src/index.js`
- `npm run test:dist`: run compiled tests from `dist/test/`

The exact command spellings may be finalized during implementation, but the workflow split above is part of the design and must be preserved.

## CLI and Public Export Surface

### CLI

- The source entrypoint remains the conceptual root at `src/index.ts`.
- The installed package `bin` will point to the compiled file in `dist/`, not to a direct TypeScript entrypoint.
- The source file will keep its shebang so the compiled CLI remains executable.

This keeps installation simple while still allowing repository-local direct execution in development.

### Module Exports

The package root will expose ESM imports backed by the compiled output.

At minimum:

- the package root export resolves to the compiled `dist/src/index.js`,
- the package root types resolve to the emitted declaration for that same entrypoint,
- the public functions currently exported from `src/index.js` stay available after the migration.

The design goal is continuity of the ESM API surface, not continuity of old CommonJS loading behavior.

## Type Strategy

The migration is not just a file-extension rename. It will formalize the main runtime contracts that already exist across modules.

### Shared Type Boundaries

The implementation should introduce a small shared type layer for the main cross-module contracts, such as:

- message objects,
- tool definitions and tool traces,
- provider actions and provider responses,
- logger interfaces,
- session store return values and persisted record shapes.

This type layer should stay thin and practical. It exists to document and constrain existing behavior, not to build a framework.

### Message Types

Messages should become a discriminated union around roles:

- `system`
- `user`
- `assistant`
- `tool`

Tool messages must explicitly model `toolName` and `callId` instead of relying on loosely shaped extras.

### Provider Action Types

Provider actions should become a discriminated union, at least for:

- `tool_call`
- `assistant_message`
- `final_answer`

This will make `AgentRuntime.respond()` more explicit and reduce unchecked property access.

### Tool Registry Types

The tool system is intentionally dynamic. The migration should keep the runtime registration model and schema validation model intact.

For that reason, tool execution boundaries should stay moderate in typing complexity:

- tool args may remain `Record<string, unknown>`,
- tool results may remain `unknown`,
- registry methods should be strongly typed enough to prevent invalid registrations,
- the migration should not introduce per-tool compile-time generic plumbing across the entire runtime.

This keeps the migration proportionate to the current architecture.

### Persisted Record Types

The JSONL-backed session files should get explicit TypeScript record types that match the existing on-disk format:

- session message entries,
- history records,
- pending compression records,
- artifact references.

The migration must preserve current storage semantics and error behavior. Types document the contract; they do not redefine the file format.

### Unknown External Data

The project reads several kinds of untrusted or external data:

- provider HTTP responses,
- config file JSON,
- session JSONL records from disk,
- tool results serialized to disk.

These inputs must not be trusted purely because TypeScript types exist. The migration should use `unknown` at the boundary and narrow values through the same runtime checks the code already relies on, expanding those checks where TypeScript reveals gaps.

## Configuration Design

The repository will gain a TypeScript configuration with these design goals:

- strict type checking,
- declaration emit for public ESM imports,
- source maps for easier debugging,
- output under `dist/`,
- no JavaScript source fallback.

The implementation may use a single `tsconfig.json` or a small `tsconfig` family if needed for build vs. no-emit checking, but the observable design requirements above must hold.

## Testing Strategy

Testing must validate both supported execution surfaces.

### Baseline

Before migration work begins, run the current test suite to establish the JavaScript baseline.

### After Migration

The migration is only complete when all of the following pass:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `npm run test:dist`

### CLI Validation

Validate both entry modes:

- direct source execution path,
- compiled execution path.

If the CLI currently has no stable help command, use an existing startup path such as the missing-config or missing-env failure mode and verify that both entry modes behave consistently.

### Module Export Validation

Validate the built public surface by importing the compiled entrypoint and confirming the expected named exports are present.

Also validate source-side imports in TypeScript tests where useful so that internal development usage remains ergonomic.

## Error Handling Expectations

The migration must preserve current error semantics unless the TypeScript change requires a correction for soundness.

In particular:

- existing startup failures should still surface clearly,
- logger failures must remain non-fatal to the primary error path,
- session persistence invariants must remain enforced,
- unsafe shell command rejection must remain behaviorally unchanged.

## Files Expected to Change

The migration is expected to touch these categories of files:

- `package.json`
- one or more `tsconfig` files
- every source file under `src/`
- every test file under `test/`
- `README.md`
- ignore rules if the new toolchain introduces new generated artifacts

The migration should not treat runtime-generated workspace artifacts such as `sessions/`, `log/`, or `session-history.json` as part of the feature work.

## Success Criteria

The migration is successful when all of the following are true:

- there are no remaining JavaScript source or test files in `src/` or `test/`,
- the repository runs as an ESM TypeScript project,
- strict type checking passes,
- local development and tests can run directly from TypeScript sources,
- compiled output in `dist/` can also run correctly,
- the CLI still works,
- public ESM exports remain available,
- existing behavior remains intact apart from the intentional module/runtime transition.
