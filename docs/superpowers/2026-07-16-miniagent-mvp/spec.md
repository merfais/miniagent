# MiniAgent MVP Specification

**Date:** 2026-07-16

## Goal

Build a minimal coding agent that runs in a terminal UI, can converse with the user to clarify requirements, can optionally produce `spec` / `plan` / `handoff` content in the chat, and can read, modify, and validate local code with tool use.

## Product Definition

The product is a prompt-driven coding agent, not a workflow engine.

The agent decides from prompt and conversation context whether it should:

- ask clarifying questions,
- answer directly,
- generate lightweight `spec` / `plan` / `handoff` text in chat,
- call local tools to inspect or modify code,
- call web search when the task needs public information,
- run verification commands before reporting completion.

The first version is a single-process terminal application with a modular internal structure.

## User Scenarios

### Scenario 1: Clarify and answer

User describes an ambiguous requirement. The agent asks one or more clarifying questions and then provides a grounded answer or implementation proposal.

### Scenario 2: Clarify and produce planning text

User asks for a feature but wants a `spec`, `plan`, or `handoff` first. The agent produces the requested text in the conversation without forcing a fixed workflow engine.

### Scenario 3: Inspect and modify local code

User asks for a feature or code change. The agent reads relevant files, decides what to change, writes updates to local files, and explains the result.

### Scenario 4: Use public information

User asks for a task that depends on external public knowledge, such as library usage or API details. The agent uses web search, incorporates the result, and continues the task.

### Scenario 5: Validate before claiming completion

After making code changes, the agent runs relevant local commands such as tests, build, or lint when available, and reports the observed result instead of assuming success.

## Non-Goals

The MVP explicitly does not include:

- workflow definitions or a workflow DSL,
- multi-agent orchestration,
- persistent long-term memory,
- GUI or browser app,
- provider failover or routing,
- advanced permission approval system,
- sandboxing beyond basic command guardrails,
- plugin marketplace or dynamic tool installation,
- streaming token-by-token rendering,
- complex patch planning across parallel branches.

## Architecture

The system is a single Node.js process with the following internal modules:

- `cli`: terminal interaction loop and display rendering,
- `agent`: one-turn decision loop,
- `providers`: model provider adapters, with OpenAI-compatible Ark first,
- `tools`: local tools for file, shell, and web search,
- `core`: shared types, message model, session state, and tool contracts.

The agent loop is iterative rather than workflow-based:

1. collect current messages and tool schemas,
2. send them to the LLM provider,
3. parse the model output into an internal action,
4. execute a tool if requested,
5. append tool result to the conversation,
6. continue until the model returns a final answer.

## Core Requirements

### 1. Terminal UI

The CLI must:

- accept multiline or single-line user input,
- display assistant replies,
- display when a tool is being called,
- continue as a multi-turn conversation in one session,
- allow the user to exit cleanly.

The MVP does not need a rich ncurses-style layout. A simple readline-based terminal chat loop is sufficient.

### 2. Conversation-Driven Agent Behavior

The agent must support three categories of model behavior:

- ask for clarification,
- call a tool,
- provide a final answer.

The decision of whether to clarify is made by the model based on prompt and context, not by a fixed workflow state machine.

### 3. Spec / Plan / Handoff Output

When the user asks for `spec`, `plan`, or `handoff`, the agent should produce the content directly in chat by default.

The MVP must not force these artifacts to be saved to files automatically. File output can be added later.

### 4. Local Code Operations

The agent must be able to:

- read files,
- list files,
- search code by keyword,
- write or overwrite files,
- apply targeted edits through a patch-like write path,
- run local commands for validation.

The agent should normally inspect relevant files before modifying them.

### 5. Web Search

The agent must support a web search tool that can return public search results for open-ended tasks.

The MVP does not need web page browsing or full page scraping beyond search results plus optional page fetch in a minimal form.

### 6. OpenAI-compatible Provider

The first provider must support OpenAI-compatible Ark API Key usage.

The provider layer must be abstracted so that future OpenAI-compatible providers can be added without changing the agent runtime contract.

The initial implementation may use the OpenAI-compatible `chat/completions` format and configurable base URL / model.

### 7. Session State

The application must keep in-memory session state for:

- message history,
- tool call history,
- current model configuration,
- recent tool outputs needed for the next step.

Persistent cross-session storage is out of scope.

## Guardrails

These are light guardrails, not a workflow engine:

- dangerous shell commands must be rejected,
- tool calls must be validated against registered tool schemas,
- file writes should stay inside the current workspace root,
- the agent should prefer reading before writing,
- the agent should prefer verification commands before claiming completion.

## Prompting Strategy

The system prompt should instruct the model to:

- act as a coding agent,
- ask clarifying questions when requirements are ambiguous,
- generate `spec` / `plan` / `handoff` text directly in chat when requested,
- use tools when information or file changes are needed,
- avoid fabricating file state or command results,
- verify changes when possible before claiming success.

The prompt should not encode a fixed workflow.

## Tool Surface

The MVP tool set must include:

- `read_file(path)`,
- `list_files(path?)`,
- `search_code(query, path?)`,
- `write_file(path, content)`,
- `run_command(cmd, cwd?)`,
- `web_search(query)`.

Optional internal helper tools can exist if they do not change the user-facing architecture.

## Data Contracts

The runtime should normalize provider outputs into one internal action union:

- `assistant_message`,
- `tool_call`,
- `final_answer`.

Messages should also use one normalized internal structure so the provider adapter can map them to provider-specific payloads.

## Error Handling

The MVP must handle:

- missing provider API key,
- unknown tool names,
- invalid tool arguments,
- file read/write errors,
- shell execution failures,
- web search failures,
- malformed provider responses.

Errors should be shown to the user in clear text and should remain part of the session context where useful.

## Testing Strategy

The MVP should include automated tests for:

- action parsing,
- tool registry and dispatch,
- command guardrails,
- file tool behavior,
- OpenAI-compatible provider request shaping and response parsing,
- basic agent loop behavior with a mocked provider.

The project should also include one or more integration-style CLI tests or smoke tests where practical.

## Success Criteria

The MVP is successful if it can demonstrate the following in the terminal:

1. receive a user request,
2. ask a clarifying question when the request is ambiguous,
3. produce `spec` or `plan` text in chat when requested,
4. inspect local files,
5. modify local code,
6. run a validation command,
7. use web search when asked for public information,
8. return a grounded final answer summarizing what it did.

