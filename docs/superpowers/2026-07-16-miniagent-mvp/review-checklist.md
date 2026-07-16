# Review Checklist — MiniAgent MVP

> This document is generated automatically by the `writing-review-checklist` workflow and serves as the review basis for `spec-compliance-review`.
> Based on: `spec.md` (2026-07-16) / `plan.md` (2026-07-16)
> Coverage: full main task

---

## Functional Completeness

| # | Checklist Item | Source | Verification Method |
|---|---|---|---|
| F1 | The application runs as a terminal-based chat agent rather than a workflow engine | spec Product Definition | Start the CLI and inspect runtime behavior |
| F2 | The agent can ask clarifying questions in chat when the model chooses to do so | spec Conversation-Driven Agent Behavior | Mock provider response and inspect assistant output |
| F3 | The agent can produce `spec`, `plan`, or `handoff` text directly in chat without forcing file output | spec Spec / Plan / Handoff Output | Prompt the agent for planning text and inspect response |
| F4 | The agent can read local files through a registered file tool | spec Local Code Operations | Execute `read_file` in tests or via runtime trace |
| F5 | The agent can list files inside the workspace | spec Local Code Operations | Execute `list_files` and inspect returned entries |
| F6 | The agent can search code by keyword inside the workspace | spec Local Code Operations | Execute `search_code` and verify hits |
| F7 | The agent can write local files inside the workspace | spec Local Code Operations | Execute `write_file` and verify file content changed |
| F8 | The agent can run local validation commands through a shell tool | spec Local Code Operations | Execute `run_command` and inspect exit code/stdout |
| F9 | The agent can perform web search for open-ended tasks | spec Web Search | Execute `web_search` and inspect normalized results |
| F10 | The first provider supports OpenAI-compatible Ark API Key based requests | spec OpenAI-compatible Provider | Inspect provider config and request headers |
| F11 | Session state keeps in-memory message history for multi-turn conversation | spec Session State | Inspect runtime state across at least two turns |
| F12 | Session state preserves tool outputs that are needed by subsequent model calls | spec Session State | Inspect runtime messages after a tool call |
| F13 | The agent returns a grounded final answer after completing tool use | spec Success Criteria | Run a tool-call scenario and inspect final response |

## File Structure

| # | Expected File/Directory | Source |
|---|---|---|
| D1 | `docs/superpowers/2026-07-16-miniagent-mvp/spec.md` | plan workflow artifact |
| D2 | `docs/superpowers/2026-07-16-miniagent-mvp/plan.md` | plan workflow artifact |
| D3 | `docs/superpowers/2026-07-16-miniagent-mvp/review-checklist.md` | plan workflow artifact |
| D4 | `src/core/messages.js` | plan Task 1 |
| D5 | `src/core/tool-registry.js` | plan Task 1 |
| D6 | `src/core/workspace.js` | plan Task 1 / Task 2 |
| D7 | `src/tools/file-tools.js` | plan Task 2 |
| D8 | `src/tools/shell-tool.js` | plan Task 2 |
| D9 | `src/tools/web-search-tool.js` | plan Task 3 |
| D10 | `src/providers/openai-compatible.js` | plan Task 3 |
| D11 | `src/providers/openai-compatible.js` | plan Task 3 |
| D12 | `src/agent/system-prompt.js` | plan Task 4 |
| D13 | `src/agent/runtime.js` | plan Task 4 |
| D14 | `src/cli/chat-cli.js` | plan Task 5 |
| D15 | `src/index.js` | plan Task 5 |
| D16 | `test/core/tool-registry.test.js` | plan Task 1 |
| D17 | `test/tools/file-tools.test.js` | plan Task 2 |
| D18 | `test/tools/shell-tool.test.js` | plan Task 2 |
| D19 | `test/tools/web-search-tool.test.js` | plan Task 3 |
| D20 | `test/providers/openai-compatible.test.js` | plan Task 3 |
| D21 | `test/agent/runtime.test.js` | plan Task 4 |
| D22 | `test/cli/chat-cli.test.js` | plan Task 5 |

## Interface Conformance

| # | Interface/Type Definition | Expected Signature | Source |
|---|---|---|---|
| I1 | `ToolRegistry.register` | `(tool: { name: string, description: string, inputSchema: object, execute: Function }) => void` | plan Task 1 |
| I2 | `ToolRegistry.get` | `(name: string) => object \| undefined` | plan Task 1 |
| I3 | `ToolRegistry.list` | `() => object[]` | plan Task 1 |
| I4 | `createMessage` | `(role: string, content: string, extras?: object) => object` | plan Task 1 |
| I5 | `createToolMessage` | `(toolName: string, content: string, callId: string) => object` | plan Task 1 |
| I6 | `createFileTools` | `({ workspaceRoot: string }) => { read_file, write_file, list_files, search_code }` | spec Tool Surface / plan Task 2 |
| I7 | `createShellTool` | `({ workspaceRoot: string }) => { run_command }` | plan Task 2 |
| I8 | `createWebSearchTool` | `({ fetchImpl?: Function }) => { web_search }` | plan Task 3 |
| I9 | `OpenAiCompatibleProvider.generate` | `({ messages: object[], tools: object[] }) => Promise<AgentAction>` | plan Task 3 |
| I10 | `OpenAiCompatibleProvider` | `extends OpenAiCompatibleProvider` | plan Task 3 |
| I11 | `AgentRuntime.respond` | `(messages: object[]) => Promise<{ output: object, trace: object[], messages: object[] }>` | plan Task 4 |
| I12 | `renderToolCall` | `({ toolName: string, args: object }) => string` | plan Task 5 |
| I13 | `startCli` | `(deps?: object) => Promise<void>` | plan Task 5 |

