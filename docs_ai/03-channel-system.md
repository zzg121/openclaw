# OpenClaw 消息通道系统

## 1. 概述

OpenClaw 的消息通道系统是其最核心的特性之一，它将 20+ 个聊天平台统一接入到一个 AI 网关中。通道系统采用**插件化架构**，所有通道（包括内置和第三方）都通过统一的 `ChannelPlugin` 接口注册。

## 2. 支持的通道列表

### 2.1 核心内置通道（8 个）

| 通道 | 实现目录 | 文件数 | 连接方式 |
|------|---------|--------|---------|
| **Telegram** | `src/telegram/` | 123 | Bot API (grammy) |
| **Discord** | `src/discord/` | 158 | Bot API (discord.js) |
| **Slack** | `src/slack/` | 122 | Socket Mode (@slack/bolt) |
| **WhatsApp** | `src/web/` | 80 | Web API (Baileys, QR 登录) |
| **Signal** | `src/signal/` | 33 | signal-cli 守护进程 |
| **iMessage** | `src/imessage/` | 32 | imsg 工具 |
| **IRC** | 内置 | - | IRC 协议 |
| **Google Chat** | 内置 | - | Chat API |

### 2.2 扩展通道（12+ 个）

| 扩展 | NPM 包 | 说明 |
|------|--------|------|
| `msteams` | `@openclaw/msteams` | Microsoft Teams (Bot Framework) |
| `matrix` | `@openclaw/matrix` | Matrix 协议 (matrix-js-sdk)，支持端到端加密 |
| `feishu` | `@openclaw/feishu` | 飞书/Lark，额外注册 6 个工具集 |
| `bluebubbles` | `@openclaw/bluebubbles` | iMessage via BlueBubbles REST |
| `mattermost` | `@openclaw/mattermost` | Mattermost |
| `nextcloud-talk` | `@openclaw/nextcloud-talk` | Nextcloud Talk |
| `nostr` | `@openclaw/nostr` | Nostr 协议 |
| `line` | `@openclaw/line` | LINE |
| `synology-chat` | `@openclaw/synology-chat` | Synology Chat |
| `tlon` | `@openclaw/tlon` | Tlon (Urbit) |
| `twitch` | `@openclaw/twitch` | Twitch Chat |
| `zalo` / `zalouser` | `@openclaw/zalo` | Zalo OA / 个人号 |

## 3. 通道架构

### 3.1 三层设计

```
┌───────────────────────────────────────────────┐
│  Layer 1: ChannelDock（轻量级门面）              │
│  - 能力声明（capabilities）                     │
│  - 输出限制（textChunkLimit）                   │
│  - 流式合并策略                                 │
│  - 无重量级依赖，供共享代码路径使用               │
└───────────────────────┬───────────────────────┘
                        │
┌───────────────────────▼───────────────────────┐
│  Layer 2: ChannelPlugin（完整插件接口）           │
│  - 20+ 适配器接口                               │
│  - 生命周期管理                                  │
│  - 出站消息适配                                  │
│  - 安全策略                                     │
└───────────────────────┬───────────────────────┘
                        │
┌───────────────────────▼───────────────────────┐
│  Layer 3: Extension Module（扩展模块）           │
│  - register() 注册入口                          │
│  - 平台 SDK 集成                                │
│  - 消息监听与派发                                │
└───────────────────────────────────────────────┘
```

### 3.2 ChannelPlugin 接口

`ChannelPlugin` 是通道插件必须实现的核心接口，包含 20+ 个适配器：

| 适配器 | 必须/可选 | 职责 |
|--------|----------|------|
| `id` + `meta` + `capabilities` | **必须** | 基本标识和能力声明 |
| `config` | **必须** | 账户列表、配置解析 |
| `outbound` | **必须** | 出站消息发送（文本/媒体/投票） |
| `gateway` | 可选 | 连接生命周期（start/stop） |
| `onboarding` | 可选 | CLI 引导向导 |
| `pairing` | 可选 | 设备/用户配对 |
| `security` | 可选 | DM 安全策略 |
| `groups` | 可选 | 群组权限策略 |
| `mentions` | 可选 | @提及处理 |
| `status` | 可选 | 健康检查/探针 |
| `auth` | 可选 | 认证（QR 登录等） |
| `actions` | 可选 | 消息操作（撤回/编辑） |
| `streaming` | 可选 | 流式输出 |
| `threading` | 可选 | 线程/话题支持 |
| `directory` | 可选 | 用户/群组目录 |
| `resolver` | 可选 | 目标解析（用户名 → ID） |
| `heartbeat` | 可选 | 心跳/存活检测 |
| `agentTools` | 可选 | 通道专属 Agent 工具 |
| `agentPrompt` | 可选 | 提示词注入 |

### 3.3 ChannelDock（轻量级门面）

`ChannelDock`（`src/channels/dock.ts`）是通道的轻量级描述符，不引入重量级平台 SDK 依赖，供共享代码路径（回复流、命令授权等）使用：

