# OpenClaw 工具系统

## 1. 概述

OpenClaw 的工具系统（Tool System）是 AI Agent 与外部世界交互的核心能力层。它采用**三层架构**设计，支持文件操作、命令执行、浏览器控制、网页搜索、媒体处理、消息发送等丰富功能，并通过**多级策略管道**实现细粒度的访问控制。

## 2. 三层工具架构

```
┌────────────────────────────────────────────────────────┐
│  Layer 1: 核心编码工具 (@mariozechner/pi-coding-agent)   │
│  read / write / edit / exec / apply_patch / process     │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│  Layer 2: OpenClaw 平台工具 (src/agents/openclaw-tools.ts) │
│  browser / web_search / web_fetch / message / canvas     │
│  cron / nodes / tts / image / pdf / memory / subagents   │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│  Layer 3: 插件工具 (src/plugins/tools.ts)                │
│  通过 api.registerTool() 注册                             │
│  支持工具允许列表 (pluginToolAllowlist)                    │
└────────────────────────────────────────────────────────┘
```

## 3. 核心工具清单

### 3.1 编码工具（Layer 1）

来自 `@mariozechner/pi-coding-agent` 框架：

| 工具 | 功能 |
|------|------|
| `read` | 读取文件内容 |
| `write` | 写入文件 |
| `edit` | 编辑文件（替换） |
| `exec` | 执行 Shell 命令 |
| `apply_patch` | 应用代码补丁 |
| `process` | 后台进程管理 |

### 3.2 平台工具（Layer 2）

定义在 `src/agents/openclaw-tools.ts` 和 `src/agents/tools/` 目录：

| 工具 | 实现文件 | 功能 |
|------|---------|------|
| `browser` | `tools/browser-tool.ts` (20KB) | 浏览器自动化（Chromium CDP 协议） |
| `web_search` | `tools/web-search.ts` (52KB) | 网页搜索（多引擎支持） |
| `web_fetch` | `tools/web-fetch.ts` (24KB) | 网页抓取（含 Firecrawl 集成） |
| `message` | `tools/message-tool.ts` (26KB) | 多渠道消息发送 |
| `canvas` | `tools/canvas-tool.ts` | 画布/可视化工具 |
| `nodes` | `tools/nodes-tool.ts` (33KB) | 远程节点管理和媒体调用 |
| `cron` | `tools/cron-tool.ts` (19KB) | 定时任务管理 |
| `tts` | `tools/tts-tool.ts` | 文本转语音 |
| `gateway` | `tools/gateway-tool.ts` | 网关控制 |
| `image` | `tools/image-tool.ts` (17KB) | 图片处理/理解 |
| `pdf` | `tools/pdf-tool.ts` (19KB) | PDF 解析 |
| `memory_search` | `tools/memory-tool.ts` | 长期记忆语义搜索 |
| `memory_get` | `tools/memory-tool.ts` | 记忆条目获取 |
| `agents_list` | `tools/agents-list-tool.ts` | Agent 列表查询 |
| `sessions_list` | `tools/sessions-list-tool.ts` | 会话列表查询 |
| `sessions_history` | `tools/sessions-history-tool.ts` | 会话历史查看 |
| `sessions_send` | `tools/sessions-send-tool.ts` | 向会话发送消息（A2A 协议） |
| `sessions_spawn` | `tools/sessions-spawn-tool.ts` | 创建子 Agent 会话 |
| `subagents` | `tools/subagents-tool.ts` (25KB) | 子 Agent 管理 |
| `session_status` | `tools/session-status-tool.ts` | 会话状态查询 |

### 3.3 通道专属工具

| 工具 | 文件 | 平台 |
|------|------|------|
| Discord 操作 | `tools/discord-actions*.ts` | Discord |
| Slack 操作 | `tools/slack-actions.ts` | Slack |
| Telegram 操作 | `tools/telegram-actions.ts` | Telegram |
| WhatsApp 操作 | `tools/whatsapp-actions.ts` | WhatsApp |

### 3.4 插件工具（Layer 3）

通过 `api.registerTool()` 注册，支持：
- 工具允许列表（`pluginToolAllowlist`）
- `group:plugins` 通配符控制
- 动态发现和加载

## 4. 工具定义适配器

