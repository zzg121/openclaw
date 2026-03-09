# OpenClaw 媒体管道与沙盒系统

## 1. 媒体处理管道

### 1.1 架构概览

媒体系统分为两大模块：

```
┌───────────────────────────────┐    ┌─────────────────────────────────┐
│  src/media/ (底层媒体处理)      │    │  src/media-understanding/ (AI 理解) │
│  • store.ts   — 文件存储       │    │  • runner.ts    — 理解运行器     │
│  • fetch.ts   — 远程获取       │───→│  • resolve.ts   — 提供商解析     │
│  • parse.ts   — MEDIA token    │    │  • providers/   — 各提供商实现   │
│  • mime.ts    — MIME 检测      │    │    ├── openai/   (image, audio)  │
│  • image-ops.ts — 图片操作     │    │    ├── google/   (image, audio,  │
│  • audio.ts   — 音频处理      │    │    │              video)          │
│  • pdf-extract.ts — PDF 提取  │    │    ├── anthropic/ (image)         │
│  • ffmpeg-exec.ts — FFmpeg    │    │    ├── groq/      (audio)         │
│  • base64.ts  — 编解码        │    │    ├── minimax/   (image, audio)  │
│  • server.ts  — 媒体服务器    │    │    ├── moonshot/  (image, video)  │
│  └── inbound-path-policy.ts   │    │    ├── mistral/   (image)         │
│      (入站路径安全策略)        │    │    ├── zai/       (audio)         │
└───────────────────────────────┘    │    └── deepgram/  (audio)         │
                                     └─────────────────────────────────┘
```

### 1.2 底层媒体处理

#### 媒体存储 (`media/store.ts`, 13KB)

| 特性 | 说明 |
|------|------|
| 文件命名 | UUID 随机命名 |
| 大小限制 | 5MB 默认上限 |
| TTL | 2 分钟有效期 |
| 权限 | `0o644`（支持 Docker 沙盒访问） |

#### 远程媒体获取 (`media/fetch.ts`, 5KB)

- **SSRF 防护**: 阻止内网地址访问
- **重定向限制**: 限制重定向次数
- **Content-Disposition 解析**: 提取原始文件名

#### MEDIA Token 解析 (`media/parse.ts`, 8KB)

从文本中提取 `MEDIA: <path>` 标记，支持在 Agent 响应中嵌入媒体引用。

#### 入站路径安全策略 (`media/inbound-path-policy.ts`)

验证入站媒体路径的安全性，防止路径穿越攻击。

### 1.3 媒体理解系统

#### 三种理解能力

| 能力 | 类型标识 | 说明 |
|------|---------|------|
| **图像描述** | `image` | 通过多模态 LLM 的 Vision 能力生成图像描述 |
| **音频转录** | `audio` | 通过各提供商的 Whisper/STT API 进行语音转文字 |
| **视频分析** | `video` | 仅 Google Gemini 和 Moonshot 支持 |

#### 提供商能力矩阵

| 提供商 | 图像 | 音频 | 视频 |
|--------|------|------|------|
| OpenAI | ✓ | ✓ | - |
| Google (Gemini) | ✓ | ✓ | ✓ |
| Anthropic | ✓ | - | - |
| Groq | - | ✓ | - |
| MiniMax | ✓ | ✓ | - |
| Moonshot | ✓ | - | ✓ |
| Mistral | ✓ | - | - |
| zAI | - | ✓ | - |
| Deepgram | - | ✓ | - |

#### 理解运行流程 (`media-understanding/runner.ts`)

```
消息中的媒体附件
  │
  ├─→ 附件筛选 (过滤支持的媒体类型)
  │
  ├─→ 范围决策 (channel / session 级别配置)
  │
  ├─→ 模型入口解析
  │     ├── provider 类型: 使用专门的媒体理解提供商
  │     └── cli 类型: 使用当前活跃的 LLM
  │
  ├─→ 并发处理 (可配置并发数)
  │
  ├─→ 回退机制 (无配置时回退到当前 LLM)
  │
  └─→ 结果附加到消息上下文
```

### 1.4 链接理解

`src/link-understanding/` 模块负责：
- 从消息中提取 URL
- 抓取 URL 内容（支持 Firecrawl 高质量提取）
- 生成内容摘要
- 附加到消息上下文中

## 2. Docker 沙盒系统

### 2.1 概述

OpenClaw 使用 Docker 沙盒隔离 Agent 的代码执行环境，确保安全性。系统提供三层 Docker 镜像，`src/agents/sandbox/` 目录包含 50 个文件实现了完整的容器化沙盒。

### 2.2 三层 Docker 镜像

```
Dockerfile.sandbox (基础沙盒)
  ├── debian bookworm-slim
  ├── bash, git, python3, ripgrep, jq
  └── 最小化系统工具
        │
        ├─→ Dockerfile.sandbox-browser (浏览器沙盒)
        │     ├── + Chromium
        │     ├── + xvfb (虚拟帧缓冲)
        │     ├── + VNC Server
        │     ├── + noVNC + websockify
        │     └── 暴露端口: 9222 (CDP), 5900 (VNC), 6080 (noVNC)
        │
        └─→ Dockerfile.sandbox-common (通用开发沙盒)
              ├── + Node.js
              ├── + Go
              ├── + Rust + Cargo
              ├── + pnpm, Bun
              └── + Homebrew
```

