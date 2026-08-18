# transport/

预留：未来 in-process transport 抽象。

第一期不实现，仅目录占位。未来当 TUI（如 Ink）想零开销嵌入 Agent Core 时，
在此提供一个 `InProcessTransport`，让 TUI 直接消费 `agent.sendUserMessage()`
返回的 `AsyncIterable<AgentEvent>`，绕过 HTTP + SSE。

Web / Desktop 等跨进程 UI 仍走 `src/server/` 提供的 HTTP + SSE。
