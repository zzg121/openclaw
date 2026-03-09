# OpenClaw 核心特性实现原理

## 1. Agent 引擎

### 1.1 Agent 命令执行

Agent 引擎是 OpenClaw 的核心执行单元，定义在 `src/agents/` 目录。核心命令 `agent` 在 `src/commands/agent.ts` (32KB) 中实现，支持：

- 通过 Gateway WebSocket 执行（`agent-via-gateway.ts`）
- 直接本地执行
- 流式输出支持
- 工具调用循环（Tool Loop）
- 子 Agent 创建和管理

### 1.2 Agent 路由

每个入站消息通过路由系统匹配到具体的 Agent：

```
消息 → resolveAgentRoute() → Agent 配置 → Session Key → 执行
```

支持灵活的绑定策略：
- 按 peer（对话）绑定
- 按 guild/team（服务器/团队）绑定
- 按 channel（通道）绑定
- 默认 Agent 兜底

### 1.3 子 Agent 系统

支持 Agent 间的嵌套调用和协作：

- `sessions_spawn` 工具创建子 Agent 会话
- `subagents` 工具管理子 Agent 生命周期
- 深度限制防止无限递归
- 工具策略逐层收紧（叶子节点禁止创建新子 Agent）
- A2A（Agent-to-Agent）消息协议

## 2. ACP（Agent Client Protocol）系统

### 2.1 概述

ACP 是 OpenClaw 实现的标准化 IDE/编辑器集成协议，基于 `@agentclientprotocol/sdk`，定义在 `src/acp/`（53 个文件）。它允许 IDE（如 VS Code、JetBrains 等）通过标准协议与 OpenClaw Agent 交互。

### 2.2 架构

```
IDE / 编辑器
  │
  │── ACP (stdio, ndJSON) ──→ ACP Server (src/acp/server.ts)
  │                                │
  │                          AcpGatewayAgent (translator.ts)
  │                                │ 翻译 ACP 请求为 Gateway 调用
  │                                │
  │                          Gateway WebSocket
  │                                │
  │←── 流式响应/事件 ──────── Agent 执行结果
```

### 2.3 ACP 服务端

`src/acp/server.ts` 通过 stdio 运行 ACP 服务端：
- 支持参数：`--url`, `--token`, `--token-file`, `--password-file`, `--session`, `--session-label`, `--reset-session`, `--no-prefix-cwd`
- 自动连接到 Gateway WebSocket
- 翻译 ACP 请求为 Gateway 内部调用

### 2.4 ACP 客户端

`src/acp/client.ts` 实现了 ACP 客户端：
- 生成子进程并通过 stdio 进行 ndJSON 通信
- **安全特性**：自动批准安全工具（`read`, `search`, `web_search`, `memory_search`），危险工具需要用户确认
- `read` 工具进行路径范围检查：确保只读取当前工作目录内的文件

### 2.5 ACP 控制面板

`AcpSessionManager` 单例管理所有 ACP 会话：

| 功能 | 说明 |
|------|------|
| 会话解析 | 标识和管理活跃会话 |
| 运行周转 | 处理请求/响应周转 |
| 可观察性 | 活跃会话数、队列深度、完成数、失败数、延迟统计 |
| 延迟追踪 | `TurnLatencyStats`（平均/最大延迟） |

### 2.6 持久通道绑定

ACP 支持将会话绑定到特定的通道元素：

| 绑定类型 | 说明 |
|----------|------|
| Discord 频道 | 将 ACP 会话持久绑定到 Discord 频道 |
| Telegram 话题 | 将 ACP 会话绑定到 Telegram 话题（`/acp spawn --thread here|auto`） |

- 支持 `persistent`（持久）和 `oneshot`（一次性）两种模式
- 绑定 ID 使用 SHA256 哈希确保唯一性

### 2.7 ACP 子代理生成

`src/agents/acp-spawn.ts` 支持通过 ACP 生成子代理：

```typescript
SpawnAcpParams = {
  task: string;         // 任务描述
  label?: string;       // 会话标签
  agentId?: string;     // 目标 Agent ID
  cwd?: string;         // 工作目录
  mode?: string;        // 执行模式
  thread?: string;      // 线程模式 (here | auto)
  sandbox?: boolean;    // 是否使用沙盒
  streamTo?: "parent";  // 流式输出到父会话
}
```