### 2.3 沙盒配置

`SandboxConfig` 提供丰富的配置选项：

| 配置项 | 选项 | 说明 |
|--------|------|------|
| `mode` | `off` / `non-main` / `all` | 沙盒激活模式 |
| `scope` | `session` / `agent` / `shared` | 容器共享范围 |
| `workspaceAccess` | `none` / `ro` / `rw` | 工作区访问权限 |
| `docker.image` | 字符串 | Docker 镜像名 |
| `docker.containerPrefix` | 字符串 | 容器名前缀 |
| `docker.network` | 字符串 | 网络配置 |
| `docker.env` | 键值对 | 环境变量 |
| `docker.ulimits` | 配置 | 资源限制 |
| `docker.mounts` | 配置 | 绑定挂载 |
| `browser.*` | CDP/VNC 配置 | 浏览器设置 |

### 2.4 安全验证

`src/agents/sandbox/validate-sandbox-security.ts` 实施严格的安全检查：

**阻止的宿主路径挂载**:
- `/etc`, `/proc`, `/sys`, `/dev`, `/root`, `/boot`, `/run`
- Docker socket (`/var/run/docker.sock`)

**阻止的安全配置**:
- seccomp: `unconfined`
- apparmor: `unconfined`

**保留的容器目标路径**:
- `/workspace` — Agent 工作空间
- 各 Agent 专用挂载点

**其他安全措施**:
- 支持自定义允许根目录（`allowedSourceRoots`）
- 路径穿越检测
- 符号链接检测
- 网络模式验证

### 2.5 沙盒核心组件

| 组件 | 文件 | 功能 |
|------|------|------|
| 容器管理 | `docker.ts` | 创建、启动、停止 Docker 容器（支持 Windows 跨平台） |
| 文件系统桥接 | `fs-bridge.ts`, `fs-bridge-path-safety.ts` | 安全的主机/容器文件传输 |
| 浏览器集成 | `browser.ts` | 沙盒中运行 Chrome，支持 CDP/NoVNC |
| 工具策略 | `tool-policy.ts` | 基于 glob 模式的工具允许/拒绝列表 |
| 上下文协调 | `context.ts` | 容器、工作区、浏览器的完整上下文解析 |
| 配置解析 | `config.ts` | 从 Agent 配置中解析沙盒参数 |

### 2.6 沙盒管理 API

`src/agents/sandbox.ts` 导出完整的沙盒管理接口：

| 功能 | 说明 |
|------|------|
| 配置解析 | 从 Agent 配置中解析沙盒参数 |
| 上下文创建 | 创建隔离的执行上下文 |
| 容器生命周期 | 启动/停止/重启容器 |
| 工具策略 | 沙盒环境下的工具访问限制 |
| 文件共享 | 通过 `/workspace` 挂载点共享文件 |

## 3. TTS（文字转语音）系统

### 3.1 支持的提供商

| 提供商 | 特色 |
|--------|------|
| **OpenAI TTS** | 支持自定义 `baseUrl`，模型 `gpt-4o-mini-tts` |
| **ElevenLabs** | 完整语音设置（稳定性、相似度增强、风格、速度） |
| **Edge TTS** | Microsoft Edge 免费 TTS |

### 3.2 功能特性

- Telegram 优化的 Opus 48kHz/64kbps 输出
- 长文本自动摘要后再语音合成
- Markdown 剥离
- TTS 指令解析（允许在消息中嵌入 TTS 控制指令）
- 语音通道自动禁用 TTS 工具（避免重复）

## 4. 52 个内置技能

`skills/` 目录包含 52 个内置技能，提供丰富的工具集成：

| 类别 | 技能 |
|------|------|
| **编码** | `coding-agent`（支持 Codex、Claude Code、Pi、OpenCode 多种编码代理） |
| **生产力** | `apple-notes`, `apple-reminders`, `notion`, `obsidian`, `trello` |
| **开发工具** | `github`, `gh-issues`, `clawhub` |
| **通信** | `discord`, `slack`, `himalaya` (邮件) |
| **媒体** | `camsnap`, `canvas`, `openai-image-gen`, `openai-whisper`, `peekaboo` |
| **AI** | `gemini`, `gog` |
| **系统** | `tmux`, `healthcheck` |
| **信息** | `weather`, `spotify-player` |
| **安全** | `1password` |
| **集成** | `mcporter` (MCP 协议桥接), `openhue` (智能家居) |

### coding-agent 技能详解

`skills/coding-agent/` 是最重要的内置技能之一：
- 支持多种编码代理后端：Codex、Claude Code、Pi、OpenCode
- PTY 模式指南和批量 PR 审查模式
- 并行工作流支持
- 后台执行 + 进程监控

## 5. MCP (Model Context Protocol) 集成

通过 **mcporter** skill 提供 MCP 协议支持：

- 支持 HTTP 和 stdio 两种传输方式
- MCP 服务器列表管理
- MCP 工具调用转发
- OAuth 认证流程
- 配置管理（守护进程模式）
- 代码生成（CLI 生成、TypeScript 类型生成）
