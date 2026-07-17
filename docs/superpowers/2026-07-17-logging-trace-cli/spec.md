# MiniAgent Logging and Trace Specification

**Date:** 2026-07-17

## Goal

Add session-scoped logging and trace visibility to MiniAgent so that every CLI session writes structured logs to disk by default and can optionally mirror those logs to the terminal through configuration.

## Product Definition

The logging feature is an internal observability layer for the existing CLI agent loop.

It must help developers answer these questions for a single session:

- when the session started and ended,
- which runtime step is running,
- when the provider was called,
- when a tool call started, succeeded, or failed,
- when a final answer was produced,
- whether the process ended with an error.

The first version is intentionally narrow. It focuses on traceability of the execution chain rather than full debug dumps of prompts, responses, or file contents.

## User Scenarios

### Scenario 1: Default local trace file

A developer runs MiniAgent without special logging flags. The session automatically writes structured events to a log file under a day-based directory so the session can be inspected later.

### Scenario 2: Mirror logs to the terminal

A developer enables `logToCli: true` in `miniagent.config.json`. The same structured events are still written to disk and are also rendered into short readable lines in the CLI during the session.

### Scenario 3: Separate sessions cleanly

A developer opens MiniAgent multiple times in the same day. Each session writes to its own file, isolated by a random short `sessionId`, so traces do not mix together.

### Scenario 4: Store logs outside the default directory

A developer customizes the base log directory with `logDir`. MiniAgent keeps the same date-directory and session-file convention while writing under the configured base path.

## Non-Goals

This feature does not include:

- log rotation or retention cleanup,
- configurable log levels,
- remote log shipping,
- logging full prompt bodies or full model responses by default,
- a general metrics system,
- user-facing commands for browsing historical logs,
- configurable full file paths that bypass the day/session layout.

## Configuration

MiniAgent must support these top-level config fields in `miniagent.config.json`:

```json
{
  "logToCli": true,
  "logDir": "logs",
  "provider": {
    "type": "openai-compatible",
    "model": "your_model_id",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your_api_key"
  }
}
```

Semantics:

- `logToCli` is optional and defaults to `false`.
- `logDir` is optional and defaults to `logs`.
- Logging to file is always enabled.
- `logToCli: true` adds terminal output in addition to file output.
- `logDir` may be relative to the workspace root or an absolute path.

## Log Storage Layout

The logger must derive the target file path using this rule:

`{logDir}/{YYYY-MM-DD}/{sessionId}.log`

Requirements:

- the date directory is created from the local session start date,
- `sessionId` is generated once at process start,
- `sessionId` is a random short ID,
- one CLI process maps to one log file,
- parent directories are created automatically when missing.

Example default path:

`logs/2026-07-17/ab12cd34.log`

## Event Model

Each log entry must be a structured event written as one JSON object per line.

Minimum common fields:

- `timestamp`
- `sessionId`
- `event`

Optional event-specific fields may include:

- `step`
- `toolName`
- `callId`
- `messageCount`
- `error`

The first version must emit these events:

- `session.start`
- `session.end`
- `runtime.step.start`
- `runtime.step.end`
- `provider.generate.start`
- `provider.generate.end`
- `provider.generate.error`
- `tool.call.start`
- `tool.call.end`
- `tool.call.error`
- `assistant.final`
- `process.error`

## CLI Rendering

When `logToCli` is enabled, each structured event should also be rendered into a compact readable line for the terminal.

Examples:

- `[log] session=ab12cd34 event=session.start`
- `[log] session=ab12cd34 step=1 event=provider.generate.start`
- `[log] session=ab12cd34 step=1 tool=read_file event=tool.call.end`

The existing `[tool] ...` status lines remain unchanged in the first version so current CLI behavior does not regress.

## Architecture

The implementation should introduce a dedicated logging module instead of scattering `console.log` calls across runtime code.

Suggested responsibilities:

- `index`: load config, derive logger config, generate `sessionId`, create the logger,
- `logger module`: resolve file path, ensure directories exist, serialize JSON Lines, optionally mirror to CLI,
- `chat-cli`: emit session lifecycle events,
- `agent/runtime`: emit step, provider, tool, and final-answer events.

The logger should expose a small interface that hides output details from the CLI and runtime layers.

## Data Flow

1. MiniAgent starts and loads config.
2. Startup generates a random short `sessionId`.
3. Logger resolves the log file path from `logDir`, current date, and `sessionId`.
4. The CLI emits `session.start`.
5. The runtime emits events around each step, provider call, tool call, and final answer.
6. Each event is appended to the session log file as JSON Lines.
7. If `logToCli` is enabled, the same event is also rendered to the terminal.
8. On normal exit or fatal failure, the session emits a closing event.

## Error Handling

The feature must handle these cases explicitly:

- invalid config types for `logToCli` or `logDir`,
- failure to create the target log directory,
- failure to append to the log file,
- runtime/provider/tool exceptions that should still produce best-effort error events,
- process-level failure during startup or execution.

If logging itself fails, the user should still receive a clear terminal error. The logger must not silently swallow failures that hide the true state of the process.

## Testing Strategy

Tests must be added before implementation and should cover:

- default path resolution using `logs/{date}/{sessionId}.log`,
- custom `logDir` behavior,
- random `sessionId` being used consistently within one session,
- file logging always enabled,
- `logToCli: false` does not mirror logs to CLI,
- `logToCli: true` mirrors logs to CLI while still writing the file,
- runtime emits key events for provider, tool, and final answer flow,
- error events are written for failing provider or tool execution.

## Success Criteria

The feature is successful when:

1. starting MiniAgent creates a session log file automatically,
2. the file path follows the date-directory and session-file convention,
3. the same session writes all trace events into one file,
4. enabling `logToCli` mirrors those events into the CLI,
5. the runtime records enough events to reconstruct the execution chain,
6. tests verify both normal and error paths.
