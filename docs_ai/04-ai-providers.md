# OpenClaw AI 提供商集成

## 1. 概述

OpenClaw 采用 **Provider-agnostic** 架构，通过统一的 API 适配层支持 20+ 个 AI 模型提供商。系统通过 `api` 字段区分底层协议类型，实现一套代码对接多种 LLM API。

## 2. 支持的 API 协议

| 协议 | 标识 | 说明 |
|------|------|------|
| **Anthropic Messages** | `anthropic-messages` | Anthropic Claude API 格式 |
| **OpenAI Completions** | `openai-completions` | OpenAI Chat Completions 格式 |
| **Ollama** | `ollama` | Ollama 本地模型 API |

大多数提供商都兼容以上三种协议之一，系统自动处理协议差异。

## 3. 支持的提供商

### 3.1 主流商业提供商

| 提供商 | API 协议 | 特色 |
|--------|---------|------|
| **Anthropic (Claude)** | `anthropic-messages` | 官方 API，支持 Claude 全系列 |
| **OpenAI** | `openai-completions` | GPT 系列模型，支持 GPT-5.4（1,050,000 token 窗口） |
| **Google (Gemini)** | `openai-completions` | 支持 Gemini 3.1 Flash-Lite，模型 ID 自动规范化 |
| **GitHub Copilot** | 特殊 | Token 交换机制获取临时 API 密钥 |
| **Amazon Bedrock** | 特殊 | AWS SDK 认证，支持模型发现 |

### 3.2 中国区提供商

| 提供商 | API 协议 | Base URL |
|--------|---------|----------|
| **MiniMax** | `anthropic-messages` | `https://api.minimax.io/anthropic` |
| **Moonshot (Kimi)** | `openai-completions` | `https://api.moonshot.ai/v1` |
| **Kimi Coding** | `anthropic-messages` | `https://api.kimi.com/coding/` |
| **Qwen Portal** | `openai-completions` | 支持 OAuth |
| **Volcengine (豆包)** | `openai-completions` | 火山引擎 |
| **BytePlus** | `openai-completions` | 字节国际版 |
| **Xiaomi (MiMo)** | `anthropic-messages` | `https://api.xiaomimimo.com/anthropic` |
| **百度千帆** | `openai-completions` | `https://qianfan.baidubce.com/v2` |

### 3.3 本地/自托管

| 提供商 | 说明 | 特色 |
|--------|------|------|
| **Ollama** | 本地模型运行 | 自动发现（`/api/tags`），上下文窗口探测 |
| **vLLM** | 高性能推理服务器 | OpenAI 兼容，模型自动发现 |

### 3.4 其他云服务

| 提供商 | 说明 |
|--------|------|
| **OpenRouter** | 多模型路由聚合 |
| **Together AI** | 开源模型托管 |
| **Hugging Face** | 模型发现 |
| **Venice** | 隐私优先 AI |
| **NVIDIA NIM** | NVIDIA 推理服务 |
| **Cloudflare AI Gateway** | CDN 加速 AI 网关 |
| **Perplexity** | 搜索增强 AI（支持 Search API 模式切换） |

## 4. 提供商发现与配置

### 4.1 隐式发现

系统通过 `resolveImplicitProviders()` 函数自动发现可用提供商：

```
环境变量扫描:
  ANTHROPIC_API_KEY → Anthropic 提供商
  OPENAI_API_KEY    → OpenAI 提供商
  GOOGLE_API_KEY    → Google Gemini 提供商
  ...

本地服务探测:
  localhost:11434   → Ollama（/api/tags 列表模型）
  localhost:8000    → vLLM（/v1/models 列表模型）
```

### 4.2 显式配置

用户可在配置文件中显式定义提供商：

```yaml
providers:
  my-provider:
    baseUrl: "https://api.example.com/v1"
    api: "openai-completions"
    apiKey: "${MY_API_KEY}"   # 支持环境变量引用
    models:
      - id: "model-name"
        name: "Display Name"
        reasoning: false
        input: ["text", "image"]
        cost:
          input: 3.0
          output: 15.0
        contextWindow: 200000
        maxTokens: 8192
```

