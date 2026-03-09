# OpenClaw 插件系统

## 1. 概述

OpenClaw 采用**两层分离**的插件架构，将编译时的类型/辅助（Plugin SDK）与运行时的能力注入（Plugin Runtime）清晰分开。所有消息通道（包括内置和第三方）、功能扩展都通过统一的插件 API 注册。

## 2. 两层架构

```
┌─────────────────────────────────────────────────────┐
│  Plugin SDK (编译时，稳定 API，可发布)                  │
│  路径: src/plugin-sdk/index.ts (~730 行导出)           │
│  • 纯类型、辅助函数、配置工具                           │
│  • 无运行时状态、无副作用                               │
│  • 每个通道有专用子路径:                                │
│    openclaw/plugin-sdk/core                            │
│    openclaw/plugin-sdk/telegram                        │
│    openclaw/plugin-sdk/discord                         │
│    openclaw/plugin-sdk/slack                           │
│    openclaw/plugin-sdk/acpx                            │
│    ...                                                 │
└───────────────────────────┬─────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────┐
│  Plugin Runtime (运行时注入)                           │
│  路径: src/plugins/runtime/                            │
│  • 通过 api.runtime 暴露给插件                         │
│  • 访问核心运行时行为                                   │
│  • 按通道分组的子命名空间                               │
└─────────────────────────────────────────────────────┘
```

### 2.1 Plugin SDK 导出

SDK 导出 50+ 个类型和工具函数：

**通道类型**:
- `ChannelPlugin`, `ChannelMeta`, `ChannelCapabilities`
- `ChannelConfigAdapter`, `ChannelOutboundAdapter`, `ChannelGatewayAdapter`

**配置辅助**:
- `buildChannelConfigSchema`, `setAccountEnabledInConfigSection`
- `deleteAccountFromConfigSection`

**Webhook 工具**:
- `registerWebhookTarget`, `applyBasicWebhookRequestGuards`
- `readJsonWebhookBodyOrReject`

**安全工具**:
- `fetchWithSsrFGuard`（SSRF 防护的 fetch）
- `isBlockedHostnameOrIp`, `isPrivateIpAddress`

**通用工具**:
- 文件锁、异步队列、去重缓存、临时路径管理

### 2.2 Plugin Runtime 命名空间

```
runtime.channel.text.*        — 文本分块、控制命令检测
runtime.channel.reply.*       — 回复派发、打字状态、格式化
runtime.channel.routing.*     — Agent 路由解析
runtime.channel.pairing.*     — 配对流程（挑战/审批）
runtime.channel.media.*       — 远程媒体获取、缓冲保存
runtime.channel.mentions.*    — @提及正则匹配
runtime.channel.groups.*      — 群组策略解析
runtime.channel.debounce.*    — 入站消息防抖
runtime.channel.commands.*    — 命令授权
runtime.channel.discord.*     — Discord 专用运行时
runtime.channel.slack.*       — Slack 专用运行时
runtime.channel.telegram.*    — Telegram 专用运行时
runtime.channel.signal.*      — Signal 专用运行时
runtime.channel.imessage.*    — iMessage 专用运行时
runtime.channel.whatsapp.*    — WhatsApp 专用运行时
runtime.channel.line.*        — LINE 专用运行时
```

## 3. 插件定义与 API

### 3.1 插件定义

```typescript
type OpenClawPluginDefinition = {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  kind?: "memory" | "context-engine";
  configSchema?: OpenClawPluginConfigSchema;
  register?: (api: OpenClawPluginApi) => void | Promise<void>;
};

// 也支持函数形式
type OpenClawPluginModule =
  | OpenClawPluginDefinition
  | ((api: OpenClawPluginApi) => void | Promise<void>);
```

### 3.2 OpenClawPluginApi

核心注入接口，提供以下注册方法：

| 方法 | 功能 |
|------|------|
| `registerChannel()` | 注册消息通道 |
| `registerTool()` | 注册 Agent 工具 |
| `registerHook()` | 注册传统钩子 |
| `on()` | 注册类型化生命周期钩子 |
| `registerHttpRoute()` | 注册 HTTP 端点 |
| `registerGatewayMethod()` | 注册 Gateway RPC 方法 |
| `registerCli()` | 注册 CLI 命令 |
| `registerService()` | 注册后台服务 |
| `registerProvider()` | 注册模型提供者认证 |
| `registerCommand()` | 注册自动回复命令 |
| `registerContextEngine()` | 注册上下文引擎（独占槽） |

## 4. 生命周期钩子系统

### 4.1 24 个生命周期钩子

系统支持两种钩子执行模式：

#### Void Hooks（并行执行，无返回值）

| 钩子 | 触发时机 |
|------|---------|
| `llm_input` | LLM 接收输入前 |
| `llm_output` | LLM 返回输出后 |
| `agent_end` | Agent 执行结束 |
| `message_received` | 消息接收 |
| `message_sent` | 消息发送后 |
| `session_start` | 会话开始 |
| `session_end` | 会话结束 |
| `gateway_start` | Gateway 启动 |
| `gateway_stop` | Gateway 停止 |
| `before_reset` | 会话重置前 |
| `after_compaction` | 会话压缩后 |
| `subagent_spawned` | 子 Agent 创建后 |
| `subagent_ended` | 子 Agent 结束后 |

