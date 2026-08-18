# Agent Runtime 架构设计（v3）

> 本文档为全新设计，不参考也不兼容现有代码。落地时可大胆改动或删除现存实现。
> **例外**：`configs`、`providers`、`logger` 三个模块设计良好，尽量复用；必要时可扩展。

## 1. 目标与范围

### 第一期必须满足
- 一套统一的 UI ↔ Agent 通信协议，覆盖：用户消息、LLM 文本输出、reasoning、工具调用/结果、工具授权、agent 运行过程回显、错误、中断。
- 只做非 stream，为 stream 预留扩展能力。
- CLI 作为第一个 UI 形态，走同一套协议。

### 第一期显式不做
- stream（协议保留、实现非流式）
- 「一个命令启停」的进程编排
- TUI / Web / Desktop UI
- In-process Transport 的实现（目录 + 接口预留，无实现）
- 健康检查、监控、鉴权、跨机器
- UI 掉线重连的事件补拉
- 工具授权策略配置 / 持久化
- 工具输出流式（`tool_result` 一次性发）

## 2. 顶层架构

```
┌─────────────┐        HTTP + SSE        ┌──────────────────┐
│   CLI (UI)  │ ───── POST 命令 ───────► │   Agent Server   │
│  HTTP 客户端 │ ◄──── SSE 事件流 ─────── │  (HTTP Server)   │
└─────────────┘                          └────────┬─────────┘
                                                  │  in-process 接口
                                                  │  AsyncIterable<AgentEvent>
                                                  ▼
                                         ┌──────────────────┐
                                         │   Agent Core     │
                                         └──────────────────┘
```

- **Agent Core**：纯逻辑。对外只暴露一个方法产出 `AsyncIterable<AgentEvent>`，及少量控制函数（cancel、approve）。不引用任何 HTTP 类型。
- **Agent Server**：把 Core 包成 HTTP 服务。SSE 推事件，REST 收命令，管理 session 和授权 Promise 表。
- **CLI**：HTTP 客户端。fetch 发命令，EventSource / fetch-stream 消费 SSE。

进程模型：Agent Server 独立进程，监听 `127.0.0.1:{port}`。第一期启动方式：Server 打印端口到 stdout / 写入 `.miniagent/runtime.json`；CLI 从环境变量或该文件读取。**启动编排不在第一期范围**。

## 3. 通信协议

### 3.1 传输选型
- 下行：`text/event-stream` 长连接。
- 上行：普通 HTTP，RESTful，method 语义正确，可变参数走 query，不用动态 path 段。
- 错误策略：
  - Agent Core 内部对可预见错误做降级（记 notice / 发 error 事件 / 走默认分支），只有无法预测的错误才向上抛。
  - Server 层能感知错误原因、能降级处理的一律返回 `200`，在 body 中说明成功或失败。
  - `4xx` 只用于客户端错误（参数错误、资源不存在、状态冲突）。
  - `5xx` 只用于进程级不可恢复错误（服务无法继续运行）。

### 3.1.1 响应体统一约定
所有 `200` 响应统一 body：
- 成功：`{ ok: true, data?: <payload> }`
- 失败：`{ ok: false, error: { code: string, message: string } }`

`4xx` / `5xx` body 与 `200` 失败同形：`{ ok: false, error: { code, message } }`。

### 3.2 Session 模型
- Session = 一段连续对话上下文，服务端持有消息内存态。
- 一个 Session 同一时刻至多一个活跃 SSE 订阅者。

### 3.3 HTTP API（RESTful，query 传参）

所有端点成功一律返回 `200`；`4xx` 用于客户端错误；`5xx` 仅进程级不可恢复错误。

| Method | Path | Query / Body | 说明 |
|---|---|---|---|
| `POST` | `/sessions` | body: `{}` | 创建 session，成功 body: `{ ok: true, data: { sessionId } }` |
| `GET`  | `/events` | query: `sessionId` | 订阅事件流（`text/event-stream`），长连接。`sessionId` 不存在返回 `404` |
| `POST` | `/messages` | query: `sessionId`；body: `{ content: string }` | 追加一条用户消息并触发一轮 turn。立即返回 `{ ok: true }`，事件通过 `/events` 异步产出 |
| `POST` | `/cancel` | query: `sessionId` | 中断当前 turn，返回 `{ ok: true }` |
| `POST` | `/approvals` | query: `approvalId`；body: `{ decision: "approve" \| "deny" }` | 回复工具授权，返回 `{ ok: true }` |

### 3.4 SSE 事件模型

统一帧格式：
```
event: <event_type>
data: <json_payload>

```

第一期事件集合：