### 4.3 配置合并

系统支持隐式发现和显式配置的智能合并（`mergeProviderModels`），显式配置优先级更高。

## 5. 认证与密钥管理

### 5.1 密钥解析优先级

```
1. 配置文件中的 apiKey 字段
   ↓ (未设置)
2. 环境变量 (自动解析 ${ENV_VAR} 模式)
   ↓ (未设置)
3. Auth Profile Store (api_key / token 凭证)
   ↓ (未设置)
4. OAuth 占位符 (MiniMax Portal / Qwen Portal)
   ↓ (未设置)
5. AWS SDK 认证模式 (Bedrock)
```

### 5.2 Auth Profile Store

系统维护一个认证 Profile 存储（`ensureAuthProfileStore`），支持：
- `api_key` 类型凭证（直接 API Key）
- `token` 类型凭证（OAuth Token）
- 自动刷新/过期管理

### 5.3 特殊认证

- **GitHub Copilot**: 通过 Token 交换机制获取临时 API 密钥（`src/providers/github-copilot-token.ts`）
- **MiniMax/Qwen**: 支持 Portal OAuth 流程
- **Amazon Bedrock**: 通过 AWS SDK 标准凭证链

### 5.4 认证扩展

通过插件系统支持额外的认证提供商：
- `google-gemini-cli-auth` — Google Gemini CLI 认证
- `minimax-portal-auth` — MiniMax Portal OAuth
- `qwen-portal-auth` — 通义千问 Portal OAuth

## 6. 提供商使用量跟踪

系统为主要提供商实现了独立的使用量获取逻辑：

| 文件 | 提供商 |
|------|--------|
| `src/infra/provider-usage.fetch.claude.ts` | Anthropic Claude |
| `src/infra/provider-usage.fetch.codex.ts` | OpenAI Codex |
| `src/infra/provider-usage.fetch.copilot.ts` | GitHub Copilot |
| `src/infra/provider-usage.fetch.gemini.ts` | Google Gemini |
| `src/infra/provider-usage.fetch.minimax.ts` | MiniMax |
| `src/infra/provider-usage.fetch.zai.ts` | zAI |

## 7. 模型目录

### 7.1 模型配置结构

```typescript
{
  id: string;               // 模型标识符
  name: string;             // 显示名称
  reasoning: boolean;       // 是否支持推理模式
  input: string[];          // 输入类型: ["text"] 或 ["text", "image"]
  cost: {
    input: number;          // 每百万 token 输入费用
    output: number;         // 每百万 token 输出费用
    cacheRead: number;      // 缓存读取费用
    cacheWrite: number;     // 缓存写入费用
  };
  contextWindow: number;    // 上下文窗口大小
  maxTokens: number;        // 最大输出 token 数
}
```

### 7.2 模型发现

- **Ollama**: 通过 `/api/tags` 端点列出本地模型，自动探测上下文窗口大小
- **vLLM**: 通过 `/v1/models` 端点列出可用模型
- **Hugging Face**: 支持模型列表发现
- **Google Gemini**: 模型 ID 自动规范化（如 `gemini-3-pro` → `gemini-3-pro-preview`）

### 7.3 最新模型支持

- **GPT-5.4**: 前向兼容，支持 1,050,000 token 上下文窗口
- **Gemini 3.1 Flash-Lite**: Google 轻量模型
- **Session 级模型覆盖**: 支持在会话级别切换模型/提供商

## 8. OpenAI 兼容 HTTP 端点

Gateway 提供 `POST /v1/chat/completions` 端点，实现 OpenAI API 兼容：

- 支持流式 SSE 响应
- 支持多模态输入（图片）
- 默认 20MB body 限制
- 通过 `agentCommandFromIngress()` 桥接到内部 Agent 引擎

这意味着任何支持 OpenAI API 的客户端（如 Cursor、Continue、VS Code 等 IDE）都可以直接连接 OpenClaw Gateway，将其作为统一的 AI 代理网关使用。
