# OpenClaw 系统架构

## 1. 总体架构

OpenClaw 采用 **Gateway 中心化** 架构，核心是一个运行在用户本地设备上的 Gateway 服务器，统一管理所有消息通道、AI Agent、工具调用和会话状态。

```
┌─────────────────────────────────────────────────────────────┐
│                     客户端 / 消息平台                          │
│  Telegram  Discord  Slack  WhatsApp  Signal  iMessage  ...  │
│  macOS App  iOS App  Android App  Web UI  IDE (ACP)         │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│               Channel Layer（通道层）                         │
│  ChannelPlugin → Monitor → InboundMessage                   │
│  ChannelDock → Capabilities → Outbound                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│            Gateway Server（网关服务器）                        │
│  ┌──────────┐ ┌───────────┐ ┌────────────────┐             │
│  │  Auth    │ │  Router   │ │ Method Handler │             │
│  │  (认证)  │ │  (路由)   │ │  (方法注册)     │             │
│  └──────────┘ └───────────┘ └────────────────┘             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  WebSocket Protocol + HTTP REST API                  │  │
│  │  /v1/chat/completions (OpenAI 兼容)                  │  │
│  │  /v1/responses (OpenResponses API)                   │  │
│  │  ACP (Agent Client Protocol, stdio)                  │  │
│  └──────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │
     ┌─────────────────────┼──────────────────────┐
     │                     │                      │
┌────▼────────────┐  ┌────▼───────────────┐  ┌───▼────────────┐
│  Agent Engine    │  │  Tool System       │  │ Plugin System  │
│  Session/Memory  │  │  Browser/Web/Media │  │ 24 Hooks       │
│  Context Engine  │  │  Sandbox/SubAgent  │  │ Channel/Tool   │
│  A2A Protocol    │  │  Cron/TTS/Canvas   │  │ Http/CLI Reg   │
└────┬────────────┘  └────┬───────────────┘  └───┬────────────┘
     │                     │                      │
┌────▼─────────────────────▼──────────────────────▼────────────┐
│                 AI Provider Layer（AI 提供商层）                │
│  Anthropic  OpenAI  Gemini  Ollama  vLLM  MiniMax  Bedrock  │
│  Moonshot  Qwen  Volcengine  XiaoMi  BytePlus  百度千帆       │
└──────────────────────────────────────────────────────────────┘
```

## 2. 入口与启动流程

### 2.1 CLI 入口

项目的入口点是 `src/entry.ts`，启动流程如下：

```
openclaw.mjs (CLI 入口脚本)
  └─→ src/entry.ts
       ├── loadDotEnv()                 # 加载 .env 配置
       ├── normalizeEnv()               # 环境变量标准化
       ├── ensureOpenClawCliOnPath()     # 确保 CLI 在 PATH 上
       ├── enableConsoleCapture()        # 启用控制台日志捕获
       ├── assertSupportedRuntime()      # 检查运行时兼容性
       ├── buildProgram()               # 构建 Commander.js 命令体系
       └── program.parseAsync()          # 解析并执行命令
```

### 2.2 Gateway 启动

Gateway 服务器通过 `startGatewayServer()` 启动（`src/gateway/server.impl.ts`），初始化以下子系统：

```
startGatewayServer()
  ├── createChannelManager()            # 通道生命周期管理
  ├── createAgentEventHandler()         # Agent 事件处理
  ├── buildGatewayCronService()         # 定时任务服务
  ├── NodeRegistry                      # 远程节点注册
  ├── ExecApprovalManager               # 命令执行审批
  ├── startGatewayDiscovery()           # mDNS/Bonjour 服务发现
  ├── startGatewayConfigReloader()      # 配置热重载
  ├── startChannelHealthMonitor()       # 通道健康监控
  ├── loadGatewayModelCatalog()         # 模型目录加载
  ├── createPluginRuntime()             # 插件运行时初始化
  └── initContextEngine()              # 上下文引擎初始化
```

默认监听端口 **18789**。

## 3. Gateway 服务器

### 3.1 WebSocket 协议

Gateway 使用自定义的 WebSocket 协议进行实时通信，定义了三种帧类型：

| 帧类型 | 标识 | 结构 | 用途 |
|--------|------|------|------|
| `RequestFrame` | `"req"` | `{ type:"req", id, method, params }` | 客户端 → 服务端请求 |
| `ResponseFrame` | `"res"` | `{ type:"res", id, ok, payload, error }` | 服务端 → 客户端响应 |
| `EventFrame` | `"event"` | `{ type:"event", event, payload, seq }` | 服务端 → 客户端推送 |

### 3.2 连接握手流程