| event_type | payload 关键字段 | 说明 |
|---|---|---|
| `text_delta` | `{ turnId, text }` | LLM 文本输出。第一期非 stream：整段一次性作为一个 delta 发出。协议兼容未来多 delta |
| `reasoning_delta` | `{ turnId, text }` | LLM reasoning。同上，第一期一次性 |
| `tool_call` | `{ turnId, toolCallId, name, args }` | 工具调用发起 |
| `tool_result` | `{ turnId, toolCallId, result }` | 工具执行完成。第一期非 stream：整段结果一次性。未来若支持流式工具输出，增补 `tool_output_delta` |
| `tool_approval_request` | `{ turnId, approvalId, toolCallId, name, args }` | 需要用户授权 |
| `notice` | `{ turnId?, level, message, meta? }` | Agent 运行过程回显（"正在调用 provider"、"命中缓存"、"重试第 2 次" 等）。**由 Core 显式 emit**，与落盘日志系统解耦 |
| `error` | `{ turnId?, message, meta? }` | 错误信息，供 UI 显示 |
| `turn_done` | `{ turnId, finishReason }` | 一轮结束。UI 结束流式渲染；Server 释放 turn 相关资源（cancel token、未完成的 approval Promise 等） |

命名说明：
- 保留 `_delta` 后缀，未来非 stream → stream 无需改协议，UI 侧渲染逻辑只是从"一次追加"变为"多次追加"。
- 用 `notice` 而非 `log`，与文件落盘日志明确区分。`level` 为 `"info" | "warn"`（不含 `error`，错误走独立 `error` 事件）。

未知事件类型：UI 侧必须静默忽略，为未来扩展留出空间。

## 4. 核心接口（Agent Core，示意）

```
type AgentEvent =
  | { type: "text_delta"; turnId: string; text: string }
  | { type: "reasoning_delta"; turnId: string; text: string }
  | { type: "tool_call"; turnId: string; toolCallId: string; name: string; args: unknown }
  | { type: "tool_result"; turnId: string; toolCallId: string; result: unknown }
  | { type: "tool_approval_request"; turnId: string; approvalId: string; toolCallId: string; name: string; args: unknown }
  | { type: "notice"; turnId?: string; level: "info" | "warn"; message: string; meta?: unknown }
  | { type: "error"; turnId?: string; message: string; meta?: unknown }
  | { type: "turn_done"; turnId: string; finishReason: string };

interface Agent {
  /** 追加一条用户消息到 session 历史，驱动一轮 turn，产出该轮事件流。 */
  sendUserMessage(content: string): AsyncIterable<AgentEvent>;
  /** 中断当前正在进行的 turn。 */
  cancel(): void;
  /** 回复一条待决的工具授权请求。 */
  approve(approvalId: string, decision: "approve" | "deny"): void;
}
```

`AgentEvent` 是 Core 与 Server 之间的 in-process 事件契约，也是 Server 与 UI 之间的 SSE payload 契约。**单一事实源，Core 定义**。

## 5. 目录结构（全新）

```
src/
├── core/                        # Agent Core：纯逻辑，无 HTTP 依赖
│   ├── agent.ts                 # createAgent() → Agent（sendUserMessage / cancel / approve）
│   ├── events.ts                # AgentEvent 联合类型（协议单一事实源）
│   ├── turn.ts                  # 单轮 turn 循环（provider 调用 + 工具编排 + 事件 emit）
│   └── tools/                   # 工具定义与执行
│
├── providers/                   # 【复用现有模块】LLM provider 适配
├── configs/                     # 【复用现有模块】静态配置
├── logger.ts                    # 【复用现有模块】落盘日志，与 notice 事件解耦
│
├── server/                      # Agent Server：HTTP + SSE
│   ├── main.ts                  # 进程入口，选端口、启动 http server、写 runtime.json
│   ├── routes.ts                # RESTful 路由注册
│   ├── sse.ts                   # SSE 帧编码 + AsyncIterable → response 桥接
│   ├── sessions.ts              # sessionId → { agent, sseSink } 内存表
│   └── approvals.ts             # approvalId → resolver 内存表，含超时
│
├── ui-cli/                      # 第一期 UI：CLI HTTP 客户端
│   ├── main.ts                  # 入口
│   ├── client.ts                # HTTP 调用封装（fetch）
│   ├── stream.ts                # 消费 SSE，dispatch 到 renderer
│   └── renderer.ts              # 按 event_type 渲染到终端
│
└── transport/                   # 预留：未来 in-process transport 抽象
    └── README.md                # 说明扩展点，第一期不实现
```

**分层约束**：
- `core/` 禁止 import `server/` / `ui-cli/` / `http`。
- `core/` 可以 import `providers/` / `configs/` / `logger.ts`。
- `ui-cli/` 只依赖协议类型（从 `core/events.ts` re-export 一份 type-only 入口即可），不 import `core/` 其他内容。

## 6. 关键流程

### 6.1 发消息（详细）

**参与者**：CLI、Server（`routes` / `sessions` / `sse`）、Agent Core（`agent` / `turn`）。

前置状态：CLI 已经通过 `POST /sessions` 拿到 `sessionId`，并通过 `GET /events?sessionId=xxx` 建立好 SSE 长连接。Server 的 `sessions` 表中该 session 记录着 `{ agent, sseSink }`，`sseSink` 是一个已经绑定到 SSE 响应的写入函数。

步骤：