当 `streamTo: "parent"` 时，子运行进度/无输出/完成更新会通过 `acp-spawn-parent-stream.ts` 中继到父会话。

### 2.8 ACP 配置

```typescript
{
  enabled: boolean;
  dispatch: string;
  backend: string;
  defaultAgent: string;
  allowedAgents: string[];
  maxConcurrentSessions: number;
  stream: {
    coalesceIdleMs: number;
    maxChunkChars: number;
    deliveryMode: string;
    tagVisibility: string;
  };
  runtime: {
    ttlMinutes: number;
    installCommand: string;
  };
}
```

## 3. A2A（Agent-to-Agent）协议

### 3.1 概述

A2A 实现了代理间的通信协议，支持多轮"乒乓"对话：

### 3.2 实现原理

`src/agents/tools/sessions-send-tool.a2a.ts` 的 `runSessionsSendA2AFlow()` 函数：

```
Agent A                                  Agent B
  │                                        │
  │── 发送消息 ───────────────────────────→│
  │                                        │── 处理并回复
  │←── 回复 ──────────────────────────────│
  │                                        │
  │── 继续对话 ───────────────────────────→│ (如果需要)
  │                                        │
  ... (最多 maxPingPongTurns 轮)
  │                                        │
  │── 通知完成 ───→ 目标通道（Telegram/Discord 等）
```

- 可配置最大乒乓回合数（`maxPingPongTurns`）
- 自动构建 Agent-to-Agent 上下文（通知上下文 + 回复上下文）
- 完成后通过 `callGateway` 发送通知消息到目标通道
- 支持跨通道代理通信

## 4. OpenResponses API

### 4.1 概述

