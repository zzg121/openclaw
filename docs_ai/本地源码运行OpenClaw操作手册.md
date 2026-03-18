# 基于本地源码运行 OpenClaw 操作手册

> 基于 OpenClaw v2026.3.8 源码，在 Linux (TencentOS) 环境下的完整操作指南。
> 本手册总结自实际部署经验，包含踩坑记录和解决方案。

---

## 目录

- [一、环境要求](#一环境要求)
- [二、清理旧版数据](#二清理旧版数据)
- [三、安装依赖工具](#三安装依赖工具)
- [四、编译构建](#四编译构建)
- [五、初始化配置（onboard）](#五初始化配置onboard)
- [六、手动配置模型（推荐）](#六手动配置模型推荐)
- [七、启动运行](#七启动运行)
- [八、常用命令速查](#八常用命令速查)
- [九、常见问题与排查](#九常见问题与排查)
- [十、插件管理](#十插件管理)

---

## 一、环境要求

| 依赖         | 最低版本      | 说明                             |
| ------------ | ------------- | -------------------------------- |
| **Node.js**  | ≥ 22.12.0     | 推荐 v24.x，使用 nvm/fnm 管理    |
| **pnpm**     | 10.23.0       | 项目指定版本，其他版本可能不兼容 |
| **Git**      | 任意          | 用于获取源码                     |
| **操作系统** | Linux / macOS | Windows 需 WSL2                  |

### 检查 Node.js

```bash
node --version
# 输出应 ≥ v22.12.0
```

如果 Node.js 不在 PATH 中（如 miniconda 自带的），需要确认其路径：

```bash
# miniconda 自带的 node 示例
which node
# 或手动查找
find ~ -maxdepth 5 -name "node" -type f 2>/dev/null
```

> **提示**：miniconda3 自带的 Node.js v24.x 可以满足要求。

---

## 二、清理旧版数据

如果之前安装过旧版 OpenClaw（名为 `clawdbot` 或 `openclaw`），需要先清理：

### 2.1 检查旧版状态

```bash
# 检查是否有旧版进程在运行
ps aux | grep -E "openclaw|clawdbot|moltbot" | grep -v grep

# 检查旧版数据目录
ls -la ~/.clawdbot/ 2>/dev/null   # 旧版 clawdbot
ls -la ~/.openclaw/ 2>/dev/null   # 新版 openclaw

# 检查是否有全局安装
which openclaw 2>/dev/null
npm list -g openclaw 2>/dev/null
```

### 2.2 停止旧版进程

```bash
# 如果有运行中的进程，先停止
pkill -f "openclaw" 2>/dev/null
pkill -f "clawdbot" 2>/dev/null
```

### 2.3 备份旧配置（保留 API Key）

```bash
# 备份旧版 clawdbot 配置
cp ~/.clawdbot/clawdbot.json ~/clawdbot_old_config_backup.json 2>/dev/null

# 备份旧版 openclaw 配置
cp ~/.openclaw/openclaw.json ~/openclaw_old_config_backup.json 2>/dev/null
```

### 2.4 清理旧数据

```bash
# 清理旧版 clawdbot 数据
rm -rf ~/.clawdbot/

# 如需全新安装，也清理 openclaw 数据
rm -rf ~/.openclaw/

# 清理全局安装（如有）
npm uninstall -g openclaw 2>/dev/null
npm uninstall -g clawdbot 2>/dev/null
```

---

## 三、安装依赖工具

### 3.1 安装 pnpm

```bash
# 使用 npm 安装指定版本
npm install -g pnpm@10.23.0

# 验证
pnpm --version
# 应输出: 10.23.0
```

### 3.2 进入项目目录并安装依赖

```bash
cd /data/home/zarekzhang/work/code/openclaw_all/openclaw

# 安装所有依赖（约 1245 个包，39 个 workspace 项目）
pnpm install
```

> **注意**：首次安装可能需要几分钟，取决于网络状况。如有部分 native 包（如 sharp）编译失败，通常不影响核心功能。

---

## 四、编译构建

### 4.1 完整构建

```bash
cd /data/home/zarekzhang/work/code/openclaw_all/openclaw

# 第一步：编译 TypeScript + 生成 plugin-sdk DTS + hook 元数据 + HTML 模板
pnpm build

# 第二步：构建控制台 Web UI（Vite 构建）
pnpm ui:build
```

### 4.2 验证构建结果

```bash
# 检查版本
node openclaw.mjs --version
# 应输出类似: openclaw v2026.3.8 (c42dc0f)
```

### 4.3 后续增量编译

修改源码后不需要重新完整构建。使用 `pnpm dev` 或 `pnpm gateway:watch` 会自动增量编译。

---

## 五、初始化配置（onboard）

### 5.1 交互式向导

```bash
cd /data/home/zarekzhang/work/code/openclaw_all/openclaw

# 运行初始化向导（交互式配置模型、工作目录等）
pnpm openclaw onboard
```

向导会引导你完成：

- 选择运行模式（local / remote）
- 配置 Gateway 端口和认证
- 配置模型 Provider 和 API Key
- 设置 Agent 工作目录
- 选择是否安装为 Daemon 服务

### 5.2 常用 onboard 选项

```bash
# 指定工作目录
pnpm openclaw onboard --workspace /path/to/workspace

# 非交互模式（CI/CD 场景）
pnpm openclaw onboard --non-interactive

# 快速模式（最少提问）
pnpm openclaw onboard --flow quickstart

# 重置所有配置
pnpm openclaw onboard --reset

# 安装为系统守护进程
pnpm openclaw onboard --install-daemon
```

### 5.3 onboard 生成的配置

向导完成后，配置文件保存在 `~/.openclaw/openclaw.json`。

> ⚠️ **重要提醒**：onboard 向导在 `models.mode` 为 `"merge"` 模式下可能出现模型解析错误（详见[常见问题 Q1](#q1-unknown-model-错误)），建议使用手动配置方式。

---

## 六、手动配置模型（推荐）

> 如果 onboard 向导生成的模型配置有问题，推荐直接手动编辑配置文件。

### 6.1 配置文件位置

```
~/.openclaw/openclaw.json       # 全局配置（JSON5 格式）
~/.openclaw/agents/main/agent/  # Agent 级别配置
~/.openclaw/.env                # 环境变量（可选）
```

### 6.2 模型配置模板

编辑 `~/.openclaw/openclaw.json`，关键是 `models` 和 `agents` 部分：

```jsonc
{
  "models": {
    // ⚠️ 重点：使用 "replace" 而非 "merge"，避免内置模型干扰
    "mode": "replace",
    "providers": {
      // Provider 名称（自定义，用于 primary model 引用）
      "deepseek": {
        "baseUrl": "https://api.lkeap.cloud.tencent.com/v1",
        "apiKey": "sk-xxxxxx",
        "api": "openai-completions",
        "models": [
          {
            "id": "deepseek-v3.2",
            "name": "DeepSeek V3.2",
            "api": "openai-completions",
            "reasoning": true,
            "input": ["text"],
            "cost": {
              "input": 0,
              "output": 0,
              "cacheRead": 0,
              "cacheWrite": 0,
            },
            "contextWindow": 65536,
            "maxTokens": 16384,
          },
        ],
      },
    },
  },
  "agents": {
    "defaults": {
      "model": {
        // 格式：<provider名>/<model id>
        "primary": "deepseek/deepseek-v3.2",
      },
      "models": {
        "deepseek/deepseek-v3.2": {
          "alias": "DeepSeek",
        },
      },
      "workspace": "/data/home/zarekzhang/.openclaw/workspace",
    },
  },
}
```

### 6.3 mode: "replace" vs "merge" 的区别

| 模式        | 行为                                      | 推荐场景                            |
| ----------- | ----------------------------------------- | ----------------------------------- |
| `"replace"` | **只使用**你配置的 provider，忽略内置模型 | ✅ 使用自定义 API 端点              |
| `"merge"`   | 你的配置**合并到**内置 provider 列表中    | 使用官方 API（Anthropic/OpenAI 等） |

> ⚠️ 当使用 `"merge"` 模式时，如果 `agents.defaults.models` 中有不带 provider 前缀的模型 ID（如 `"deepseek-v3.2": {}`），系统可能将其错误匹配到内置 provider（如 `anthropic`），导致 `Unknown model: anthropic/deepseek-v3.2` 错误。

### 6.4 多 Provider 配置示例

```jsonc
{
  "models": {
    "mode": "replace",
    "providers": {
      "deepseek": {
        "baseUrl": "https://api.lkeap.cloud.tencent.com/v1",
        "apiKey": "sk-xxxxxx",
        "api": "openai-completions",
        "models": [
          {
            "id": "deepseek-v3.2",
            "name": "DeepSeek V3.2",
            "api": "openai-completions",
            "reasoning": true,
            "input": ["text"],
            "contextWindow": 65536,
            "maxTokens": 16384,
          },
        ],
      },
      "qwen": {
        "baseUrl": "http://taco.tencentyun.com:8080/v1",
        "apiKey": "your-api-key",
        "api": "openai-completions",
        "models": [
          {
            "id": "qwen-max",
            "name": "Qwen Max",
            "api": "openai-completions",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 32768,
            "maxTokens": 8192,
          },
        ],
      },
    },
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "deepseek/deepseek-v3.2",
      },
      "models": {
        "deepseek/deepseek-v3.2": { "alias": "DS" },
        "qwen/qwen-max": { "alias": "Qwen" },
      },
    },
  },
}
```

### 6.5 同步更新 Agent 模型配置

修改全局配置后，Agent 级别的 `models.json` 也需要同步更新：

```bash
# 编辑 agent 级别的模型配置
cat > ~/.openclaw/agents/main/agent/models.json << 'EOF'
{
  "deepseek/deepseek-v3.2": {
    "alias": "DeepSeek"
  }
}
EOF
```

### 6.6 使用 .env 文件配置 API Key（可选）

也可以将 API Key 放在环境变量文件中，而非 JSON 配置：

```bash
# 复制示例
cp .env.example ~/.openclaw/.env

# 编辑，填入你的 API Key
vi ~/.openclaw/.env
```

---

## 七、启动运行

### 7.1 启动方式一览

```bash
cd /data/home/zarekzhang/work/code/openclaw_all/openclaw
```

| 命令                    | 用途                 | 特点                         |
| ----------------------- | -------------------- | ---------------------------- |
| `pnpm dev`              | **开发模式**（推荐） | 自动增量编译 + 重启          |
| `pnpm gateway:watch`    | Watch 模式           | 文件变化自动重新编译重启     |
| `pnpm gateway:dev`      | 纯 API 模式          | 跳过渠道连接，只启动 Gateway |
| `pnpm openclaw gateway` | 直接启动 Gateway     | 正式运行                     |
| `pnpm tui`              | TUI 终端界面         | 交互式终端 UI                |

### 7.2 推荐的开发启动流程

```bash
# 终端 1：启动服务
cd /data/home/zarekzhang/work/code/openclaw_all/openclaw
pnpm dev

# 终端 2：查看日志
cd /data/home/zarekzhang/work/code/openclaw_all/openclaw
pnpm openclaw logs --follow

# 终端 3：发送测试消息
cd /data/home/zarekzhang/work/code/openclaw_all/openclaw
pnpm openclaw status
```

### 7.3 环境变量说明

可以通过环境变量控制启动行为：

```bash
# 跳过渠道连接（纯 API 调试）
OPENCLAW_SKIP_CHANNELS=1 pnpm dev

# 指定配置文件路径
OPENCLAW_CONFIG_PATH=/path/to/config.json pnpm dev

# 指定数据目录
OPENCLAW_HOME=/path/to/data pnpm dev

# 指定 Gateway 端口
OPENCLAW_GATEWAY_PORT=18789 pnpm dev
```

---

## 八、常用命令速查

> ⚠️ **重要**：基于源码运行时，所有 `openclaw` 命令都需要加 `pnpm` 前缀！

| 操作           | 命令                             |
| -------------- | -------------------------------- |
| 查看版本       | `pnpm openclaw --version`        |
| 查看状态       | `pnpm openclaw status`           |
| 查看日志       | `pnpm openclaw logs --follow`    |
| 启动 Gateway   | `pnpm openclaw gateway`          |
| 初始化向导     | `pnpm openclaw onboard`          |
| 重置配置       | `pnpm openclaw onboard --reset`  |
| 查看帮助       | `pnpm openclaw --help`           |
| 查看子命令帮助 | `pnpm openclaw <command> --help` |
| 编译项目       | `pnpm build`                     |
| 构建 UI        | `pnpm ui:build`                  |
| 运行测试       | `pnpm test`                      |
| 代码检查       | `pnpm check`                     |

### 创建全局快捷命令（可选）

如果希望像全局安装一样直接使用 `openclaw` 命令：

```bash
# 方式一：添加 alias
echo 'alias openclaw="cd /data/home/zarekzhang/work/code/openclaw_all/openclaw && pnpm openclaw"' >> ~/.bashrc
source ~/.bashrc

# 方式二：创建 wrapper 脚本
cat > ~/.local/bin/openclaw << 'EOF'
#!/bin/bash
cd /data/home/zarekzhang/work/code/openclaw_all/openclaw
exec pnpm openclaw "$@"
EOF
chmod +x ~/.local/bin/openclaw
```

---

## 九、常见问题与排查

### Q1: `Unknown model: anthropic/deepseek-v3.2` 错误

**原因**：`models.mode` 设为 `"merge"` 时，内置的 anthropic provider 被合并进来。当 `agents.defaults.models` 中有不带 provider 前缀的裸模型 ID（如 `"deepseek-v3.2": {}`），系统错误地将其匹配到 `anthropic` provider。

**解决**：

1. 将 `models.mode` 改为 `"replace"`
2. 确保 `agents.defaults.models` 中的所有模型 ID 都带有完整的 `<provider>/<model>` 前缀
3. 清理无效的裸模型引用

```bash
vi ~/.openclaw/openclaw.json
# 修改 "mode": "merge" → "mode": "replace"
# 修改所有裸模型 ID 为完整格式：deepseek/deepseek-v3.2
```

### Q2: `bash: openclaw: command not found`

**原因**：从源码运行时没有全局安装 `openclaw` 命令。

**解决**：使用 `pnpm openclaw` 代替 `openclaw`，或参考[第八节](#创建全局快捷命令可选)创建快捷方式。

### Q3: `pnpm: command not found`

**原因**：pnpm 未安装或不在 PATH 中。

**解决**：

```bash
npm install -g pnpm@10.23.0
# 如果 npm 也找不到，先确认 node 路径
which node
```

### Q4: 构建失败 `Cannot find module 'tsdown'`

**原因**：依赖未安装。

**解决**：

```bash
cd /data/home/zarekzhang/work/code/openclaw_all/openclaw
pnpm install
pnpm build
```

### Q5: Gateway 启动后无法连接

**排查步骤**：

```bash
# 1. 检查 Gateway 是否在运行
pnpm openclaw status

# 2. 检查日志
pnpm openclaw logs --tail 50

# 3. 检查端口占用
ss -tlnp | grep 18789

# 4. 检查配置中的 gateway 部分
cat ~/.openclaw/openclaw.json | grep -A10 '"gateway"'
```

### Q6: 更新源码后如何重新构建

```bash
cd /data/home/zarekzhang/work/code/openclaw_all/openclaw

# 拉取最新代码
git pull

# 重新安装依赖（如有新包）
pnpm install

# 重新构建
pnpm build
pnpm ui:build
```

### Q7: 切换/添加新的模型 Provider

编辑 `~/.openclaw/openclaw.json`，在 `models.providers` 中添加新的 provider 配置（参考[第六节](#64-多-provider-配置示例)），然后重启 Gateway。

---

## 十、插件管理

### 10.1 插件目录

| 类型               | 路径                                 | 说明                             |
| ------------------ | ------------------------------------ | -------------------------------- |
| **Bundled 插件**   | `项目根/extensions/`                 | 随源码一起编译，开发模式自动加载 |
| **全局已安装插件** | `~/.openclaw/extensions/`            | 通过 install 命令安装            |
| **配置指定路径**   | `openclaw.json → plugins.load.paths` | 手动指定加载路径                 |

### 10.2 开发模式加载本地插件

开发模式下（`pnpm dev`），`extensions/` 目录中的插件会被自动发现和加载。如果你在开发一个新插件：

```bash
# 将插件目录放到 extensions/ 下
ls extensions/memory-tdai/    # 示例：记忆插件

# 使用 --link 安装模式（不复制文件，直接引用源码）
pnpm openclaw plugin install --link /path/to/your-plugin
```

### 10.3 使用 jiti 动态加载

OpenClaw 使用 `jiti` 动态加载 TypeScript，插件**无需预编译**即可在开发模式下运行。

---

## 附录：目录结构速览

```
~/.openclaw/                   # 用户数据目录
├── openclaw.json              # 全局配置文件
├── .env                       # 环境变量（可选）
├── agents/                    # Agent 数据
│   └── main/
│       ├── agent/
│       │   └── models.json    # Agent 级别模型配置
│       └── sessions/          # 会话记录
├── extensions/                # 已安装的插件
├── workspace/                 # Agent 工作目录
└── logs/                      # 日志文件

<项目根>/openclaw/             # 源码目录
├── openclaw.mjs               # CLI 入口（bootstrap）
├── package.json               # 项目配置
├── .env.example               # 环境变量模板
├── src/                       # TypeScript 源码
├── dist/                      # 编译产出
├── extensions/                # Bundled 插件
├── scripts/                   # 构建/开发脚本
└── ui/                        # Web 控制台 UI
```

---

## 附录：当前机器环境参考

| 项目          | 值                                                      |
| ------------- | ------------------------------------------------------- |
| OS            | TencentOS Linux                                         |
| Node.js       | v24.13.0（miniconda3 自带）                             |
| pnpm          | 10.23.0                                                 |
| OpenClaw 版本 | v2026.3.8 (c42dc0f)                                     |
| 源码路径      | `/data/home/zarekzhang/work/code/openclaw_all/openclaw` |
| 配置路径      | `~/.openclaw/openclaw.json`                             |
| Gateway 端口  | 18789                                                   |
| 主模型        | `deepseek/deepseek-v3.2`（腾讯云 LKEAP）                |
