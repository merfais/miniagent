# MiniAgent

MiniAgent is a minimal prompt-driven coding agent for the terminal. It is intentionally not a workflow engine: the model decides whether to clarify, answer, produce spec/plan/handoff text in chat, or use tools.

## Requirements

- Node.js 22+
- A OpenAI-compatible Ark API key

## Configuration

MiniAgent reads the LLM provider from `miniagent.config.json` in the current workspace.

Create a local config file:

```bash
cp miniagent.config.example.json miniagent.config.json
```

Then edit `miniagent.config.json`:

```json
{
  "provider": {
    "type": "openai-compatible",
    "model": "your_model_id",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your_api_key"
  }
}
```

If you prefer not to store the API key in the config file, use `apiKeyEnv`:

```json
{
  "provider": {
    "type": "openai-compatible",
    "model": "your_model_id",
    "baseUrl": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Environment variables are now a fallback path. The preferred path is the config file.

If `miniagent.config.json` is missing, MiniAgent falls back to the legacy environment variable mode:

```bash
export OPENAI_API_KEY="your_api_key"
export ARK_MODEL="your_model_id"
```

## Usage

```bash
npm start
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
