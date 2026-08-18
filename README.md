# MiniAgent

MiniAgent is a minimal prompt-driven coding agent for the terminal. It is intentionally not a workflow engine: the model decides whether to clarify, answer, produce spec/plan/handoff text in chat, or use tools.

## Requirements

- Node.js 22+
- An OpenAI or Anthropic API key

## Configuration

MiniAgent reads the LLM provider from `miniagent.config.json` in the current workspace.

Create a local config file:

```bash
cp miniagent.config.example.json miniagent.config.json
```

Then edit `miniagent.config.json`:

```json
{
  "log": {
    "logDir": "logs",
    "logToCli": false
  },
  "provider": {
    "type": "openai-chat",
    "model": "your_model_id",
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "your_api_key"
  }
}
```

Logging is always written to disk. By default MiniAgent stores one JSON Lines file per session under `logs/{YYYY-MM-DD}/{sessionId}.log`.

- `log.logDir` changes the base log directory while keeping the date and session layout.
- `log.logToCli: true` mirrors the same structured log events to the terminal.

Environment variables can override provider credentials from the config file:

```bash
export OPENAI_API_KEY="your_api_key"
export OPENAI_BASE_URL="https://api.openai.com/v1"
```

Supported environment variables are only the SDK-native fields:

- OpenAI: `OPENAI_API_KEY`, `OPENAI_BASE_URL`
- Anthropic: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`

`model` must come from `miniagent.config.json`.

## Usage

```bash
npm start
```

Build and run the compiled output:

```bash
npm run build
npm run start:dist
```

In the chat:

- type `:quit` to exit,
- type `:multiline` to enter multiline mode,
- finish multiline mode with `:end`.

## MVP Tools

The runtime registers these tools:

- `read_file`
- `write_file`
- `list_files`
- `search_code`
- `run_command`
- `web_search`

Local file tools are restricted to the current workspace root. The shell tool rejects a small set of dangerous commands before execution.

## Test

```bash
npm test
```

Type-check and verify the compiled output:

```bash
npm run typecheck
npm run test:dist
```
