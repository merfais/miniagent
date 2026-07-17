# Review Checklist — Logging and Trace

> This document is generated automatically by the `writing-review-checklist` skill and serves as the review basis for `spec-compliance-review`.
> Based on: `spec.md` (2026-07-17) / `plan.md` (2026-07-17)
> Coverage: full main task

---

## Functional Completeness

| # | Checklist Item | Source | Verification Method |
|---|---|---|---|
| F1 | MiniAgent writes a structured session log file to disk for every CLI session without requiring a logging opt-in flag. | spec Goal / spec Scenario 1 | Start the CLI and confirm a session log file is created |
| F2 | Enabling `logToCli: true` mirrors the same logging events to the terminal while still preserving file output. | spec Scenario 2 / spec Configuration | Run the CLI with `logToCli: true` and inspect both terminal output and the log file |
| F3 | Each CLI process uses one randomly generated short `sessionId` and writes all session events into one isolated file. | spec Scenario 3 / spec Log Storage Layout | Inspect the logger implementation and confirm all entries in one run share the same `sessionId` and file |
| F4 | Setting `logDir` changes the base log directory while keeping the `{YYYY-MM-DD}/{sessionId}.log` suffix layout. | spec Scenario 4 / spec Log Storage Layout | Configure a custom `logDir`, run the CLI, and inspect the resulting path |
| F5 | The logger emits startup, runtime, provider, tool, assistant-final, and fatal-error events needed to reconstruct a session chain. | spec Product Definition / spec Event Model | Inspect emitted events in file output and targeted tests |

## File Structure

| # | Expected File/Directory | Source |
|---|---|---|
| D1 | `src/core/logger.js` | plan File Structure / plan Task 1 |
| D2 | `test/core/logger.test.js` | plan File Structure / plan Task 1 |
| D3 | `src/index.js` contains startup logger creation and logging-config normalization changes | plan File Structure / plan Task 2 |
| D4 | `src/cli/chat-cli.js` contains session lifecycle logging changes | plan File Structure / plan Task 3 |
| D5 | `src/agent/runtime.js` contains runtime/provider/tool/final logging changes | plan File Structure / plan Task 3 |
| D6 | `test/index.test.js` contains startup/config logging coverage | plan File Structure / plan Task 2 |
| D7 | `test/cli/chat-cli.test.js` contains session lifecycle logging coverage | plan File Structure / plan Task 3 |
| D8 | `test/agent/runtime.test.js` contains runtime event and error-path coverage | plan File Structure / plan Task 3 / Task 4 |
| D9 | `miniagent.config.example.json` documents `logDir` and `logToCli` | plan File Structure / plan Task 2 / Task 4 |
| D10 | `README.md` documents default log layout and CLI mirroring behavior | plan File Structure / plan Task 2 / Task 4 |

## Interface Conformance

| # | Interface/Type Definition | Expected Signature | Source |
|---|---|---|---|
| I1 | `createSessionId` | `() => string` | plan Task 1 Step 3 |
| I2 | `resolveLogFilePath` | `({ workspaceRoot, logDir, sessionId, now }) => string` | plan Task 1 Step 3 |
| I3 | `createSessionLogger` | `({ workspaceRoot, sessionId, logDir, logToCli, cliWriter, now }) => { sessionId, filePath, log(event) }` | plan Task 1 Step 3 |
| I4 | `normalizeLoggingConfig` | `(config = {}) => { logToCli: boolean, logDir: string }` | plan Task 2 Step 3 / plan Task 4 Step 3 |
| I5 | `createAppContextFromConfig` | `({ cwd, config, env, output } = {}) => Promise<{ config, logger, provider, sessionId }>` | plan Task 2 Step 3 |
| I6 | `createRuntime` | `({ provider, tools, logger }) => AgentRuntime` | plan Task 3 Step 3 |
| I7 | `AgentRuntime` constructor | `new AgentRuntime({ provider, tools, logger, maxSteps })` | plan Task 3 Step 3 |
| I8 | `logEvent` helper | `(logger, entry) => Promise<void>` | plan Task 3 Step 3 |

## Behavioral Correctness