OpenClaw 实现了 [OpenResponses](https://www.open-responses.com/) 标准 API（`src/gateway/openresponses-http.ts`，25KB），提供标准化的 Agent 响应接口。

### 4.2 端点

`POST /v1/responses`

### 4.3 支持的功能

| 功能 | 说明 |
|------|------|
| 输入类型 | `input_text`, `input_image`（URL/base64）, `input_file` |
| 角色消息 | system, developer, user, assistant |
| 函数调用 | `function_call`, `function_call_output` |
| 图像格式 | JPEG, PNG, GIF, WebP, HEIC, HEIF |
| 文件输入 | 任意 MIME 类型 |
| 流式传输 | SSE 事件格式 |

### 4.4 Prompt 构建

`buildAgentPrompt()` 将 OpenResponses 输入转换为 OpenClaw 内部格式：
- system/developer 消息分离
- 会话历史合并
- 函数调用输出路由

## 5. 会话管理

### 5.1 会话持久化

会话通过 Session Key 标识和持久化：

```
Session Key 格式: agent:{agentId}:{scope}

DM 会话:  agent:default:main
群组:     agent:default:telegram:group:12345
线程:     agent:default:discord:thread:67890
```

### 5.2 会话操作

| 操作 | 方法 | 说明 |
|------|------|------|
| 列表 | `sessions.list` | 查看所有活跃会话 |
| 预览 | `sessions.preview` | 查看会话摘要 |
| 历史 | `chat.history` | 查看完整聊天历史 |
| 重置 | `sessions.reset` | 清除会话上下文 |
| 压缩 | `sessions.compact` | 压缩冗长的会话历史 |
| 删除 | `sessions.delete` | 删除会话 |
| 注入 | `chat.inject` | 向会话注入消息 |
| 中止 | `chat.abort` | 中止正在进行的生成 |
| 模型覆盖 | `model-overrides.ts` | 会话级模型/提供者切换 |

### 5.3 会话压缩

会话压缩是管理长对话的关键特性：

- `before_compaction` 钩子允许插件自定义压缩策略
- `after_compaction` 钩子通知压缩完成
- 内部事件：`session:compact:before` / `session:compact:after`
- 支持压缩模型覆盖（使用不同模型进行压缩）

### 5.4 身份链接

跨通道身份合并机制（`identityLinks`）：

```
用户 Alice 在不同平台的身份:
  Telegram: @alice_tg    ─┐
  Discord:  alice#1234    ├──→ 统一身份 → 共享同一会话
  Slack:    alice.smith   ─┘
```

### 5.5 发送策略

`send-policy.ts` 实现了基于规则的发送权限控制：
- 按通道过滤
- 按聊天类型过滤
- 按密钥前缀匹配

## 6. 记忆系统

### 6.1 混合搜索引擎

`src/memory/` 目录包含 96 个文件，实现了企业级的记忆系统：

```
┌─────────────────────────────────────┐
│  混合搜索引擎 (hybrid.ts)            │
│  • 向量相似度 (sqlite-vec)          │
│  • BM25 关键词评分 (FTS5)           │
│  • 加权融合排分                      │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│  MMR 多样性重排 (mmr.ts)             │
│  • Maximal Marginal Relevance       │
│  • Jaccard 相似度                   │
│  • 可配置 lambda (0=多样性, 1=相关性) │
└──────────────────┬──────────────────┘
                   │
┌──────────────────▼──────────────────┐
│  时间衰减 (temporal-decay.ts)        │
│  • 指数衰减函数: e^(-λt)            │
│  • 可配置半衰期 (默认 30 天)         │
│  • 新鲜记忆权重更高                  │
└─────────────────────────────────────┘
```

### 6.2 多嵌入提供者

| 提供者 | 说明 |
|--------|------|
| OpenAI | 嵌入 API |
| Gemini | 批量嵌入支持 |
| Voyage | 批量嵌入支持 |
| Mistral | 嵌入 API |
| Ollama | 本地嵌入 |
| Local (node-llama) | 纯本地嵌入 |

### 6.3 QMD（量子记忆数据库）

`src/memory/qmd-manager.ts` (68KB) 实现了与外部 mcporter CLI 的集成：
- 中文 Han 脚本 BM25 优化
- 会话文件管理
- 记忆同步

### 6.4 记忆插件

| 插件 | 说明 | 特点 |
|------|------|------|
| `memory-core` | 内置记忆搜索 | 轻量级，SQLite-vec + FTS5 |
| `memory-lancedb` | LanceDB 向量记忆 | 高性能向量存储 |

记忆插件占据 `plugins.slots.memory` 独占槽位，同一时间只能有一个活跃。

## 7. 上下文引擎

### 7.1 可插拔架构

`src/context-engine/` 实现了全新的可插拔上下文管理架构：

**`ContextEngine` 接口提供完整的生命周期**：

| 方法 | 说明 |
|------|------|
| `bootstrap()` | 为会话初始化引擎状态，可选导入历史上下文 |
| `ingest()` / `ingestBatch()` | 将消息摄入引擎存储 |
| `assemble()` | 在 token 预算内组装模型上下文 |
| `compact()` | 压缩上下文以减少 token 使用 |
| `afterTurn()` | 运行后生命周期回调 |
| `prepareSubagentSpawn()` | 子代理生成前准备（含回滚句柄） |
| `onSubagentEnded()` | 子代理结束通知 |
| `dispose()` | 资源清理 |

### 7.2 引擎解析机制

通过 `config.plugins.slots.contextEngine` 配置选择：
- 默认回退到 `"legacy"` 引擎（`LegacyContextEngine`）
- 注册表使用 `Symbol.for("openclaw.contextEngineRegistryState")` 保存在 `globalThis`
- 第三方插件（如 `lossless-claw`）可提供无损上下文等替代策略

### 7.3 核心职责

- 历史消息加载和管理
- 上下文窗口大小控制
- 记忆检索结果注入
- 提示模板构建
- 会话压缩策略

## 8. 定时任务 (Cron)

### 8.1 概述

通过 `cron` 工具，Agent 可以创建和管理定时任务：

```bash
openclaw cron list           # 列出所有定时任务
openclaw cron add            # 添加定时任务
openclaw cron remove         # 删除定时任务
openclaw cron run            # 手动执行定时任务
```

### 8.2 实现

- `src/cron/` — 定时任务调度核心
- `buildGatewayCronService()` — Gateway 启动时初始化
- 通过 Gateway RPC 方法管理：`cron.list`, `cron.add`, `cron.remove`, `cron.run`
- Agent 可通过 `cron` 工具编程创建定时任务

## 9. 设备配对

### 9.1 配对流程

```
新设备                              已信任设备
  │                                    │
  │── device.pair.request ────────────→│
  │   (设备公钥 + Ed25519 签名)        │
  │                                    │
  │←── device.pair.approve/reject ─────│
  │   (审批/拒绝)                      │
  │                                    │
  │── device.token.request ───────────→│
  │                                    │
  │←── device.token.issue ────────────│
  │   (发放设备 Token)                 │
```

### 9.2 安全特性

- Ed25519 非对称签名验证设备身份
- Nonce 挑战防止重放攻击
- 设备 Token 独立于共享密钥
- 支持设备 Token 撤销

## 10. 执行审批

### 10.1 审批流程

```
Agent                Gateway              用户/客户端
  │                    │                     │
  │── exec 请求 ──────→│                     │
  │                    │── approval.request →│
  │                    │                     │
  │                    │←── approval.resolve─│
  │                    │    (approve/reject) │
  │←── 结果 ──────────│                     │
```

### 10.2 实现

- `ExecApprovalManager` — 审批管理器
- Gateway RPC: `exec.approval.request`, `exec.approval.resolve`
- CLI: `exec-approvals-cli.ts` — 命令行审批界面
- ACP 客户端中自动批准安全工具（`read`, `search` 等），危险工具需用户确认

## 11. Webhook 钩子系统

### 11.1 概述

`src/gateway/hooks.ts` 提供 HTTP webhook 端点，允许外部服务触发 Agent 响应。

### 11.2 配置

```yaml
hooks:
  enabled: true
  token: "your-webhook-token"
  mappings:
    - path: "/webhook/github"    # 匹配路径
      source: "github"           # 来源标识
      action: "agent"            # 动作: "wake" 或 "agent"
      channel: "telegram"        # 目标通道
      agent: "devops"            # 目标 Agent
      template: "GitHub event: {{body.action}} on {{body.repository.name}}"
```

### 11.3 功能

- Token 认证保护（`Authorization: Bearer <token>` 或 `X-OpenClaw-Token`）
- Agent 路由：自动路由到指定 Agent 和会话
- Session 策略：支持请求级/映射级 session key
- Agent 白名单策略（`hooks.allowedAgentIds`）
- Gmail webhook 集成（Tailscale serve/funnel）

## 12. 守护进程

### 12.1 跨平台支持

| 平台 | 机制 | 实现文件 |
|------|------|---------|
| Linux | systemd 用户服务 | `daemon/systemd.ts` |
| macOS | launchd plist | `daemon/launchd.ts` |
| Windows | schtasks 计划任务 | `daemon/schtasks.ts` |

### 12.2 管理命令

```bash
openclaw daemon install    # 安装守护进程
openclaw daemon start      # 启动
openclaw daemon stop       # 停止
openclaw daemon status     # 状态查看
openclaw daemon uninstall  # 卸载
```

### 12.3 高级功能

- 服务审计（`service-audit.ts`）— 验证服务配置一致性
- 服务环境管理（`service-env.ts`）— EnvironmentFile 管理
- WSL2 检测和特殊处理

## 13. 原生应用

### 13.1 多平台客户端

| 平台 | 目录 | 技术栈 | 最低版本 |
|------|------|--------|---------|
| macOS | `apps/macos/` | Swift 6.2 / SwiftPM | macOS 15 |
| iOS | `apps/ios/` | Swift 6.0 / XcodeGen | iOS 18 |
| Android | `apps/android/` | Kotlin / Jetpack Compose | Android 12 (SDK 31) |
| watchOS | `apps/ios/` (子 Target) | Swift / SwiftUI | watchOS 11 |

### 13.2 macOS 应用

菜单栏常驻应用，功能包括：
- AppState、Canvas 管理器（WebView 集成）
- 通道设置、Cron 作业编辑器、配置管理
- 设备配对审批、语音唤醒
- Sparkle 自动更新、Peekaboo 屏幕捕获
- Gateway 发现（Bonjour/mDNS + Tailscale）

### 13.3 iOS 应用

5 个 Target 组成：
1. **主应用** — 相机、日历/联系人/提醒事项、位置、语音唤醒、Live Activity
2. **ShareExtension** — iOS 分享扩展
3. **ActivityWidget** — Live Activity 小组件
4. **WatchApp** — watchOS 应用
5. **WatchExtension** — watchOS 扩展

### 13.4 Android 应用

- **Node.js 嵌入式运行时** (`NodeRuntime.kt`, 31KB) — 在 Android 应用内嵌 Node.js 运行 Gateway
- 前台服务保活
- 安全存储（`androidx.security:security-crypto`）
- QR 码扫描（ZXing）配对

### 13.5 共享库（OpenClawKit）

Apple 平台（iOS + macOS）共享的 Swift Package，包含 3 个库：
1. **OpenClawProtocol** — Gateway 通信协议模型（`GatewayModels.swift` 85KB）
2. **OpenClawKit** — 核心 SDK（Gateway 通信、设备认证、Bonjour 发现等）
3. **OpenClawChatUI** — SwiftUI 聊天 UI 组件

## 14. Web 控制界面

### 14.1 技术栈

| 层面 | 技术选型 |
|------|----------|
| **框架** | Lit 3.3.2（Web Components） |
| **构建** | Vite 7.3.1 |
| **状态** | TC39 Signals + Lit @state() |
| **安全** | DOMPurify + @noble/ed25519 |
| **Markdown** | marked 17.x |

### 14.2 12 个标签页

| 组 | 标签 |
|----|------|
| **Chat** | chat |
| **Control** | overview, channels, instances, sessions, usage, cron |
| **Agent** | agents, skills, nodes |
| **Settings** | config, debug, logs |

### 14.3 国际化

支持 6 种语言：`en`（默认）、`zh-CN`、`zh-TW`、`pt-BR`、`de`、`es`
- 懒加载（仅英语内联，其他动态导入）
- 浏览器语言自动检测
- 持久化到 `localStorage`

## 15. 部署方式

### 15.1 四种部署选项

| 方式 | 说明 |
|------|------|
| **本地运行** | `openclaw gateway run` 直接运行 |
| **Docker** | `docker-setup.sh` 一键部署，支持可选沙盒 |
| **Fly.io** | `fly.toml`，共享 CPU + 持久卷 |
| **Render** | `render.yaml`，Docker 运行时 + 持久磁盘 |

### 15.2 Docker 部署特点

- 多阶段构建，基于 `node:22-bookworm`
- SHA256 digest 锁定确保可复现性
- 支持 slim 变体（`--build-arg OPENCLAW_VARIANT=slim`）
- 可选扩展构建（`--build-arg OPENCLAW_EXTENSIONS="..."`)
- 自动生成 Gateway Token
- 可选沙盒模式（挂载 Docker socket）

