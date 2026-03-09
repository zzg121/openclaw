# OpenClaw 项目总览

## 1. 项目简介

**OpenClaw** 是一个开源的本地 AI 助手平台（Local AI Assistant），核心是运行在用户本地设备上的多通道 AI 网关（Multi-channel AI Gateway）。它将 20+ 个聊天平台（Telegram、Discord、WhatsApp、Slack、Signal、iMessage 等）统一接入，连接到 20+ 个 AI 模型提供商（Anthropic、OpenAI、Google Gemini、Ollama 等），让用户可以在任何消息平台或原生客户端上与 AI Agent 交互。

- **仓库**: https://github.com/openclaw/openclaw
- **许可证**: MIT
- **语言**: TypeScript（ESM 模块）
- **运行时**: Node.js >= 22.12.0
- **包管理器**: pnpm 10.x
- **构建工具**: tsdown（bundler）+ tsc（类型声明）
- **测试框架**: Vitest 4.x（V8 覆盖率，阈值 70%）
- **Lint/Format**: oxlint + oxfmt
- **最新版本**: 2026.3.8

## 2. 核心设计理念

根据 `VISION.md`，OpenClaw 遵循以下核心原则：

1. **设备本地运行** — 在用户自己的设备上运行，充分尊重用户隐私
2. **多平台支持** — CLI 优先（CLI-first），同时提供 macOS / iOS / Android / Web 原生客户端
3. **安全第一** — 默认安全策略，高权限操作需显式授权
4. **插件化架构** — 核心精简，可选能力通过插件/扩展提供
5. **TypeScript 优先** — 选择 TypeScript 使项目易于社区贡献和扩展

**开发优先级**: 安全与安全默认值 > Bug 修复与稳定性 > 首次运行体验

## 3. 顶层目录结构

```
openclaw/
├── src/                    # 核心源代码（CLI、Gateway、Agent、通道、插件等）
├── extensions/             # 40+ 个可选扩展插件（消息通道 + 功能增强）
├── apps/                   # 原生客户端
│   ├── macos/              #   macOS 菜单栏应用 (Swift/SwiftPM)
│   ├── ios/                #   iOS 应用 (Swift/XcodeGen) + watchOS
│   ├── android/            #   Android 应用 (Kotlin/Jetpack Compose)
│   └── shared/             #   Apple 平台共享库 (OpenClawKit)
├── ui/                     # Web 控制界面 (Vite + Lit Web Components)
├── skills/                 # 52 个内置技能（编码代理、天气、GitHub 等）
├── packages/               # 内部子包（clawdbot / moltbot）
├── docs/                   # 文档站（Mintlify，含 zh-CN / ja-JP 国际化）
├── scripts/                # 112+ 个自动化脚本（构建、测试、CI/CD、发布）
├── test/                   # 测试目录
├── vendor/                 # 第三方供应商代码
├── patches/                # pnpm 补丁
├── assets/                 # 静态资源
├── git-hooks/              # Git 钩子
├── Dockerfile              # 主 Docker 镜像（多阶段构建）
├── Dockerfile.sandbox*     # 沙盒 Docker 镜像（3 层：基础 / 浏览器 / 通用开发）
├── docker-compose.yml      # Docker Compose 配置
├── docker-setup.sh         # 一键 Docker 部署脚本
├── fly.toml                # Fly.io 部署配置
├── render.yaml             # Render 部署配置
├── package.json            # 项目元数据与依赖
├── tsconfig.json           # TypeScript 编译配置
├── pnpm-workspace.yaml     # 工作区定义
├── openclaw.mjs            # CLI 入口脚本
├── AGENTS.md               # AI 代理开发指南
├── VISION.md               # 项目愿景
├── CONTRIBUTING.md          # 贡献指南
├── SECURITY.md             # 安全策略
└── CHANGELOG.md            # 变更日志
```

## 4. `src/` 核心模块一览

`src/` 下包含约 72 个子目录/文件，约 2000+ 个源码文件，按功能域划分如下：