## Behavioral Correctness

| # | Behavior Description | Expected Outcome | Source | Verification Method |
|---|---|---|---|---|
| B1 | Registering two tools with the same name | The second registration throws an error | spec Guardrails / plan Task 1 | Unit test assertion |
| B2 | Reading a file with a path outside the workspace root | The request is rejected with a workspace-boundary error | spec Guardrails / plan Task 2 | Unit test assertion |
| B3 | Writing a file inside a missing nested directory | The parent directory is created and the file is written | spec Local Code Operations / plan Task 2 | Unit test plus file existence check |
| B4 | Running a dangerous shell command such as `rm -rf /` | The shell tool rejects the request before execution | spec Guardrails / plan Task 2 | Unit test assertion |
| B5 | Web search returns provider-specific result shape | The tool normalizes results into a stable result list | spec Web Search / plan Task 3 | Unit test assertion |
| B6 | Provider receives a tool call response from the model | The provider returns a normalized internal `tool_call` action | spec Data Contracts / plan Task 3 | Unit test assertion |
| B7 | Provider receives plain assistant text from the model | The provider returns `assistant_message` or `final_answer` with content | spec Data Contracts | Unit test or fixture-based assertion |
| B8 | Runtime receives a `tool_call` action | It executes the named tool, stores the trace, and appends a tool message | spec Architecture / plan Task 4 | Unit test assertion |
| B9 | Runtime receives a `final_answer` action | It stops looping and returns the final result | spec Architecture / plan Task 4 | Unit test assertion |
| B10 | Runtime exceeds its maximum allowed steps | It throws a bounded-loop error instead of hanging forever | spec Error Handling | Unit test assertion |
| B11 | CLI renders a tool invocation status line | The rendered text includes the tool name and arguments | spec Terminal UI / plan Task 5 | Unit test assertion |
| B12 | User exits the CLI with `:quit` or EOF | The process stops cleanly without an uncaught exception | spec Terminal UI | Manual smoke test |
| B13 | Agent finishes a code task after validation | Final answer summarizes what was changed and what verification ran | spec Success Criteria | End-to-end smoke test |

## Test Coverage

| # | Expected Test | Covered Scenario | Source |
|---|---|---|---|
| T1 | `test/core/tool-registry.test.js` | Duplicate registration rejection and list behavior | plan Task 1 |
| T2 | `test/tools/file-tools.test.js` | Workspace-safe file reads and writes | plan Task 2 |
| T3 | `test/tools/shell-tool.test.js` | Dangerous command rejection | plan Task 2 |
| T4 | `test/tools/web-search-tool.test.js` | Web result normalization | plan Task 3 |
| T5 | `test/providers/openai-compatible.test.js` | OpenAI-compatible request mapping and tool-call parsing | plan Task 3 |
| T6 | `test/agent/runtime.test.js` | Tool execution loop and final answer return | plan Task 4 |
| T7 | `test/cli/chat-cli.test.js` | CLI tool status rendering | plan Task 5 |
| T8 | `npm test` | Full suite passes with all modules wired together | spec Testing Strategy / plan Task 5 |

## Constraint Adherence

| # | Constraint Description | Type | Source |
|---|---|---|---|
| C1 | The product must remain a prompt-driven coding agent and not a workflow engine | MUST | spec Product Definition |
| C2 | The CLI may be simple readline-based text UI; a rich ncurses UI is not required | MUST | spec Terminal UI |
| C3 | The decision to clarify must come from the model and prompt, not a fixed workflow state machine | MUST | spec Conversation-Driven Agent Behavior |
| C4 | `spec` / `plan` / `handoff` output must default to chat output rather than automatic file persistence | MUST | spec Spec / Plan / Handoff Output |
| C5 | File writes must stay inside the current workspace root | MUST | spec Guardrails |
| C6 | Dangerous shell commands must be rejected | MUST | spec Guardrails |
| C7 | Tool invocations must be checked against registered tool schemas or registry entries | MUST | spec Guardrails |
| C8 | The provider layer must stay abstract so future OpenAI-compatible providers can be added without changing runtime contracts | MUST | spec OpenAI-compatible Provider |
| C9 | Session state persistence across process restarts must not be required in the MVP | MUST NOT | spec Session State |
| C10 | The prompt must not encode a fixed workflow | MUST NOT | spec Prompting Strategy |

## Out-of-Scope Guard

| # | Non-goal Item | Source |
|---|---|---|
| X1 | Workflow definitions or a workflow DSL are implemented | spec Non-Goals |
| X2 | Multi-agent orchestration is implemented | spec Non-Goals |
| X3 | Persistent long-term memory is implemented | spec Non-Goals |
| X4 | GUI or browser app is implemented | spec Non-Goals |
| X5 | Provider failover or routing is implemented | spec Non-Goals |
| X6 | Advanced approval system or sandbox manager is implemented | spec Non-Goals |
| X7 | Plugin marketplace or dynamic tool installation is implemented | spec Non-Goals |
| X8 | Streaming token-by-token rendering is implemented | spec Non-Goals |

---

**Totals:** 64 checklist items in total (functional 13 / file 22 / interface 13 / behavior 13 / test 8 / constraint 10 / out-of-scope 8)