`src/agents/pi-tool-definition-adapter.ts` 是关键的工具适配层：

```
AnyAgentTool[]  ──toToolDefinitions()──→  ToolDefinition[] (LLM 可理解)
                                           │
ClientTool[]    ──toClientToolDefinitions()──→  代理定义 (返回 "pending")
```

功能特性：
- 自动处理遗留工具签名兼容性
- 统一结果规范化（`normalizeToolExecutionResult`）
- 内置错误捕获和日志
- **`beforeToolCall` 钩子集成**：执行前可拦截和修改参数

## 5. 工具策略与权限控制

### 5.1 多级策略管道

工具访问控制通过一系列策略层叠加决定（`src/agents/pi-tools.policy.ts`）：

```
   全局策略 (config.tools)
      │
   ▼ 全局提供商策略 (按模型提供商过滤)
      │
   ▼ Agent 策略 (每个 Agent 的工具限制)
      │
   ▼ Agent 提供商策略
      │
   ▼ Profile 策略
      │
   ▼ 分组策略 (按消息渠道的群组/通道过滤)
      │
   ▼ 沙盒策略 (沙盒环境的工具限制)
      │
   ▼ 子 Agent 策略 (深度限制和功能裁剪)
      │
   ▼ 消息提供商策略 (如语音渠道禁用 TTS)
      │
   ▼ 模型提供商策略 (如 xAI 禁用 web_search)
      │
   ▼ Owner-only 策略
      │
   → 最终工具列表
```

### 5.2 子 Agent 工具限制

子 Agent 有严格的工具限制策略：

**始终禁止**:
- `gateway`, `agents_list`, `session_status`
- `cron`, `memory_search`, `memory_get`
- `sessions_send`

**叶子节点（无法再创建子 Agent）额外禁止**:
- `sessions_list`, `sessions_history`, `sessions_spawn`

### 5.3 沙盒工具策略

沙盒环境下的工具通过 `tool-policy.ts` 控制：
- 基于 glob 模式的工具允许/拒绝列表
- 粒度可达工具级别

## 6. 工具循环检测

`src/agents/pi-tools.before-tool-call.ts` 实现了智能的工具调用循环检测：

- 检测重复调用模式
- 基于桶的警告抑制（每 10 次重复才发一次警告）
- 诊断会话状态跟踪
- 调整后参数缓存（上限 1024 条目）

## 7. 浏览器工具

### 7.1 核心架构

`browser` 工具（`tools/browser-tool.ts`）是最复杂的工具之一，`src/browser/` 目录包含 156 个文件，形成了企业级的浏览器自动化框架：

| 组件 | 文件 | 说明 |
|------|------|------|
| **Playwright 集成** | `pw-ai.ts`, `pw-session.ts`, `pw-tools-core.ts` | 60+ 个浏览器操作 |
| **CDP 直连** | `cdp.ts` | Chrome DevTools Protocol 支持 |
| **Chrome 扩展中继** | `extension-relay.ts` | 通过 Chrome 扩展控制浏览器 |
| **配置管理** | `config.ts`, `profiles.ts` | 多浏览器配置文件 |
| **安全** | `control-auth.ts`, `csrf.ts`, `http-auth.ts` | 认证和 CSRF 保护 |
| **AI 快照** | `pw-role-snapshot.ts` | 角色标签式页面快照供 AI 理解 |

### 7.2 支持的操作

导航、点击、填表、截图、下载、Cookie 管理、地理定位、网络拦截、存储操作、PDF 生成、轨迹录制等 60+ 种操作。

### 7.3 沙盒集成

支持在 Docker 沙盒内运行 Chromium 实例：
- CDP 端口：9222
- VNC 远程控制：5900
- noVNC Web 访问：6080

## 8. 网页搜索与抓取

### 8.1 web_search

- 多搜索引擎支持
- Brave LLM Context 搜索模式（`tools.web.search.brave.mode: "llm-context"`）
- Perplexity Search API 集成
- 结果解析和排名
- 内容摘要提取

### 8.2 web_fetch

- 网页内容抓取
- **Firecrawl 集成**：高质量内容提取（base URL: `https://api.firecrawl.dev`，48h 缓存）
- SSRF 防护
- 重定向处理
- Content-Type 检测