```typescript
type ChannelDock = {
  id: ChannelId;
  capabilities: ChannelCapabilities;      // 支持的功能矩阵
  commands?: ChannelCommandAdapter;        // 命令适配
  outbound?: { textChunkLimit?: number };  // 输出限制
  streaming?: ChannelDockStreaming;         // 流式合并策略
  config?: ChannelConfigAdapter;           // 配置解析
  groups?: ChannelGroupAdapter;            // 群组策略
  mentions?: ChannelMentionAdapter;        // 提及处理
  threading?: ChannelThreadingAdapter;     // 线程管理
  agentPrompt?: ChannelAgentPromptAdapter; // Agent 提示注入
};
```

### 3.4 通道能力矩阵

每个通道声明其支持的能力：

| 通道 | 聊天类型 | 投票 | 反应 | 媒体 | 线程 | 流式 | 文本限制 |
|------|---------|------|------|------|------|------|---------|
| Discord | DM/Channel/Thread | ✓ | ✓ | ✓ | ✓ | ✓ | 2000 |
| Telegram | DM/Group/Channel | ✓ | ✓ | ✓ | ✓ | ✓ | 4000 |
| Slack | DM/Channel/Thread | - | ✓ | ✓ | ✓ | ✓ | 4000 |
| WhatsApp | DM/Group | ✓ | ✓ | ✓ | - | - | 4096 |
| Signal | DM/Group | - | ✓ | ✓ | - | - | - |
| iMessage | DM/Group | - | ✓ | ✓ | - | - | - |
| IRC | DM/Group | - | - | ✓ | - | ✗ | 350 |

## 4. 通道管理器

### 4.1 生命周期管理

`ChannelManager`（`src/gateway/server-channels.ts`）管理所有通道的生命周期：

```
启动:
  for each 已配置的通道:
    for each 账户:
      plugin.gateway.startAccount(accountId, signal)

停止:
  AbortController.abort() → 触发所有监听器停止

自动重启:
  失败时指数退避: 5s → 10s → 20s → ... → 5min (最多 10 次)
  手动停止的通道不会被自动重启
```

### 4.2 运行时快照

`getRuntimeSnapshot()` 返回所有通道的当前状态 `ChannelAccountSnapshot`，包括连接状态、延迟、错误信息等，用于 `openclaw channels status` 命令和 Web 控制面板。

### 4.3 健康监控

`startChannelHealthMonitor()` 持续监控所有活跃通道的健康状态，检测连接断开、超时等异常。

## 5. 通道注册模式

所有通道扩展遵循统一的注册模式：

```typescript
// extensions/<channel>/index.ts
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/<channel>";
import { channelPlugin } from "./src/channel.js";
import { setRuntime } from "./src/runtime.js";

const plugin = {
  id: "<channel>",
  name: "<Channel Name>",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    setRuntime(api.runtime);                       // 1. 注入运行时
    api.registerChannel({ plugin: channelPlugin }); // 2. 注册通道
  },
};
export default plugin;
```

**特殊扩展**:
- **Feishu**: 额外注册 6 个工具集（Doc/Chat/Wiki/Drive/Perm/Bitable）
- **Discord**: 额外注册子代理钩子
- **Matrix**: 初始化加密运行时

## 6. 通道注册表

核心通道注册表定义在 `src/channels/registry.ts`：

```typescript
const CHAT_CHANNEL_ORDER = [
  "telegram", "whatsapp", "discord", "irc",
  "googlechat", "slack", "signal", "imessage",
] as const;
```

支持别名解析：
- `imsg` → `imessage`
- `gchat` → `googlechat`

插件通道通过 `PluginRegistry` 动态注册。

## 7. 线程管理

各平台有专门的线程/话题管理实现：

| 平台 | 线程文件 | 说明 |
|------|---------|------|
| Discord | `src/discord/monitor/thread-bindings*.ts` (~65KB) | 完整的线程绑定生命周期 |
| Telegram | `src/telegram/thread-bindings.ts` (23KB) | 话题/线程管理 |
| Slack | `src/slack/threading*.ts` | 线程解析和绑定 |
| 通用 | `src/channels/thread-bindings-*.ts` | 跨平台线程绑定策略 |

### ACP 持久通道绑定

ACP 系统支持将会话绑定到特定的通道元素：

| 绑定类型 | 说明 |
|----------|------|
| Discord 频道 | 将 ACP 会话绑定到 Discord 频道 |
| Telegram 话题 | 将 ACP 会话绑定到 Telegram 话题（`/acp spawn --thread here|auto`） |

绑定支持 `persistent`（持久）和 `oneshot`（一次性）两种模式，绑定 ID 使用 SHA256 哈希确保唯一性。

## 8. Markdown 与格式化

支持 Markdown 的通道：
- Slack、Telegram、Signal、Discord、Google Chat、TUI、WebChat

每个通道有独立的格式化适配器，将通用 Markdown 转换为平台特定格式（如 Slack 的 mrkdwn、Discord 的 Markdown 子集等）。