#### Modifying Hooks（按优先级顺序执行，结果合并）

| 钩子 | 触发时机 | 可修改内容 |
|------|---------|-----------|
| `before_agent_start` | Agent 启动前 | Agent 配置 |
| `before_model_resolve` | 模型解析前 | 模型选择 |
| `before_prompt_build` | 提示构建前 | 提示模板、系统上下文 |
| `before_tool_call` | 工具调用前 | 工具参数 |
| `after_tool_call` | 工具调用后 | 工具结果 |
| `message_sending` | 消息发送前 | 消息内容 |
| `subagent_spawning` | 子 Agent 创建前 | 子 Agent 配置 |
| `subagent_delivery_target` | 子 Agent 投递前 | 投递目标 |
| `before_message_write` | 消息写入前 | 消息格式 |
| `tool_result_persist` | 工具结果持久化前 | 持久化内容 |
| `before_compaction` | 会话压缩前 | 压缩策略 |

### 4.2 内部事件钩子

除了插件钩子，系统还有内部事件钩子（`src/hooks/internal-hooks.ts`）：

- 事件驱动，类型：`command` / `session` / `agent` / `gateway` / `message`
- 事件键格式：`type:action`（如 `command:new`、`message:received`、`session:compact:before`、`session:compact:after`）
- `globalThis` 单例确保跨 bundle 一致性

## 5. 插件发现与加载

### 5.1 发现顺序

```
优先级从高到低:
1. plugins.load.paths        → 配置文件指定路径
2. .openclaw/extensions/*    → 工作区扩展
3. ~/.openclaw/extensions/*  → 全局扩展
4. <openclaw>/extensions/*   → 内置扩展
```

### 5.2 加载流程

```
discoverOpenClawPlugins()           # 扫描候选路径
  │
  ▼
loadPluginManifestRegistry()        # 加载 openclaw.plugin.json 清单
  │
  ▼
resolveEffectiveEnableState()       # 解析启用/禁用状态
  │
  ▼
createPluginRuntime()               # 创建运行时注入对象
  │
  ▼
createPluginRegistry()              # 构建插件注册表
  │
  ▼
jiti 动态加载 TypeScript            # 无需编译
  │
  ▼
setActivePluginRegistry()           # 激活注册表
```

### 5.3 安全加固

- **路径安全检查**: 防止符号链接/路径穿越
- **目录权限检测**: 世界可写目录告警
- **所有者验证**: POSIX 文件所有者检查
- **信任白名单**: 非内置插件需要信任确认
- **安全安装**: npm install 使用 `--ignore-scripts`

## 6. 插件管理

### 6.1 安装方式

| 方式 | 示例 |
|------|------|
| npm 安装 | `openclaw plugins install @openclaw/voice-call` |
| 本地路径 | `openclaw plugins install ./extensions/voice-call` |
| 链接模式 | `openclaw plugins install -l ./my-plugin` (开发用) |
| 归档文件 | `.zip` / `.tgz` / `.tar.gz` / `.tar` |

### 6.2 CLI 命令

```bash
openclaw plugins list            # 列出所有插件
openclaw plugins info <id>       # 查看插件详情
openclaw plugins enable <id>     # 启用插件
openclaw plugins disable <id>    # 禁用插件
openclaw plugins update <id>     # 更新插件
openclaw plugins doctor          # 诊断插件问题
openclaw plugins uninstall <id>  # 卸载插件
```

### 6.3 插件清单文件

每个插件包含 `openclaw.plugin.json` 清单：

```json
{
  "id": "msteams",
  "channels": ["msteams"],
  "configSchema": { "type": "object", "properties": {} },
  "uiHints": { ... }
}
```

### 6.4 独占槽位

某些功能只允许一个插件占据（`plugins.slots`）：
- **memory**: 记忆插件（`memory-core` 或 `memory-lancedb`）
- **contextEngine**: 上下文引擎（`legacy` 或自定义插件，如 `lossless-claw`）

## 7. 40+ 个扩展一览

### 消息通道类（20 个）

`telegram`, `discord`, `slack`, `signal`, `whatsapp`, `imessage`, `msteams`, `matrix`, `feishu`, `googlechat`, `bluebubbles`, `mattermost`, `nextcloud-talk`, `nostr`, `irc`, `line`, `synology-chat`, `tlon`, `twitch`, `zalo/zalouser`

### 功能增强类

| 扩展 | 说明 |
|------|------|
| `voice-call` | 语音通话 |
| `memory-core` | 记忆搜索 |
| `memory-lancedb` | 向量记忆（LanceDB） |
| `diffs` | Diff 查看器 |
| `acpx` | ACP 扩展（IDE 集成增强） |
| `copilot-proxy` | Copilot 代理 |
| `diagnostics-otel` | OpenTelemetry 诊断 |
| `llm-task` | LLM 任务 |
| `open-prose` | 写作工具 |
| `phone-control` | 手机控制 |
| `talk-voice` | 语音对话 |
| `thread-ownership` | 线程所有权管理 |

### 认证类（3 个）

`google-gemini-cli-auth`, `minimax-portal-auth`, `qwen-portal-auth`

### 其他

`shared`（共享代码）, `test-utils`（测试工具）, `device-pair`（设备配对）
