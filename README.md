# MiniAgent

MiniAgent 是一个**从零一步步搭建通用 AI Agent** 的练习工程。它不是某个框架的封装，也不追求开箱即用的产品形态，而是把一个 Agent 运行时应有的核心部件——模型调用、工具执行、多步循环、会话持久化、事件流、前端渲染——拆开、写清楚、连起来，方便一层一层理解和改造。

目标是把「一个 Agent 到底由哪些部分组成、它们怎么协作」这件事讲明白。工具集只是当前挂载的一组示例能力，可以随意替换成任意领域的工具。

## 设计理念

- **分层清晰**：Provider / Agent 循环 / Session / Server / UI 各自独立，边界靠中立数据结构衔接，任意一层都可单独替换。
- **Provider 中立表示（IR）**：OpenAI Chat、OpenAI Responses、Anthropic 三家 API 被归一到同一套 `ContentBlock` 表示，Agent 循环与 UI 感知不到 provider 差异。
- **极简优先**：只保留跑通一个 Agent 真正必要的抽象，预留接口以 TODO 显式标注，不做投机式设计。

## 架构总览

```
ui-cli  ──HTTP + SSE──▶  server  ──▶  session  ──▶  agent loop  ──▶  provider  ──▶  LLM
 (client/renderer)        (routes)     (turn 持久化)   (core)         (IR 归一)
                                                          │
                                                          └──▶  tools (file / shell / web_search)
```

### 各层职责

| 目录             | 职责                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| `src/core`       | Agent 主循环、工具注册表（超时/校验/审批）、system prompt、日志、workspace    |
| `src/providers`  | 三家 LLM 的接入与中立 IR（`ContentBlock`）定义、`createProvider` 工厂         |
| `src/session`    | 基于 turn 的会话模型、会话仓库（`SessionStore`）、追加式持久化                |
| `src/server`     | HTTP 路由 + SSE 事件流，把 session 事件推给客户端；工具审批入口               |
| `src/ui-cli`     | 连接 server 的命令行客户端与渲染器                                            |
| `src/config`     | 从 `miniagent.config.json` 与环境变量解析运行配置                            |
| `src/transport`  | 预留：未来 in-process transport，让 TUI 零开销直接消费 Agent 事件流          |

### 核心运行机制

- **Agent 循环**（[`src/core/agent.ts`](src/core/agent.ts)）：反复调用 provider → 若模型请求工具则执行工具、把结果回灌 → 直到模型自然结束。需审批的工具（如写文件、执行命令）会暂停循环等待客户端批准。
- **反思机制**：单轮达到 `maxSteps` 仍未收敛时，注入一条反思 prompt 让模型自检并收敛；连续超过 `maxReflections` 次则强制终止，避免无限打转。
- **Turn 会话模型**（[`src/session/session.ts`](src/session/session.ts)）：内存中按 turn 分组的二维结构，磁盘保持扁平追加写；支持从某个已完成 turn 分叉（fork）出新会话。
- **中立 IR**（[`src/providers/factory.ts`](src/providers/factory.ts)）：thinking、tool_use、web_search、MCP 等能被 Agent/UI 感知的语义建为具名 block，其余 provider 原生结构走 `unknown` 兜底透传。

## 环境要求

- Node.js 22+
- 一个 OpenAI 或 Anthropic API key

## 配置

运行配置来自工作区下的 `miniagent.config.json`：

```bash
cp miniagent.config.example.json miniagent.config.json
```

```json
{
  "log": {
    "logDir": "logs"
  },
  "provider": {
    "type": "openai-chat",
    "model": "your_model_id",
    "baseURL": "https://api.openai.com/v1",
    "apiKey": "your_api_key"
  }
}
```

`provider.type` 可选三种后端：

- `openai-chat` — OpenAI Chat Completions API
- `openai-responses` — OpenAI Responses API
- `anthropic` — Anthropic Messages API

`model` 必须写在配置文件里。凭据可由环境变量覆盖（仅支持 SDK 原生字段）：

- OpenAI：`OPENAI_API_KEY`、`OPENAI_BASE_URL`
- Anthropic：`ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`

日志始终落盘。默认写到 `runtimeRoot` 下的 `logs/` 目录，并按日期分子目录存放；`log.logDir` 可改写这个基目录（支持相对或绝对路径）。

## 运行

Agent 以 **server + client** 两进程运行。

先在一个终端启动 Agent 服务：

```bash
npm run server
```

服务绑定到 `127.0.0.1` 的随机端口，并把地址写入 `.miniagent/runtime.json`。

再在另一个终端启动 CLI 客户端：

```bash
npm run cli
```

客户端会从 `.miniagent/runtime.json` 自动发现服务，也可用 `MINIAGENT_URL` 显式指定：

```bash
MINIAGENT_URL="http://127.0.0.1:8787" npm run cli
```

对话中：

- 输入内容回车即发起一轮；
- `/cancel` 中断当前轮；
- `/exit` 退出。

编译产物也通过单一 bin 暴露相同入口：

```bash
miniagent server   # 启动 Agent HTTP 服务
miniagent cli      # 启动 CLI 客户端（连接已运行的服务）
```

## 内置示例工具

当前挂载的一组工具（可自由增删替换）：

| 工具          | 作用                            | 需审批 |
| ------------- | ------------------------------- | ------ |
| `read_file`   | 读取工作区内 UTF-8 文本文件     | 否     |
| `list_files`  | 列出工作区目录内容              | 否     |
| `search_code` | 在工作区文件中搜索文本          | 否     |
| `write_file`  | 写入工作区内 UTF-8 文本文件     | 是     |
| `run_command` | 在工作区内执行安全 shell 命令   | 是     |
| `web_search`  | 联网搜索开放式问题              | 否     |

文件类工具被限制在工作区根目录内；shell 工具会先拒绝一小撮危险命令。标「需审批」的工具会暂停当前轮、等待客户端批准或拒绝后再执行。

## 开发

```bash
npm run typecheck   # 仅类型检查，不产出
npm run lint        # oxlint
npm run lint:fix    # oxlint --fix && oxfmt
npm run build       # 编译到 dist/
npm test            # 运行测试
```

## 项目状态

这是一个持续演进的练习工程：Provider IR、Agent 循环、Session/持久化已可运行；server 端的会话路由仍在从 mock 向真实实现推进，`src/transport` 为未来的 in-process 传输占位。代码中的 `TODO` 标注了这些有意预留的扩展点。