| # | Behavior Description | Expected Outcome | Source | Verification Method |
|---|---|---|---|---|
| B1 | Default log path resolution | A relative or missing `logDir` resolves to `workspaceRoot/logs/{YYYY-MM-DD}/{sessionId}.log` | spec Log Storage Layout / plan Task 1 Step 1 | Logger unit test |
| B2 | Absolute/custom `logDir` handling | A configured `logDir` changes only the base path and preserves date/session suffixes | spec Configuration / spec Log Storage Layout / plan Task 1 Step 1 | Logger unit test and startup integration test |
| B3 | File output format | Each log entry is written as one JSON object per line with `timestamp`, `sessionId`, and `event` fields | spec Event Model / plan Task 1 Step 3 | Read the generated file and parse entries |
| B4 | CLI mirror rendering | When `logToCli` is true, the logger renders a compact `[log] ...` line for each logged event | spec CLI Rendering / plan Task 1 Step 1 | Logger unit test and CLI test |
| B5 | Session lifecycle logging | `session.start` is logged on CLI startup and `session.end` is logged when the loop closes | spec Data Flow / plan Task 3 Step 1 | CLI test |
| B6 | Runtime step logging | Each runtime loop logs `runtime.step.start`, and successful tool-step completion logs `runtime.step.end` | spec Event Model / plan Task 3 Step 1 | Runtime test |
| B7 | Provider logging | Every provider invocation logs `provider.generate.start`, `provider.generate.end`, or `provider.generate.error` around the existing call | spec Event Model / plan Task 3 Step 3 | Runtime test for success and error branches |
| B8 | Tool logging | A tool call logs `tool.call.start` before execution and `tool.call.end` after success | spec Event Model / plan Task 3 Step 3 | Runtime tool-call test |
| B9 | Tool error logging | A failing tool logs `tool.call.error` with the error message before the error is re-thrown | spec Error Handling / plan Task 4 Step 1 | Runtime error-path test |
| B10 | Final answer logging | A final assistant response logs `assistant.final` before the response is returned | spec Event Model / plan Task 3 Step 3 | Runtime final-answer test |
| B11 | Fatal process logging | A startup or top-level execution failure logs `process.error` before surfacing the error to the user | spec Event Model / spec Error Handling / plan Task 2 Step 3 | Startup integration test or controlled failure test |
| B12 | Invalid logging config fallback | Non-boolean `logToCli` and non-string or blank `logDir` values fall back to `false` and `logs` respectively | spec Error Handling / plan Task 4 Step 1 | Startup/config test |

## Test Coverage

| # | Expected Test | Covered Scenario | Source |
|---|---|---|---|
| T1 | `test/core/logger.test.js` verifies default log path resolution | Default `logs/{date}/{sessionId}.log` path | plan Task 1 Step 1 / spec Testing Strategy |
| T2 | `test/core/logger.test.js` verifies JSON Lines file writing | File logging is always enabled | plan Task 1 Step 1 / spec Testing Strategy |
| T3 | `test/core/logger.test.js` verifies CLI mirroring when `logToCli` is enabled | CLI mirror sink behavior | plan Task 1 Step 1 / spec Testing Strategy |
| T4 | `test/core/logger.test.js` verifies `createSessionId` shape | Short random session ID generation | plan Task 1 Step 1 / spec Log Storage Layout |
| T5 | `test/index.test.js` verifies `loadConfig` preserves logging fields | Config file reading for `logToCli` and `logDir` | plan Task 2 Step 1 |
| T6 | `test/index.test.js` verifies `createAppContextFromConfig` builds a logger per startup | Session logger creation and default path usage | plan Task 2 Step 1 |
| T7 | `test/agent/runtime.test.js` verifies provider/tool/final runtime events | Happy-path runtime trace behavior | plan Task 3 Step 1 |
| T8 | `test/cli/chat-cli.test.js` verifies `session.start` and `session.end` | Session lifecycle events | plan Task 3 Step 1 |
| T9 | `test/agent/runtime.test.js` verifies `tool.call.error` logging | Tool failure trace behavior | plan Task 4 Step 1 |
| T10 | `test/index.test.js` verifies invalid logging config fallback | Logging-config normalization defaults | plan Task 4 Step 1 |
| T11 | `npm test` passes after the feature is complete | Full regression coverage for the repo | plan Task 4 Step 4 / spec Success Criteria |

## Constraint Adherence

| # | Constraint Description | Type | Source |
|---|---|---|---|
| C1 | Logging to file remains enabled even when `logToCli` is unset or false. | MUST | spec Configuration |
| C2 | `logToCli: true` adds CLI output and does not replace file output. | MUST | spec Configuration / spec CLI Rendering |
| C3 | The logger uses the fixed date-directory plus session-file layout and does not allow bypassing it with a fully custom file path. | MUST | spec Log Storage Layout / spec Non-Goals |
| C4 | The first version logs only execution-chain events and does not log full prompt bodies, file contents, or full model responses by default. | MUST NOT | spec Product Definition / spec Non-Goals |
| C5 | Existing `[tool] ...` CLI status lines remain unchanged. | MUST | spec CLI Rendering |
| C6 | Logging changes are centralized in a dedicated logger module rather than scattered raw `console.log` statements. | MUST | spec Architecture |
| C7 | Logging failures and runtime/provider/tool exceptions surface clearly instead of being silently swallowed. | MUST | spec Error Handling |

## Out-of-Scope Guard

| # | Non-goal Item | Source |
|---|---|---|
| X1 | Log rotation or retention cleanup is not added in this feature. | spec Non-Goals |
| X2 | Configurable log levels are not added in this feature. | spec Non-Goals |
| X3 | Remote log shipping is not added in this feature. | spec Non-Goals |
| X4 | Full prompt bodies and full model responses are not logged by default. | spec Non-Goals |
| X5 | A generic metrics system is not introduced. | spec Non-Goals |
| X6 | CLI commands or UI for browsing historical logs are not introduced. | spec Non-Goals |
| X7 | Configurable full file paths that bypass the day/session layout are not introduced. | spec Non-Goals |

---

**Totals:** 50 checklist items in total (functional 5 / file 10 / interface 8 / behavior 12 / test 11 / constraint 7 / out-of-scope 7)