1. **CLI 发命令**：`POST /messages?sessionId=xxx`，body `{ content }`。
2. **Server 路由校验**：
   - 参数不合法 → `400 { ok: false, error }`。
   - sessionId 不存在 → `404 { ok: false, error }`。
   - 该 session 当前已有正在进行的 turn（未收到 `turn_done`）→ `200 { ok: false, error: { code: "turn_in_progress" } }`（可降级，不抛）。
3. **Server 立即响应**：返回 `200 { ok: true }`。**不等待 turn 完成**，让事件走 SSE 通道。
4. **Server 异步驱动 turn**：拿到该 session 的 `agent`，调用 `agent.sendUserMessage(content)`，得到 `AsyncIterable<AgentEvent>`。用 `for await` 消费迭代器（在一个后台 task 中，不阻塞 HTTP 响应）。
5. **Agent Core 内部行为**：
   - 生成 `turnId`。
   - 把 `content` 追加到 session 消息历史。
   - 进入 `turn.ts` 的 turn 循环：调 provider → 收到文本/工具调用 → emit `text_delta` / `reasoning_delta` / `tool_call` → 执行工具（如需授权先 emit `tool_approval_request` 并 await Promise）→ emit `tool_result` → 是否需要再调 provider → 满足终止条件 emit `turn_done`。
   - 循环过程中通过 emit 把事件推入 AsyncIterable。
   - 可预见错误（provider 报错、工具报错、JSON 解析错误等）：降级为 `notice` 或 `error` 事件，继续或结束 turn；不抛。
   - 无法预测错误：向上抛，由 Server 捕获后 emit 一个 `error` 事件 + `turn_done { finishReason: "crashed" }`。
6. **Server 桥接事件**：对每个从 AsyncIterable 拿到的 `event`：
   - 若 `event.type === "tool_approval_request"`：先在 `approvals` 表登记 `approvalId → resolver` 及超时定时器（默认 5 分钟，超时自动 `deny` 并 emit `notice`）。
   - 通过 `sseSink` 编码为 SSE 帧写入该 session 的 SSE 响应流。
   - 若 `event.type === "turn_done"`：清理该 turn 相关的 approval 资源，把 session 标记为空闲。
7. **CLI 消费事件**：`stream.ts` 逐帧解析，按 `event_type` 交给 `renderer.ts`：
   - `text_delta` / `reasoning_delta`：追加打印到终端。
   - `tool_call`：打印"正在调用工具 X..."。
   - `tool_result`：打印工具结果。
   - `tool_approval_request`：提示用户 y/n，用户输入后调 `POST /approvals?approvalId=xxx`。
   - `notice`：以低亮度打印过程信息。
   - `error`：以红色打印错误。
   - `turn_done`：结束本轮渲染，回到"等待输入"状态。
   - 未知 `event_type`：静默忽略。

**边界与降级**：
- SSE 未连接就发 `/messages`：Server 仍照常驱动 turn，事件写入 `sseSink` 时若 sink 未就绪则丢弃（第一期不做重放）。CLI 应先建立 SSE 再发消息。
- Turn 进行中 CLI 断线：Server 继续跑到 `turn_done`；重连后无法回补事件（不在第一期）。

### 6.2 工具授权
1. Agent Core emit `tool_approval_request { approvalId }`，内部 `await` 一个 Promise
2. Server 收到事件时，在 `approvals` 表登记 `approvalId → resolver`，超时（默认 5 分钟）自动 resolve 为 `deny` 并记 notice
3. Server 透传事件给 UI
4. UI 显示后用户决策 → `POST /approvals?approvalId=xxx { decision }`
5. Server resolve Promise → Agent 继续，emit `tool_call` / `tool_result` 或跳过

### 6.3 中断
1. UI: `POST /cancel?sessionId=xxx`
2. Server: 调 `agent.cancel()`
3. Agent Core: 触发内部 AbortSignal，停止 provider 调用，emit `turn_done { finishReason: "cancelled" }`

## 7. 约束

- **Agent Core 与 Server 严格解耦：Core 不引用任何 HTTP 类型**。
- **Core 与 UI 之间只共享 `AgentEvent` 类型**。除此之外 UI 侧不感知 Core 内部实现。
- **事件是开放集合**：UI 遇到未知 `event_type` 必须静默忽略，不报错。

## 8. 扩展点（仅接口/目录预留，第一期不实现）

- **stream**：把 `text_delta` / `reasoning_delta` / `tool_result` 从一次性发送改为多次发送即可，协议不动。UI 侧渲染改为增量拼接。工具流式输出通过新增 `tool_output_delta` 事件类型引入。
- **In-process Transport**：TUI 想零开销嵌入时，直接消费 `agent.sendUserMessage()` 的 `AsyncIterable`，绕过 HTTP。`src/transport/` 目录预留。
- **多 UI 形态**：任何 UI 只需实现同一套 HTTP+SSE 客户端。
- **多订阅者 / 多 session**：把 sessions 内的单一 SSE sink 换成 fan-out。
- **鉴权 / 跨机器**：加 token header，绑定非 loopback 地址。
- **WebSocket**：如需高频双向流，新增 `/ws` 端点，事件模型复用。
- **进程编排**：未来做「一个命令启停」时，父进程 spawn Server + UI 并管理 process group，协议不变。