## 16. 配置系统

### 16.1 Zod Schema 验证

所有配置通过 Zod Schema 严格验证，包括：
- 通道提供商配置
- 提供商配置聚合
- 钩子配置
- ACP 配置

### 16.2 热重载

- 文件变更监控
- 自动重新验证和应用
- 受影响的通道动态重启
- 路由缓存自动失效

### 16.3 管理方式

- Gateway RPC: `config.get`, `config.set`, `config.apply`, `config.patch`, `config.schema`
- CLI: `openclaw config set ...`
- 交互式向导: `configure.wizard.ts` (20KB)
- 备份: `openclaw backup create/verify`（支持 `--only-config`）

## 17. CLI 体系

### 17.1 命令结构

CLI 基于 Commander.js 构建，主要命令族：

| 命令 | 说明 |
|------|------|
| `openclaw gateway run` | 启动 Gateway |
| `openclaw channels status` | 通道状态 |
| `openclaw config set` | 配置管理 |
| `openclaw plugins install` | 插件安装 |
| `openclaw doctor` | 诊断检查 |
| `openclaw send` | 发送消息 |
| `openclaw setup` | 首次设置 |
| `openclaw update` | 版本更新 |
| `openclaw dashboard` | 打开控制面板 |
| `openclaw backup create` | 创建备份 |
| `openclaw daemon install` | 安装守护进程 |

### 17.2 诊断系统

`openclaw doctor` 提供全面的诊断检查：

- 认证检查（`doctor.auth`）
- 运行时兼容性（`doctor.runtime`）
- 配置验证（`doctor.config`）
- 功能检查（`doctor.features`）
- Bootstrap 大小检查
- Shell 补全检查