```
Client                          Server
  │                                │
  │──── WebSocket Connect ────────→│
  │                                │
  │←── connect.challenge (nonce) ──│
  │                                │
  │──── connect (ConnectParams) ──→│
  │     { client, auth, device,    │
  │       role, scopes }           │
  │                                │
  │←──── HelloOk ─────────────────│
  │      { features.methods,       │
  │        features.events,        │
  │        snapshot, policy }      │
  │                                │
```

**`ConnectParams`** 包含：
- `client`: 客户端 ID、版本、平台、模式（`backend` / `cli` / `webchat` / `probe`）
- `auth`: token / deviceToken / password
- `device`: Ed25519 设备公钥签名
- `role`: `operator` / `node`
- `scopes`: 权限范围（`operator.admin` / `read` / `write` / `approvals` / `pairing`）

### 3.3 Gateway 客户端

`GatewayClient` 类（`src/gateway/client.ts`）封装了完整的 WebSocket 客户端逻辑：
- **自动重连**: 指数退避（1s → 30s 上限）
- **心跳监控**: 2 倍间隔超时自动断开
- **序列号间隙检测**: 检测消息丢失
- **TLS 指纹校验**: SHA-256 证书 pinning
- **安全保护**: 阻止明文 ws:// 连接到非 loopback 地址

### 3.4 HTTP REST API

Gateway 同时提供多个 HTTP 端点：

| 端点 | 用途 |
|------|------|
| `POST /v1/chat/completions` | OpenAI 兼容聊天补全（支持流式 SSE） |
| `POST /v1/responses` | OpenResponses API（标准化 Agent 响应） |
| `POST /hooks` | Webhook 钩子（外部服务触发 Agent 响应） |
| `/health` | 健康检查 |
| 媒体/Webhook 端点 | 通道特定的回调处理 |

### 3.5 OpenResponses API