| 模块 | 目录 | 职责 |
|------|------|------|
| **CLI 框架** | `cli/` (293 文件) | Commander.js CLI 框架、参数解析、Shell 补全 |
| **命令实现** | `commands/` (278 文件) | 所有 CLI 命令的业务逻辑（最大模块） |
| **Gateway 服务器** | `gateway/` | HTTP/WebSocket 网关核心（认证、协议、方法注册） |
| **Agent 引擎** | `agents/` | AI Agent 执行引擎、工具管理、沙盒、ACP 集成 |
| **消息通道** | `channels/` | 通道抽象层（注册表、Dock、插件接口） |
| **路由系统** | `routing/` | 消息路由解析、会话 Key、绑定管理 |
| **插件系统** | `plugins/` / `plugin-sdk/` | 插件加载、注册表、运行时注入、SDK |
| **ACP 协议** | `acp/` (53 文件) | Agent Client Protocol — IDE/编辑器集成 |
| **配置管理** | `config/` | Zod Schema 验证的配置体系 |
| **安全模块** | `security/` / `secrets/` | 安全策略、密钥/凭据管理 |
| **基础设施** | `infra/` | 环境、端口、二进制管理、提供商用量跟踪 |
| **媒体处理** | `media/` | 媒体存储、获取、解析、图像/音频操作 |
| **媒体理解** | `media-understanding/` | 多模态 AI 理解（图像描述、音频转录、视频分析） |
| **链接理解** | `link-understanding/` | URL 内容提取与理解 |
| **记忆系统** | `memory/` (96 文件) | 混合搜索（向量+BM25）、MMR 多样性重排、时间衰减 |
| **上下文引擎** | `context-engine/` | 可插拔上下文管理（支持插件替换） |
| **钩子系统** | `hooks/` | 内部事件钩子 |
| **定时任务** | `cron/` | 定时任务调度 |
| **会话管理** | `sessions/` | 会话持久化、模型覆盖、发送策略 |
| **TTS** | `tts/` | 文字转语音（OpenAI / ElevenLabs / Edge TTS） |
| **浏览器** | `browser/` (156 文件) | Playwright 浏览器自动化 + CDP 协议 |
| **终端/TUI** | `terminal/` / `tui/` | 终端表格、TUI 界面 |
| **国际化** | `i18n/` | 多语言支持 |
| **守护进程** | `daemon/` (47 文件) | systemd / launchd / schtasks 守护进程管理 |
| **设备配对** | `pairing/` | Ed25519 设备配对流程 |
| **日志** | `logging/` | 结构化日志系统 |
| **进程管理** | `process/` | 进程生命周期管理 |
| **自动回复** | `auto-reply/` | 入站消息自动回复引擎 |
| **AI 提供商** | `providers/` | AI 模型提供商集成 |
| **消息通道实现** | `telegram/` `discord/` `slack/` `signal/` `imessage/` `web/` `whatsapp/` `line/` | 各平台具体实现 |

## 5. 关键依赖

### 核心运行时依赖

| 依赖 | 用途 |
|------|------|
| `commander` | CLI 框架 |
| `express` 5.x | HTTP 服务器 |
| `ws` | WebSocket |
| `zod` | Schema 验证 |
| `grammy` | Telegram Bot API |
| `@slack/bolt` | Slack 集成 |
| `@discordjs/voice` | Discord 语音 |
| `@whiskeysockets/baileys` | WhatsApp 集成 |
| `@line/bot-sdk` | LINE 集成 |
| `playwright-core` | 浏览器自动化 |
| `sharp` | 图像处理 |
| `sqlite-vec` | 向量数据库 |
| `@agentclientprotocol/sdk` | ACP 协议 |
| `@mariozechner/pi-*` | Pi Agent/TUI 框架 |
| `@noble/ed25519` | Ed25519 加密签名 |

### 开发依赖

| 依赖 | 用途 |
|------|------|
| TypeScript 5.9.x | 编译器 |
| Vitest 4.x | 测试框架 |
| oxlint / oxfmt | Lint + 格式化 |
| Lit 3.x | Web UI 组件 |
| tsdown | 打包工具 |
| Vite 7.x | Web UI 构建 |

## 6. 工作区结构

项目采用 pnpm 工作区（monorepo）管理：

```yaml
# pnpm-workspace.yaml
packages:
  - "."           # 根包（核心 Gateway + CLI）
  - "ui"          # Web 控制界面
  - "packages/*"  # 内部子包
  - "extensions/*" # 所有扩展插件
```

## 7. 构建与开发命令

| 命令 | 用途 |
|------|------|
| `pnpm install` | 安装依赖 |
| `pnpm build` | 类型检查 + 构建 |
| `pnpm tsgo` | TypeScript 类型检查 |
| `pnpm check` | Lint + 格式检查 |
| `pnpm format:fix` | 自动格式化 |
| `pnpm test` | 运行测试（Vitest） |
| `pnpm test:coverage` | 覆盖率测试 |
| `pnpm dev` / `pnpm openclaw ...` | 开发模式运行 CLI |

## 8. 项目规模统计

| 指标 | 数据 |
|------|------|
| `src/` 文件数 | ~2000+ |
| `src/commands/` | 278 个文件 |
| `src/cli/` | 293 个文件 |
| `extensions/` | 40+ 个扩展 |
| `skills/` | 52 个内置技能 |
| 支持的消息通道 | 20+ 个 |
| 支持的 AI 提供商 | 20+ 个 |
| 插件生命周期钩子 | 24 个 |
| Agent 工具 | 20+ 个核心工具 |
| UI i18n 语言 | 6 种 |
| 部署方式 | 4 种（本地/Docker/Fly.io/Render） |