`/v1/responses` 端点实现了 [OpenResponses](https://www.open-responses.com/) 标准 API：

- 支持多种输入类型：`input_text`, `input_image`（URL/base64）, `input_file`
- 支持角色消息：system, developer, user, assistant
- 支持函数调用：`function_call`, `function_call_output`
- 支持图像格式：JPEG, PNG, GIF, WebP, HEIC, HEIF
- 支持 SSE 流式事件传输
- 自动桥接到内部 Agent 引擎

### 3.6 RPC 方法体系

所有业务功能通过 RPC 方法注册表组织：

| 领域 | 方法示例 |
|------|---------|
| **连接** | `connect` |
| **聊天** | `chat.send`, `chat.history`, `chat.abort`, `chat.inject` |
| **Agent** | `agent`, `agent.identity.get`, `agent.wait` |
| **会话** | `sessions.list`, `sessions.preview`, `sessions.patch`, `sessions.reset`, `sessions.delete`, `sessions.compact` |
| **配置** | `config.get`, `config.set`, `config.apply`, `config.patch`, `config.schema` |
| **通道** | `channels.status`, `channels.logout` |
| **模型** | `models.list` |
| **节点** | `node.pair.*`, `node.list`, `node.invoke` |
| **设备** | `device.pair.*`, `device.token.*` |
| **Cron** | `cron.list`, `cron.add`, `cron.remove`, `cron.run` |
| **执行审批** | `exec.approval.request`, `exec.approval.resolve` |
| **工具** | `tools.catalog` |
| **TTS** | `tts.status`, `tts.convert` |
| **Secret** | `secrets.resolve` |
| **ACP** | ACP 会话管理相关方法 |

## 4. 认证与安全

### 4.1 认证模式

| 模式 | 说明 |
|------|------|
| `none` | 无认证（仅限本地开发） |
| `token` | 共享 token 认证 |
| `password` | 密码认证 |
| `trusted-proxy` | 受信代理透传 |
| `tailscale` | Tailscale 身份认证 |
| `device-token` | 设备级别 token（Ed25519 签名） |

### 4.2 四层访问控制

```
认证 (Auth)  →  角色 (Role)  →  权限范围 (Scope)  →  方法 (Method)
```

1. **认证层**: 速率限制（可配置 loopback 豁免）、远程连接强制 TLS
2. **角色层**: `operator` / `node` 角色区分
3. **Scope 层**: 细粒度权限范围（admin / read / write / approvals / pairing）
4. **方法层**: 方法级别的访问控制（`authorizeGatewayMethod()`）

### 4.3 网络安全

- 所有远程连接强制 TLS（`isSecureWebSocketUrl` 检查）
- X-Forwarded-For 信任链验证（从右向左遍历）
- 支持 IPv4 + IPv6 双栈监听
- 绑定模式：`loopback` / `lan` / `tailnet` / `auto` / `custom`
- TLS 指纹校验（SHA-256 证书 pinning）

## 5. 消息路由系统

### 5.1 路由解析

核心函数 `resolveAgentRoute()` 实现多层级优先匹配：

```
匹配优先级（从高到低）:
1. binding.peer           → 直接 peer 匹配（群组/频道/DM）
2. binding.peer.parent    → 线程父 peer 继承
3. binding.guild + roles  → Discord Guild + 角色匹配
4. binding.guild          → Guild 级匹配
5. binding.team           → Slack Team 匹配
6. binding.account        → 按账户匹配
7. binding.channel        → 按通道匹配（支持通配符 "*"）
8. default                → 默认 Agent
```

**性能优化**:
- 双层缓存：配置绑定缓存 + 路由结果缓存
- `WeakMap` 绑定到配置对象，配置变更自动失效
- 索引化查询：`byPeer`、`byGuild`、`byTeam` 等 Map 索引

### 5.2 Session Key

Session Key 是会话持久化的核心标识，格式为 `agent:{agentId}:{scope}`。

**DM 会话 Scope 策略**:

| 策略 | 说明 |
|------|------|
| `main` | 所有 DM 共享同一会话（默认） |
| `per-peer` | 每个对话者独立会话 |
| `per-channel-peer` | 每个通道×对话者独立 |
| `per-account-channel-peer` | 账户×通道×对话者独立 |

**群组/线程**: `agent:{agentId}:{channel}:{peerKind}:{peerId}[:thread:{threadId}]`

**身份链接**: 支持跨通道用户身份合并（`identityLinks`），确保同一用户在不同平台使用同一会话。

### 5.3 Session Key 类型

系统支持多种会话类型的 Key 解析：

| 类型 | 格式 | 说明 |
|------|------|------|
| Agent | `agent:{id}:...` | 常规 Agent 会话 |
| Cron | `cron:{id}:...` | 定时任务会话 |
| SubAgent | 含子 Agent 后缀 | 子 Agent 会话 |
| ACP | ACP 协议会话 | IDE 集成会话 |
| Thread | 含 `thread:{id}` | 线程会话 |

## 6. 入站消息处理流程

```
[聊天平台消息]
  │
  ├─→ Channel Monitor (通道特定的消息监听器)
  │
  ├─→ Message Context 构建 (bot-message-context.ts)
  │
  ├─→ Allow-From 过滤 (allowlist-match.ts)
  │
  ├─→ Mention Gating (群组中是否需要 @提及)
  │
  ├─→ Agent Route 解析 (resolve-route.ts)
  │
  ├─→ Session Key 构建 (session-key.ts)
  │
  ├─→ Auto-Reply 引擎 (auto-reply/)
  │     ├─→ 媒体理解（图像/音频/视频转录）
  │     ├─→ 链接理解（URL 内容提取）
  │     ├─→ 上下文引擎（记忆检索、历史加载）
  │     └─→ AI 模型调用（工具循环）
  │
  ├─→ 响应格式化 (Markdown → 平台特定格式)
  │
  └─→ Channel Outbound (通道特定的消息发送)
```

## 7. ACP（Agent Client Protocol）集成

ACP 是 OpenClaw 用于 IDE/编辑器集成的标准协议，基于 `@agentclientprotocol/sdk`：

```
IDE / 编辑器
  │
  │──── ACP (stdio, ndJSON) ────→ ACP Server (src/acp/server.ts)
  │                                    │
  │                                    ├─→ AcpGatewayAgent (translator.ts)
  │                                    │     翻译 ACP 请求为 Gateway 调用
  │                                    │
  │                                    └─→ Gateway WebSocket
  │
  │←──── 流式响应/事件 ─────────── 
```

详见 [08-core-features.md](./08-core-features.md) 中 ACP 系统详解。

## 8. 配置热重载

Gateway 支持配置文件的热重载机制：

- `startGatewayConfigReloader()` 监控配置文件变更
- 配置变更时自动重新验证和应用
- 路由缓存通过 `WeakMap` 自动失效
- 通道管理器动态启停受影响的通道
- 无需重启 Gateway 服务

## 9. BOOT 机制

`BOOT.md` 文件（`src/gateway/boot.ts`）允许在 Gateway 启动时自动执行 Agent 指令，类似 Linux 的 init.d 系统，用于自动化初始化任务。

## 10. 服务发现

### 10.1 mDNS/Bonjour

`startGatewayDiscovery()` 使用 mDNS/Bonjour 协议在局域网中广播 Gateway 服务：

- 服务类型：`_openclaw-gw._tcp`
- DNS-SD 转义解码
- 自动发现同网络的 Gateway 实例
- 支持 LAN、Tailnet DNS、SSH 端口、TLS 指纹等元数据

### 10.2 Tailscale 回退

当 mDNS 不可用时，支持通过 Tailscale Serve/`.ts.net` 进行服务发现。

### 10.3 远程节点

`NodeRegistry` 管理远程计算节点：

- 节点注册和心跳
- 任务分发和结果收集
- 媒体文件跨节点传输
