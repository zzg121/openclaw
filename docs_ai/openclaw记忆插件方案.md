# OpenClaw memory-smart 插件设计与实现方案 (v2)

## 一、设计背景

### 1.1 参考项目核心能力提炼

| 项目 | 借鉴点 | 不采纳的部分 |
|------|--------|-------------|
| **agent_memory** | L0→L1 结构化提取的 prompt 设计（extract_memory/extract_persona）、智能去重 4 决策（store/update/merge/skip）、judge_memory_merge prompt | CrewAI Agent 编排、Python 生态、多租户实例管理、Shark 远端服务 |
| **memory-tdai** | L2 Scene Blocks（场景日记）+ L3 Persona（用户画像）的分层模型、ExtractionScheduler 调度机制、auto-recall/auto-capture 钩子模式、场景文件 META 格式 | 云端 TDAI API 强依赖、LLM Agent 做文件操作（改用结构化输出）、token overlap 场景匹配（改用 memory-core 搜索） |
| **memory-core** | 完整的 SQLite + FTS5 BM25 + embedding + MMR + 时间衰减搜索栈 | 只读（无自动写入） |

### 1.2 核心需求

1. **简单** — 零外部依赖，复用 OpenClaw 核心基础设施
2. **稳定可靠** — 不依赖原生绑定、不依赖云端服务、LLM 调用稳定可控
3. **有一定提升** — 相比现有 memory-core 只读方案，增加自动学习能力和多层记忆提炼
4. **方便升级** — 模块化设计，各层独立演进，预留云端扩展点

---

## 二、四层记忆架构

### 2.1 总览

```
┌─────────────────────────────────────────────────────────────────────┐
│ L0: 原始记录 (Raw Conversation)                                      │
│ 来源: 插件在 agent_end 钩子中直接获取当前对话的 user/assistant 消息    │
│ 存储: memory/auto/conversations/<sessionId>.jsonl           │
│ 格式: JSONL，包含 sessionId、timestamp、过滤后的 user/assistant 消息   │
│ 说明: 直接从钩子上下文获取对话内容，不读取系统 session 文件             │
├─────────────────────────────────────────────────────────────────────┤
│ L1: 结构化记忆 (Structured Memories)          ↑ LLM 提取              │
│ 来源: 从 L0 对话记录中提取的结构化记忆碎片                            │
│ 存储: memory/auto/memories/*.jsonl  (JSONL，每行一条记忆)              │
│ 索引: 由 memory-core 自动索引（FTS5 + embedding + MMR）              │
├─────────────────────────────────────────────────────────────────────┤
│ L2: 情景记忆 (Scene Blocks)                   ↑ LLM 提炼              │
│ 来源: 从 L1 记忆碎片中提炼的场景叙事                                  │
│ 存储: memory/auto/scenes/*.md  (≤20 个场景文件，含 META 头)           │
│ 检索: 不做独立向量检索，由 L3 画像中嵌入的摘要+地址引导 Agent 按需渐进式读取 │
├─────────────────────────────────────────────────────────────────────┤
│ L3: 画像记忆 (Persona)                        ↑ LLM 合成              │
│ 来源: 从 L2 场景 + L1 记忆合成的用户画像                              │
│ 存储: memory/auto/persona.md  (单一文件)                             │
│ 包含: 画像正文 + L2 场景摘要导航（文件名+摘要+地址）                  │
│ 注入: before_agent_start 钩子自动注入到 Agent 上下文                  │
│ 披露: Agent 根据 L3 中的场景导航，判断是否调用工具读取 L2 原文         │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流

```
用户对话
    │
    ▼ [agent_end 钩子：获取当前对话的 user/assistant 消息]
L0: 写入 memory/auto/conversations/<sessionId>.jsonl （插件独立存储，更可控）
    │                               （消毒 + 长度过滤）
    │
    ▼ [agent_end 钩子：通知 Scheduler，检查 conversation_count_since_l1 >= l1ExtractionEveryN → 读取 L0 JSONL → LLM 提取；]
      [Scheduler：未抽取时长超过阈值 → 读取 L0 JSONL → LLM 提取；]
L1: extract_structured_memories(对话) → memories/*.jsonl
    │     ↓ 追加 JSONL 记录 → memory-core 自动索引
    │
    ▼ [ExtractionScheduler: conversation_count_since_extraction >= sceneExtractionEveryN 时触发]
L2: extract_scenes(近期 L1 记忆) → scenes/*.md
    │     ↓ 写入场景文件（不做独立向量检索，由 L3 导航引用）
    │
    ▼ [PersonaTrigger: memories_since_last_persona >= personaThreshold AND conversation_count_since_persona >= personaMinConversations 时触发]
L3: generate_persona(变化的 L2 场景) → persona.md（包含场景摘要导航）
          ↓ 写入画像文件（含 L2 场景导航索引，Agent 可按需读取 L2 原文）

═══════════════════════════════════════════════════════════════════════
下次对话开始（Auto-Recall 流程 — 渐进式披露）:
═══════════════════════════════════════════════════════════════════════

用户输入新一轮 prompt
    │
    ▼ [before_agent_start 钩子触发]
    │
    ├─① 读取 L3 画像（含场景导航）, 渐进式按需读取L2 ──────────────────────────────────
    │   读取 memory/auto/persona.md
    │   ├─ 文件存在 → 整段包裹为 <user-persona>...</user-persona> 加入系统提示词
    │   │             画像末尾包含 <scene-navigation> 场景摘要列表，Agent 可根据摘要判断是否需要读取 L2 原文
    │   │             
    │   └─ 文件不存在（冷启动期） → 跳过，不注入画像
    │
    ├─② 搜索 L1 相关记忆 ─────────────────────────────────────────
    │   以用户 prompt 为查询（长度 ≥ 5 字符才触发），
    │   调用 memory-core 混合搜索（FTS5 BM25 + embedding 向量 + MMR 去冗余 + 时间衰减）
    │   ├─ 命中 → 取 top-K 条（默认 recallTopK=5），
    │   │         逐条列出，包裹为 <relevant-memories>- 记忆内容</relevant-memories>
    │   └─ 无命中 或 prompt 太短 → 跳过
    │
    ▼ 组装注入上下文
    将上述 ①② 的输出按顺序拼接（画像含场景导航 → 记忆碎片），
    通过 prependContext 注入到 Agent 的系统上下文中：

    ┌─────────────────────────────────────────────────────────────────┐
    │  注入到 Agent 上下文的内容示例：                                  │
    │                                                                 │
    │  <user-persona>                                                 │
    │  # User Profile                                                 │
    │  > Archetype: 追求技术成长的后端工程师...                        │
    │  [完整画像内容]                                                  │
    │                                                                 │
    │  ## Scene Navigation                                            │
    │  以下是已积累的场景记忆摘要。如果当前对话与某个场景相关，         │
    │  可使用 memory_scene_read 工具读取完整场景内容。                  │
    │  - [后端开发技术栈] 用户是后端工程师，主要使用 Python 和 Go      │
    │  - [运动与健身] 用户喜欢打篮球，周末去健身房                      │
    │  - [旅行偏好] 用户喜欢东南亚海岛游，偏好自由行                    │
    │  </user-persona>                                                │
    │                                                                 │
    │  <relevant-memories>                                            │
    │  - 用户正在学习机器学习，计划明年参加深度学习课程                 │
    │  - 用户主要做后端开发，擅长 Python 和 Go                         │
    │  </relevant-memories>                                           │
    └─────────────────────────────────────────────────────────────────┘
    │
    ▼ Agent 开始处理用户请求（已携带记忆上下文）
    │
    ├─ Agent 判断：当前对话与"后端开发技术栈"场景相关
    │  → 调用 memory_scene_read("后端开发技术栈") 读取 L2 完整场景
    │  → 获得详细的技术栈偏好、学习历程等
    │
    └─ Agent 判断：与"旅行偏好"不相关 → 不读取，节省 token
```

### 2.3 关键设计原则

1. **以文件为存储介质** — 所有层级的数据都以文件形式存储在 `memory/auto/` 目录下，L1 JSONL 和 L2 Markdown 均由 memory-core 自动索引，用户可直接查看和编辑
2. **L0 直接获取** — 插件在 `agent_end` 钩子中直接从钩子上下文获取当前对话的 user/assistant 消息，独立记录为 JSONL 文件，不读取系统 session 文件
3. **不独占 memory 槽位** — `kind` 不设为 `"memory"`，与 memory-core 共存（smart 负责生成记忆并加入上下文，保留core做补充和兜底）
3. **LLM 调用可控** — 全部使用结构化输出（ JSONL mode），不使用 LLM Agent 做文件操作，每次调用有明确输入输出
4. **本地优先** — 短期不涉及云端服务，所有处理在本地完成
5. **渐进式披露** — L2 场景不做独立向量检索，而是在 L3 画像中嵌入场景摘要+地址，由 Agent 按需读取 L2 原文，避免注入过多无关上下文
6. **预留云端扩展** — 通过接口抽象，后续可接入云端向量搜索、云端记忆存储等

---

## 三、文件目录结构

### 3.1 运行时数据

```
~/.openclaw/agents/<agentId>/memory/auto/
├── conversations/               # L0: 对话原始记录（插件独立存储）
│   ├── <sessionId-1>.json
│   └── <sessionId-2>.json
├── memories/                    # L1: 结构化记忆（JSONL，每行一条记忆）
│   └── *.jsonl
├── scenes/                      # L2: 场景文件（Markdown + META 头）
│   ├── 后端开发技术栈.md
│   ├── 旅行偏好与经历.md
│   └── ... (≤20 个)
├── persona.md                   # L3: 用户画像（含场景导航索引）
└── .metadata/
    ├── checkpoint.json          # 持久化状态
    └── scene_index.json         # 场景索引
```

---

## 四、各层详细设计

### 4.1 L0: 对话记录独立存储 (`l0-recorder.ts`)

**触发时机**：`agent_end` 钩子

**职责**：在 `agent_end` 钩子中直接从钩子上下文获取当前对话的 user/assistant 消息，经过消毒和过滤后，写入 `memory/auto/conversations/<sessionId>.jsonl`。

**为什么从钩子上下文直接获取（而非读取系统 session 文件）**：
- `agent_end` 钩子的上下文中已包含当前对话的完整消息列表，无需额外读取文件
- 不依赖系统 `~/.openclaw/sessions/<sessionId>.jsonl` 的内部格式（后者可能随版本变化）
- 插件只需要 user/assistant 消息，钩子上下文中直接过滤即可
- 独立 JSONL 格式完全由插件控制，便于后续增加字段（如语言标记、对话质量评分等）
- L0 JSONL 可作为 L1 提取的稳定输入源

```typescript
// l0-recorder.ts
interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;  // epoch ms
}

interface L0ConversationRecord {
  sessionId: string;
  agentId: string;
  recordedAt: string;          // ISO 时间戳
  messageCount: number;
  messages: ConversationMessage[];
}

async function recordConversation(
  context: AgentEndContext,   // agent_end 钩子提供的上下文
  checkpoint: Checkpoint,
  autoDir: string
): Promise<ConversationMessage[]> {
  // 1. 从 context.messages 中获取当前对话的 user/assistant 消息
  // 2. 消毒：移除已注入的 <user-persona>/<relevant-memories> 等 XML 标签
  // 3. 过滤：跳过太短（<10 字符）、太长（>8000 字符）、命令（/ 开头）的消息
  // 4. 写入独立 JSONL 文件：memory/auto/conversations/<sessionId>.jsonl
  // 5. 更新 checkpoint.last_processed_timestamp
  // 返回过滤后的消息列表（供 L1 直接使用）

  const filtered = context.messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({ role: m.role, content: sanitize(m.content), timestamp: m.timestamp }))
    .filter(m => m.content.length >= 10 && m.content.length <= 8000 && !m.content.startsWith("/"));

  const outPath = path.join(autoDir, "conversations", `${context.sessionId}.jsonl`);
  const record: L0ConversationRecord = {
    sessionId: context.sessionId,
    agentId: checkpoint.agentId,
    recordedAt: new Date().toISOString(),
    messageCount: filtered.length,
    messages: filtered,
  };
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(record, null, 2));

  return filtered;
}
```

**L0 JSONL 文件示例**（`memory/auto/conversations/abc123.jsonl`）：

```json
{
  "sessionId": "abc123",
  "agentId": "default",
  "recordedAt": "2026-03-10T14:30:00.000Z",
  "messageCount": 4,
  "messages": [
    { "role": "user", "content": "我是王小明，30岁，在北京做后端开发", "timestamp": 1741614600000 },
    { "role": "assistant", "content": "你好王小明！很高兴认识你...", "timestamp": 1741614605000 },
    { "role": "user", "content": "我主要用 Python 和 Go，最近在学机器学习", "timestamp": 1741614700000 },
    { "role": "assistant", "content": "Python 和 Go 都是后端开发...", "timestamp": 1741614710000 }
  ]
}
```

**设计要点**：
- 直接从 `agent_end` 钩子上下文获取对话内容，零文件读取开销
- 独立存储，格式可控，不依赖系统 session 文件的内部格式
- 通过 checkpoint 中的 `last_processed_timestamp` 实现增量处理
- L0 文件按 `l0RetentionDays` 配置自动清理过期记录

### 4.2 L1: 结构化记忆提取

#### 4.2.1 提取器 (`l1-extractor.ts`)

**触发时机**：在 `agent_end` 钩子中，当 `checkpoint.conversation_count_since_l1 >= config.l1ExtractionEveryN` 时执行（默认 `l1ExtractionEveryN=1`，即每次对话触发）。提取完成后重置计数器。

**核心逻辑**：借鉴 agent_memory 的 `extract_memory` / `extract_persona` prompt，大幅简化为单次 LLM 调用。

```typescript
// l1-extractor.ts
interface ExtractedMemory {
  content: string;        // 记忆内容
  type: MemoryType;       // identity | preference | instruction | event
  importance: "high" | "medium" | "low";
  keywords: string[];
}

type MemoryType = "identity" | "preference" | "instruction" | "event";

async function extractMemories(
  messages: ConversationMessage[],
  runtime: PluginRuntime
): Promise<ExtractedMemory[]> {
  if (messages.length === 0) return [];

  // 只取最近 N 条消息（控制 token 消耗，默认 10 条）
  const recentMessages = messages.slice(-10);

  // 使用 runtime.subagent.run 做单次结构化提取
  const result = await runtime.subagent.run({
    systemPrompt: EXTRACT_MEMORIES_SYSTEM_PROMPT,
    prompt: formatExtractionPrompt(recentMessages),
    maxTokens: 2000,
    responseFormat: { type: "json_object" },
  });

  return parseExtractionResult(result);
}
```

**提取 Prompt**（精简自 agent_memory 的 `extract_memory` + `extract_persona`）：

```typescript
// prompts.ts — EXTRACT_MEMORIES_SYSTEM_PROMPT
const EXTRACT_MEMORIES_SYSTEM_PROMPT = `You are a memory extraction expert. Extract valuable long-term information from conversations.

## Memory Types

1. **identity** — Personal facts: name, age, occupation, location, family, skills
2. **preference** — Stable preferences: likes/dislikes, habits, communication style, values  
3. **instruction** — Cross-session directives: "always respond in Chinese", "keep answers brief"
4. **event** — Significant events: plans, decisions, milestones, experiences

## Extraction Rules

- Only extract information that remains valid beyond the current conversation
- Each memory must be self-contained and understandable without context
- Do NOT extract: greetings, temporary queries, one-time requests, assistant's own outputs
- Do NOT extract from assistant messages (role=assistant) — focus on user messages only
- If a question reveals a preference or fact, extract the fact (e.g., "Do you have a dark mode?" → skip; "I always use dark mode" → extract)
- Merge related info from multiple messages into one memory when possible
- Keywords should be accurate for future retrieval

## Filter Rules

- Skip messages shorter than 15 characters
- Skip pure questions without factual content
- Skip time-specific events with ephemeral verbs ("bought yesterday", "just ordered")
- When uncertain if something is a long-term preference vs one-time statement, skip it

## Output Format

Return a JSON object:
{
  "memories": [
    {
      "content": "Complete memory description",
      "type": "identity|preference|instruction|event",
      "importance": "high|medium|low",
      "keywords": ["keyword1", "keyword2"]
    }
  ]
}

Return {"memories": []} if nothing worth extracting.`;
```

#### 4.2.2 智能去重 (`l1-dedup.ts`)

**借鉴 agent_memory 的 4 决策模型**，但大幅简化实现：

```typescript
// l1-dedup.ts
type DedupAction = "store" | "update" | "merge" | "skip";

interface DedupDecision {
  action: DedupAction;
  reason: string;
  mergedContent?: string;  // merge 时使用
}

async function dedup(
  memory: ExtractedMemory,
  api: OpenClawPluginApi,
  runtime: PluginRuntime
): Promise<DedupDecision> {
  // 1. 使用 memory-core 的搜索能力查找相似记忆
  const searchTool = api.runtime.tools.createMemorySearchTool({ config, agentSessionKey });
  if (!searchTool) return { action: "store", reason: "No search tool available" };

  const result = await searchTool.execute("dedup", {
    query: memory.content,
    maxResults: 3,
    minScore: 0.7,
  });
  const parsed = JSON.parse(result.content[0].text);
  const candidates = parsed.results ?? [];

  if (candidates.length === 0) return { action: "store", reason: "No similar memories found" };

  // 2. 高相似度时用 LLM 判断（借鉴 agent_memory 的 judge_memory_merge）
  const decision = await runtime.subagent.run({
    systemPrompt: JUDGE_MEMORY_MERGE_SYSTEM_PROMPT,
    prompt: formatJudgePrompt(memory, candidates),
    maxTokens: 500,
    responseFormat: { type: "json_object" },
  });

  return parseJudgeResult(decision);
}
```

**去重 Prompt**（精简自 agent_memory 的 `judge_memory_merge`）：

```typescript
// prompts.ts — JUDGE_MEMORY_MERGE_SYSTEM_PROMPT
const JUDGE_MEMORY_MERGE_SYSTEM_PROMPT = `You are a memory deduplication expert. Compare a new memory against existing similar memories and decide the action.

## Actions

- **store**: New information, no significant overlap. Add as new memory.
- **skip**: Existing memory already covers this. New memory adds nothing.
- **update**: Same fact/event, but new memory is more recent, specific, or accurate. Replace the old one.
- **merge**: Complementary information about the same topic. Combine into one richer memory.

## Decision Guidelines

- For preferences/traits (stable info): prefer merge when complementary, skip when redundant
- For events (time-specific): prefer store unless clearly the same event, then update
- When uncertain, prefer store (preserve more information)

## Output Format

{
  "action": "store|update|merge|skip",
  "reason": "Brief explanation",
  "mergedContent": "Combined memory text (only for merge action)"
}`;
```

#### 4.2.3 写入器 (`l1-writer.ts`)

将提取的记忆追加到 JSONL 文件，供 memory-core 自动索引。

```typescript
// l1-writer.ts
interface MemoryRecord {
  id: string;            // 唯一 ID（用于去重更新）
  content: string;       // 记忆内容
  type: MemoryType;      // identity | preference | instruction | event
  importance: "high" | "medium" | "low";
  keywords: string[];
  createdAt: string;     // ISO 时间戳
  updatedAt: string;     // ISO 时间戳
  source: string;        // 来源 sessionId
}

async function writeMemory(
  memory: ExtractedMemory,
  decision: DedupDecision,
  autoDir: string,
  sessionId: string
): Promise<void> {
  const filePath = path.join(autoDir, "memories", `${sessionId}.jsonl`);

  if (decision.action === "skip") return;

  const content = decision.action === "merge"
    ? decision.mergedContent!
    : memory.content;

  const now = new Date().toISOString();
  const record: MemoryRecord = {
    id: generateId(),
    content,
    type: memory.type,
    importance: memory.importance,
    keywords: memory.keywords,
    createdAt: now,
    updatedAt: now,
    source: sessionId,
  };

  await fs.mkdir(path.dirname(filePath), { recursive: true });

  if (decision.action === "update" && decision.targetId) {
    // 读取整个 JSONL，替换匹配的记录，重写文件
    await updateMemoryRecord(filePath, decision.targetId, record);
  } else {
    // store 或 merge：追加一行
    await fs.appendFile(filePath, JSON.stringify(record) + "\n");
  }
}
```

**JSONL 格式示例**（`memory/auto/memories/session_abc.jsonl`）：

```jsonl
{"id":"m_001","content":"用户叫王小明，30岁，在北京工作，是一名软件工程师。","type":"identity","importance":"high","keywords":["王小明","北京","软件工程师"],"createdAt":"2026-03-09T14:23:00Z","updatedAt":"2026-03-09T14:23:00Z","source":"session_abc"}
{"id":"m_002","content":"用户喜欢打篮球，周末经常和朋友去健身房运动。","type":"preference","importance":"medium","keywords":["篮球","健身房","运动"],"createdAt":"2026-03-09T14:45:00Z","updatedAt":"2026-03-09T14:45:00Z","source":"session_abc"}
{"id":"m_003","content":"用户主要做后端开发，擅长 Python 和 Go。","type":"identity","importance":"high","keywords":["后端开发","Python","Go"],"createdAt":"2026-03-09T15:10:00Z","updatedAt":"2026-03-09T15:10:00Z","source":"session_abc"}
{"id":"m_004","content":"用户最近在学习机器学习，计划明年参加深度学习课程。","type":"event","importance":"medium","keywords":["机器学习","深度学习","课程"],"createdAt":"2026-03-09T15:30:00Z","updatedAt":"2026-03-09T15:30:00Z","source":"session_def"}
```

**JSONL vs Markdown 的优势**：
- 结构化：每条记忆有唯一 ID，方便去重时定点更新/删除
- 追加友好：JSONL 天然支持追加写入，不需要解析 Markdown 段落
- 机器可读：无需解析 Markdown 格式，直接 `JSON.parse` 每行
- memory-core 兼容：memory-core 的 QMD 索引器支持 JSONL 文件

### 4.3 L2: 情景记忆（Scene Blocks）

#### 4.3.1 调度器 (`l2-scheduler.ts`)

**借鉴 memory-tdai 的 ExtractionScheduler**，简化实现。

```typescript
// l2-scheduler.ts
interface SchedulerConfig {
  everyNConversations: number;  // 默认 5：每 5 轮对话触发一次
  minIntervalMs: number;        // 默认 5min：两次提取的最小间隔
  maxIntervalMs: number;        // 默认 30min：最大不提取间隔
}

class ExtractionScheduler {
  private conversationCount = 0;
  private lastExtractionTime = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  notify(): void {
    this.conversationCount++;
    if (this.conversationCount >= this.config.everyNConversations) {
      this.scheduleExtraction();
    }
  }

  private async runExtraction(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // 1. 读取 checkpoint，获取上次场景提取的游标
      // 2. 读取游标之后的 L1 记忆文件
      // 3. 调用 L2 场景提取
      // 4. 检查是否触发 L3 画像生成
      // 5. 更新 checkpoint
    } finally {
      this.running = false;
      this.conversationCount = 0;
      this.lastExtractionTime = Date.now();
    }
  }
}
```

#### 4.3.2 场景提取 (`l2-scene-extractor.ts`)

**核心改进（相比 memory-tdai）**：不使用 LLM Agent 做文件操作，改为**结构化 JSON 输出**，由代码执行文件操作。更稳定可控。

```typescript
// l2-scene-extractor.ts
interface SceneExtractionResult {
  actions: SceneAction[];
}

type SceneAction =
  | { type: "create"; filename: string; summary: string; content: string }
  | { type: "update"; filename: string; summary: string; content: string }
  | { type: "merge"; sourceFiles: string[]; targetFilename: string; summary: string; content: string };

async function extractScenes(
  memories: ExtractedMemory[],
  existingScenes: SceneIndexEntry[],
  runtime: PluginRuntime
): Promise<SceneExtractionResult> {
  // 构建 prompt：记忆列表 + 现有场景摘要
  const result = await runtime.subagent.run({
    systemPrompt: SCENE_EXTRACTION_SYSTEM_PROMPT,
    prompt: formatSceneExtractionPrompt(memories, existingScenes),
    maxTokens: 4000,
    responseFormat: { type: "json_object" },
  });

  return parseSceneExtractionResult(result);
}
```

**场景提取 Prompt**（借鉴 memory-tdai，精简并适配结构化输出）：

```typescript
// prompts.ts — SCENE_EXTRACTION_SYSTEM_PROMPT
const SCENE_EXTRACTION_SYSTEM_PROMPT = `You are a Memory Integration Architect. Your task is to organize fragmented memories into coherent scene blocks (thematic narratives about the user).

## Input
- New memories: recent L1 structured memories to integrate
- Existing scenes: summaries of current scene blocks (if any)

## Scene Block Guidelines
- Each scene block is a thematic narrative (e.g., "Career & Technical Skills", "Travel Preferences", "Daily Habits")
- Maximum 20 scene blocks total. If at limit, merge the two least relevant scenes before creating new ones
- Each scene should contain: user facts, core traits, preferences, key narrative (≤400 words)
- Scenes must be written in the user's language

## Decision Process
For each cluster of related new memories:
1. Check if an existing scene covers this topic → UPDATE that scene
2. If no existing scene matches → CREATE a new scene
3. If two existing scenes overlap significantly → MERGE them

## Output Format

{
  "actions": [
    {
      "type": "create|update|merge",
      "filename": "场景名称.md",
      "sourceFiles": ["file1.md", "file2.md"],  // only for merge
      "summary": "40-60 character summary for indexing",
      "content": "Full scene content in Markdown"
    }
  ]
}

Return {"actions": []} if no scene updates needed.

## Scene Content Template

Each scene should follow this structure:
## User Context
Brief factual background relevant to this scene.

## Key Traits & Preferences
- trait/preference 1
- trait/preference 2

## Core Narrative
Coherent narrative (≤400 words) describing the user's relationship with this topic.
Use Trigger→Action→Result pattern when describing events.

## Evolution & Open Questions
- Changes over time (if any)
- Unconfirmed or contradictory points`;
```

#### 4.3.3 场景文件格式 (`l2-scene-store.ts`)

**借鉴 memory-tdai 的 META 格式 + 热度管理**：

```markdown
<!-- scenes/后端开发技术栈.md -->
-----META-START-----
created: 2026-03-09 14:30:00
updated: 2026-03-10 09:15:00
summary: 用户是后端工程师，主要使用 Python 和 Go 开发
heat: 3
-----META-END-----

## User Context
用户是一名软件工程师，在北京工作，30岁。

## Key Traits & Preferences
- 主要做后端开发
- 擅长 Python 和 Go
- 正在学习机器学习

## Core Narrative
王小明是一名后端软件工程师，主要使用 Python 和 Go 进行开发。
近期对 AI 领域产生了浓厚兴趣，正在系统学习机器学习，
并计划明年参加深度学习的专业课程，向 AI 方向拓展职业发展。

## Evolution & Open Questions
- 从纯后端开发逐渐向 AI/ML 方向探索
```

场景索引文件（`.metadata/scene_index.json`）：

```json
[
  {
    "filename": "后端开发技术栈.md",
    "summary": "用户是后端工程师，主要使用 Python 和 Go 开发",
    "heat": 3,
    "created": "2026-03-09 14:30:00",
    "updated": "2026-03-10 09:15:00"
  }
]
```

**热度管理**（复用 memory-tdai 规则）：
- 新建：`heat = 1`
- 更新：`heat = oldHeat + 1`
- 合并：`heat = sum(sources) + 1`

### 4.4 L3: 画像记忆（Persona）

#### 4.4.1 触发器 (`l3-persona-trigger.ts`)

**4 个触发条件**（借鉴 memory-tdai，简化）：

| 优先级 | 条件 | 说明 |
|--------|------|------|
| P1 | 首次 Scene Block 提取完成 | 冷启动：有场景但无 persona |
| P2 | 场景文件变化数 ≥ 3 | 足够的新内容值得更新画像 |
| P3 | 距上次画像生成的记忆数 ≥ 阈值（默认 200） | 定期更新 |
| P4 | 用户通过工具主动请求 | `memory_persona_refresh` 工具 |

#### 4.4.2 画像生成 (`l3-persona-generator.ts`)

```typescript
// l3-persona-generator.ts
async function generatePersona(
  changedScenes: SceneBlock[],
  allScenes: SceneIndexEntry[],
  existingPersona: string | null,
  runtime: PluginRuntime
): Promise<string> {
  const mode = existingPersona ? "incremental" : "first";

  const result = await runtime.subagent.run({
    systemPrompt: PERSONA_GENERATION_SYSTEM_PROMPT,
    prompt: formatPersonaPrompt(mode, changedScenes, existingPersona),
    maxTokens: 3000,
  });

  const personaBody = result.trim();

  // 追加场景导航索引（渐进式披露的核心）
  const sceneNavigation = buildSceneNavigation(allScenes);
  return `${personaBody}\n\n${sceneNavigation}`;
}

function buildSceneNavigation(scenes: SceneIndexEntry[]): string {
  if (scenes.length === 0) return "";

  const lines = scenes
    .sort((a, b) => b.heat - a.heat)  // 按热度排序
    .map(s => `- **[${s.filename.replace(".md", "")}]** ${s.summary}  \n  _路径: memory/auto/scenes/${s.filename}_`);

  return `## Scene Navigation

以下是已积累的场景记忆摘要。如果当前对话与某个场景相关，
可使用 \`memory_scene_read\` 工具读取完整场景内容以获得更详细的上下文。

${lines.join("\n")}`;
}
```

**画像 Prompt**（借鉴 memory-tdai 的四层扫描模型）：

```typescript
// prompts.ts — PERSONA_GENERATION_SYSTEM_PROMPT
const PERSONA_GENERATION_SYSTEM_PROMPT = `You are a Persona Architect. Generate or update a comprehensive user profile from scene blocks.

## Four-Layer Deep Scan Model

🟢 Layer 1 — Anchor Facts: Demographics, occupation, current status, location
🔵 Layer 2 — Interest Graph: What the user invests time/money/attention in
🟡 Layer 3 — Interaction Protocol: Communication style, pet peeves, workflow preferences
🔴 Layer 4 — Cognitive Core: Decision logic, contradictions, ultimate motivations

## Output Template

# User Profile

> **Archetype**: [One-sentence definition]
> **Key Facts**: [Name, age, occupation, location — if known]

## Chapter 1: Context & Current State
[Full-picture context from Layer 1]

## Chapter 2: Interests & Daily Life
[From Layer 2: hobbies, routines, preferences]

## Chapter 3: Communication & Work Style
[From Layer 3: how they interact, what they expect]

## Chapter 4: Insights & Evolution
[From Layer 4: contradictions, growth trajectory, core traits]
- **Core Trait Tags**: [3-7 tags like #analytical #curious #practical]

## Update Rules (for incremental mode)

When updating an existing persona with new scene data:
1. **Reinforce** — Existing trait confirmed → refine wording
2. **Supplement** — New dimension discovered → add new section
3. **Correct** — Contradiction found → replace old description with note
4. **No change** — Scene adds nothing new → leave as is

⚠️ Never infer real names from file paths. All content must come from scene blocks only.
⚠️ Write in the user's language (match the scene content language).`;
```

**画像文件示例**（`memory/auto/persona.md`）：

```markdown
# User Profile

> **Archetype**: 追求技术成长的后端工程师，正在向 AI 领域转型
> **Key Facts**: 王小明，30岁，北京，软件工程师

## Chapter 1: Context & Current State
王小明是一名在北京工作的 30 岁软件工程师，主要从事后端开发。
当前正处于职业技能拓展期，在保持后端开发工作的同时积极学习机器学习。

## Chapter 2: Interests & Daily Life
热爱运动，经常打篮球，周末会和朋友一起去健身房。
日常工作使用 Python 和 Go 进行后端开发。
业余时间投入到机器学习的学习中，计划明年参加深度学习课程。

## Chapter 3: Communication & Work Style
[待更多对话数据积累后补充]

## Chapter 4: Insights & Evolution
- 职业轨迹：纯后端开发 → AI/ML 方向探索
- **Core Trait Tags**: #技术导向 #持续学习 #运动爱好者

## Scene Navigation

以下是已积累的场景记忆摘要。如果当前对话与某个场景相关，
可使用 `memory_scene_read` 工具读取完整场景内容以获得更详细的上下文。

- **[后端开发技术栈]** 用户是后端工程师，主要使用 Python 和 Go 开发
  _路径: memory/auto/scenes/后端开发技术栈.md_
- **[运动与健身]** 用户喜欢打篮球，周末去健身房锻炼
  _路径: memory/auto/scenes/运动与健身.md_
- **[旅行偏好与经历]** 用户喜欢东南亚海岛游，偏好自由行
  _路径: memory/auto/scenes/旅行偏好与经历.md_
```

### 4.5 Auto-Recall（渐进式披露记忆注入）

**触发时机**：`before_agent_start` 钩子

**核心理念 — 渐进式披露**：
- L3 画像（含场景导航）始终注入，作为 Agent 的基础用户认知
- L1 记忆碎片通过搜索匹配注入，提供与当前对话相关的细节
- L2 场景不主动注入，而是由 Agent 根据 L3 中的场景导航摘要，自主判断是否调用 `memory_scene_read` 工具读取完整场景
- 这样避免了注入大量无关场景内容，同时保留了 Agent 按需获取详细上下文的能力

```typescript
// recall.ts
async function autoRecall(
  event: BeforeAgentStartEvent,
  api: OpenClawPluginApi,
  config: SmartMemoryConfig
): Promise<{ prependContext: string } | void> {
  const parts: string[] = [];

  // 1. L3: 注入 Persona（含场景导航索引）
  //    画像末尾的 Scene Navigation 部分让 Agent 知道有哪些场景可以深入了解
  //    Agent 可根据摘要判断是否需要调用 memory_scene_read 读取 L2 原文
  const persona = await readPersonaFile(autoDir);
  if (persona) {
    parts.push(`<user-persona>\n${persona}\n</user-persona>`);
  }

  // 2. L1: 搜索相关记忆（使用 memory-core 的混合搜索）
  const searchTool = api.runtime.tools.createMemorySearchTool({ config, agentSessionKey });
  if (searchTool && event.prompt?.length >= 5) {
    const searchResult = await searchTool.execute("recall", {
      query: event.prompt,
      maxResults: config.recallTopK ?? 5,
    });
    const memories = JSON.parse(searchResult.content[0].text);
    if (memories.results?.length > 0) {
      const memList = memories.results
        .map((m: any) => `- ${m.text}`)
        .join("\n");
      parts.push(`<relevant-memories>\n${memList}\n</relevant-memories>`);
    }
  }

  // 注意：L2 场景不在此处主动注入
  // Agent 通过 L3 画像中的 Scene Navigation 了解可用场景
  // 如需详细信息，Agent 调用 memory_scene_read 工具按需读取

  if (parts.length === 0) return;
  return { prependContext: parts.join("\n\n") };
}
```

---

## 五、工具与 CLI

### 5.1 注册的工具

```typescript
// 1. memory_save — LLM 主动存储
{
  name: "memory_save",
  description: "Save important information to long-term memory. Use when user shares preferences, facts, decisions, or asks to remember something.",
  parameters: {
    text: { type: "string", description: "Memory content to save" },
    category: { type: "string", enum: ["identity", "preference", "instruction", "event"], optional: true }
  }
}

// 2. memory_forget — GDPR 删除
{
  name: "memory_forget",
  description: "Remove a specific memory entry. Use when user asks to forget something.",
  parameters: {
    query: { type: "string", description: "Description of the memory to remove" }
  }
}

// 3. memory_scene_read — 按需读取场景详情（渐进式披露）
{
  name: "memory_scene_read",
  description: "Read full scene content for deeper context. Use when the user-persona's Scene Navigation indicates a relevant scene for the current conversation. Only call this when you need more detailed context than the summary provides.",
  parameters: {
    scene: { type: "string", description: "Scene name from Scene Navigation (e.g., '后端开发技术栈')" }
  }
}

// 4. memory_persona_refresh — 主动刷新画像
{
  name: "memory_persona_refresh",
  description: "Refresh the user profile based on accumulated memories. Use when user asks to update their profile.",
  parameters: {}
}
```

### 5.2 CLI 命令

```
openclaw smart-memory list          # 列出所有记忆（L1 JSONL 条目）
openclaw smart-memory scenes        # 列出场景摘要
openclaw smart-memory persona       # 查看当前画像（含场景导航）
openclaw smart-memory prune [days]  # 清理指定天数前的 L0 对话记录
openclaw smart-memory stats         # 统计各层数据量
```

---

## 六、配置

```json
// openclaw.plugin.json
{
  "id": "memory-smart",
  "name": "Memory (Smart)",
  "description": "Four-layer memory system — auto-captures, structures, and profiles conversational knowledge",
  "configSchema": {
    "type": "object",
    "properties": {
      "autoCapture": {
        "type": "boolean",
        "default": true,
        "description": "Enable auto-capture of conversations (L0→L1)"
      },
      "l1ExtractionEveryN": {
        "type": "number",
        "default": 1,
        "minimum": 1,
        "description": "Run L1 memory extraction every N conversations (1 = every conversation, 3 = every 3rd conversation). Higher values reduce LLM cost at the expense of extraction freshness."
      },
      "maxMemoriesPerSession": {
        "type": "number",
        "default": 10,
        "description": "Max memories to extract per agent session"
      },
      "enableDedup": {
        "type": "boolean",
        "default": true,
        "description": "Enable smart deduplication (requires extra LLM call per memory)"
      },
      "sceneExtractionEveryN": {
        "type": "number",
        "default": 5,
        "minimum": 1,
        "description": "Run L2 scene extraction every N conversations (default 5). Higher values reduce LLM cost."
      },
      "maxScenes": {
        "type": "number",
        "default": 20,
        "description": "Maximum number of scene blocks"
      },
      "personaThreshold": {
        "type": "number",
        "default": 200,
        "minimum": 0,
        "description": "Number of new memories since last persona update to trigger L3 regeneration (0 = disabled)"
      },
      "personaMinConversations": {
        "type": "number",
        "default": 0,
        "minimum": 0,
        "description": "Minimum conversations since last persona update to allow L3 regeneration (0 = only check memory count). Works as an AND condition with personaThreshold."
      },
      "autoRecall": {
        "type": "boolean",
        "default": true,
        "description": "Auto-inject relevant memories before agent start"
      },
      "recallTopK": {
        "type": "number",
        "default": 5,
        "description": "Number of L1 memories to inject"
      },
      "l0RetentionDays": {
        "type": "number",
        "default": 30,
        "description": "Days to keep L0 raw conversation logs (0 = forever)"
      }
    }
  }
}
```

---

## 七、Checkpoint 持久化

```typescript
// checkpoint.ts
interface Checkpoint {
  // L0
  agentId: string;                       // Agent ID
  last_processed_timestamp: number;      // 最新已处理消息时间戳（用于增量处理）
  l0_conversations_count: number;        // 累计记录的 L0 对话文件数

  // L1
  total_memories_extracted: number;      // 累计提取的记忆数
  conversation_count_since_l1: number;   // 距上次 L1 提取的对话数（用于 l1ExtractionEveryN）

  // L2
  last_scene_extraction_time: string;   // ISO 时间戳
  last_scene_memory_cursor: string;     // 上次场景提取处理到的记忆 ID
  scenes_extracted_count: number;       // 场景提取执行次数
  conversation_count_since_extraction: number;  // 距上次 L2 提取的对话数

  // L3
  last_persona_time: string;            // ISO 时间戳
  memories_since_last_persona: number;  // 距上次画像生成的记忆数
  conversation_count_since_persona: number;  // 距上次画像生成的对话数（用于 personaMinConversations）
  persona_version: number;              // 画像版本号
}
```

---

## 八、LLM 调用开销分析

| 层级 | 触发频率 | 配置项 | 每次调用 | Token 估算 |
|------|---------|--------|---------|-----------|
| **L1 提取** | 每 N 次对话（默认 N=1） | `l1ExtractionEveryN` | 1 次 LLM | ~1500 in + ~500 out |
| **L1 去重** | 每条记忆 | `enableDedup` (开关) | 0-1 次 LLM（有相似才调用） | ~800 in + ~200 out |
| **L2 场景提取** | 每 N 次对话（默认 N=5） | `sceneExtractionEveryN` | 1 次 LLM | ~3000 in + ~2000 out |
| **L3 画像生成** | 偶发（默认 200 条记忆 AND N 次对话） | `personaThreshold` + `personaMinConversations` | 1 次 LLM | ~4000 in + ~2000 out |

**典型单次对话开销**（默认配置 `l1ExtractionEveryN=1`）：1 次 L1 提取 + 0~3 次去重 ≈ **~2000-5000 tokens**

**省 Token 示例**：设 `l1ExtractionEveryN=3`，则 3 次对话中只有 1 次触发 L1 提取，另外 2 次对话的 LLM 开销为 0，平均降低 ~66%。

**对比**：
- agent_memory：每次存储需要 N 次策略提取 + N 次去重 = 大量 LLM 调用（~20000+ tokens）
- memory-tdai：依赖云端 API + 后台 LLM Agent 场景提取（不可预估）
- **memory-smart**：可控且可配置，去重可选关闭进一步降低开销

---

## 九、可配置降级策略

| 配置 | 效果 | 适用场景 |
|------|------|---------|
| `autoCapture: false` | 关闭全自动，仅通过 `memory_save` 工具主动存储 | Token 预算极紧 |
| `l1ExtractionEveryN: 3` | 每 3 次对话才触发 1 次 L1 提取，平均降低 ~66% 提取开销 | Token 有限但仍需自动学习 |
| `l1ExtractionEveryN: 1` | 每次对话都提取（默认） | 对记忆实时性要求高 |
| `enableDedup: false` | 跳过去重，直接写入 | 减少 LLM 调用，容忍少量重复 |
| `sceneExtractionEveryN: 10` | 每 10 次对话才触发 L2 场景提炼 | 低频用户或 Token 预算有限 |
| `sceneExtractionEveryN: 999` | 实质上禁用 L2 | 只需要 L1 碎片记忆 |
| `personaThreshold: 0` | 禁用 L3 | 只需要 L1+L2 |
| `personaMinConversations: 50` | L3 画像生成额外要求至少 50 次对话间隔 | 避免画像更新过于频繁 |

---

## 十、云端扩展预留

当前方案完全本地化，但通过接口抽象预留云端扩展：

```typescript
// types.ts — 可扩展接口
interface MemoryStore {
  writeMemory(memory: ExtractedMemory, decision: DedupDecision): Promise<void>;
  searchSimilar(query: string, topK: number): Promise<SimilarMemory[]>;
}

interface SceneStore {
  readScenes(): Promise<SceneBlock[]>;
  writeScene(action: SceneAction): Promise<void>;
  readIndex(): Promise<SceneIndexEntry[]>;
}

interface PersonaStore {
  readPersona(): Promise<string | null>;
  writePersona(content: string): Promise<void>;
}

// 当前实现：LocalFileMemoryStore / LocalFileSceneStore / LocalFilePersonaStore
// 未来扩展：CloudMemoryStore（接入云端向量库）/ CloudSceneStore / CloudPersonaStore
```

未来接入云端时，只需：
1. 实现 `Cloud*Store` 类
2. 在配置中添加 `backend: "local" | "cloud"` 选项
3. 在 `index.ts` 中根据配置选择实现

---

## 十一、对比总览

| 维度 | memory-core | memory-lancedb | memory-tdai | agent_memory | **memory-smart** |
|------|-------------|----------------|-------------|-------------|------------------|
| 自动学习 | ❌ | ✅ (正则) | ✅ (LLM) | ✅ (CrewAI) | **✅ (LLM)** |
| 记忆分层 | 1层 | 1层 | 3层 (L1/L2/L3) | 1层+情境 | **4层 (L0/L1/L2/L3)** |
| 搜索质量 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | **⭐⭐⭐⭐⭐ (复用core)** |
| 外部依赖 | 0 | 2 | 1 (TDAI API) | 多个 (Python) | **0** |
| 离线可用 | ✅ | ✅ | ❌ | 部分 | **✅** |
| 用户画像 | ❌ | ❌ | ✅ | ❌ | **✅** |
| 场景提炼 | ❌ | ❌ | ✅ | ❌ | **✅** |
| 智能去重 | ❌ | ❌ | 有 | ✅ (4决策) | **✅ (4决策)** |
| 与 core 共存 | — | ❌ | ❌ | N/A | **✅** |
| 记忆可编辑 | ✅ (手动) | ❌ | 部分 | ❌ | **✅ (L1 JSONL + L2/L3 MD)** |
| 稳定性 | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | **⭐⭐⭐⭐** |
| LLM 开销 | 0 | 低 | 高 | 极高 | **可控(可配降级)** |

---

## 十二、开发计划

### Phase 1：L0+L1 最小可用（3 天）

1. 插件脚手架（`extensions/memory-smart/`）
2. L0 对话记录独立存储 (`l0-recorder.ts`)
3. L1 结构化提取 (`l1-extractor.ts` + `prompts.ts`)
4. L1 JSONL 写入 (`l1-writer.ts`)
5. `memory_save` / `memory_forget` 工具
6. 基础 auto-recall（L1 搜索注入）
7. 测试

### Phase 2：L1 去重 + L2 场景（2 天）

8. L1 智能去重 (`l1-dedup.ts`)
9. L2 调度器 (`l2-scheduler.ts`)
10. L2 场景提取 (`l2-scene-extractor.ts` + `l2-scene-store.ts`)

### Phase 3：L3 画像 + 渐进式披露 + 打磨（2 天）

11. L3 触发器 + 生成器 (`l3-persona-trigger.ts` + `l3-persona-generator.ts`)
12. L3 画像嵌入场景导航（Scene Navigation）
13. `memory_scene_read` 工具（渐进式披露的 Agent 端入口）
14. auto-recall 扩展（L3 画像含场景导航注入）
15. Checkpoint 持久化完善
16. CLI 命令
17. 配置 UI hints

### Phase 4：优化（持续）

17. Prompt 迭代调优
18. L0 自动清理（按 l0RetentionDays）
19. 云端扩展接口实现（按需）

---

## 十三、风险与缓解

| 风险 | 级别 | 缓解措施 |
|------|------|----------|
| 自我中毒（存储 LLM 幻觉） | P0 | 只从 user 消息提取，不处理 assistant 输出 |
| Prompt 注入存储 | P0 | sanitize 移除注入标签 + 注入时用 XML 标签隔离 |
| L1 提取质量不稳定 | P1 | JSON mode 强制结构化输出 + 过滤规则兜底 |
| memory-core 索引延迟 | P1 | memory-core 的 watch 通常 1.5s 内重新索引 |
| 记忆文件无限增长 | P2 | `maxMemoriesPerSession` 限制 + `prune` 命令 + L0 自动清理 |
| L2 场景提取耗时 | P2 | 后台异步执行，不阻塞主对话 |
| L3 画像不准确 | P2 | incremental 模式逐步修正 + 用户可直接编辑 persona.md |

---

## 附录 A：启用自定义记忆插件后 OpenClaw 核心行为变化

> 这是理解 memory-smart 插件与 OpenClaw 核心记忆系统关系的关键章节。

### A.1 Memory 槽位（独占机制）

OpenClaw 的 `memory` 是一个**独占槽位**（exclusive slot），同一时间只允许一个 `kind: "memory"` 的插件激活：

```
配置位置: plugins.slots.memory
默认值:   "memory-core"

加载逻辑（src/plugins/loader.ts + config-state.ts）:
  1. 读取 plugins.slots.memory 配置值
  2. 遍历所有候选插件
  3. 如果插件的 kind === "memory"：
     ├─ id 匹配 slots.memory → enabled: true, selected: true
     └─ id 不匹配 → enabled: false, 原因: "memory slot set to xxx"
  4. 只有被选中的记忆插件会执行 register()
```

**关键结论**：当用户配置 `plugins.slots.memory: "memory-smart"` 时，`memory-core` 会被自动禁用，不会加载。

### A.2 各能力层变化对比

#### 🔴 被替换/接管的能力

| 能力 | memory-core 默认行为 | 启用自定义插件后 | 影响 |
|------|---------------------|-----------------|------|
| **memory_search 工具** | memory-core 注册，Agent 可调用搜索 `memory/*.md` | memory-core 被禁用，工具不存在 | **自定义插件需要自行注册同名或替代工具** |
| **memory_get 工具** | memory-core 注册，读取记忆文件片段 | memory-core 被禁用，工具不存在 | **自定义插件需要自行注册替代工具** |
| **CLI `openclaw memory` 命令** | memory-core 注册 | memory-core 被禁用，命令不存在 | **自定义插件需自行注册 CLI** |

#### 🟢 不受影响的核心功能

| 能力 | 具体机制 | 说明 |
|------|---------|------|
| **L0 Session Transcript 写入** | OpenClaw 核心在 `~/.openclaw/sessions/<sessionId>.jsonl` 写入所有对话（与插件无关） | 核心行为，不受插件槽位影响。memory-smart 从 agent_end 钩子上下文直接获取对话内容，独立记录 JSONL 到 `memory/auto/conversations/`，不读取系统 session 文件 |
| **Memory Flush（pre-compaction 记忆落盘）** | `agent-runner-memory.ts` + `memory-flush.ts`：当 session 接近 context window 上限时，自动触发一次 Agent 调用，让 Agent 将重要信息写入 `memory/YYYY-MM-DD.md` | 这是核心 compaction 机制，**不依赖 memory 插件**，直接通过 Agent 工具调用文件系统 |
| **Session Memory Hook（/new 时保存）** | 内置 hook `session-memory`：当用户执行 `/new` 或 `/reset` 时，将对话摘要保存到 `memory/YYYY-MM-DD-slug.md` | 这是内置 hook，不受 memory 插件槽位影响 |
| **memory/ 目录文件系统** | `~/.openclaw/agents/<agentId>/memory/` 目录始终存在 | 核心基础设施，所有记忆插件都在此基础上工作 |

#### 🟡 需要特别注意的交互

| 场景 | 详细说明 |
|------|---------|
| **memory-core 的搜索基础设施** | memory-core 不仅是插件，还提供底层搜索引擎（SQLite + FTS5 + embedding）。当 memory-core 被禁用后，`api.runtime.tools.createMemorySearchTool()` 仍然可用（它由核心 `src/agents/tools/memory-tool.ts` 提供，不依赖 memory-core 插件是否 enabled），**但需要确认 `memorySearch` 配置未被关闭** |
| **QMD Manager 索引** | 核心的 `qmd-manager.ts` 负责文件监控和索引（watch `memory/` 目录变化 → 增量更新 SQLite），这是核心功能，与 memory 插件槽位无关。只要有文件写入 `memory/` 目录，就会被自动索引 |
| **Memory Flush 与自定义插件的协同** | Memory Flush 是核心 compaction 机制，它让 Agent 在 context 快满时主动写 `memory/YYYY-MM-DD.md`。自定义插件的 L1 提取也写入 `memory/auto/memories/YYYY-MM-DD.md`。两者**写不同子目录**，不会冲突，且都会被 QMD 索引 |

### A.3 memory-smart 的设计选择：`kind` 不设为 `"memory"`

```json
// openclaw.plugin.json — memory-smart
{
  "id": "memory-smart",
  "name": "Memory (Smart)",
  // 注意：不设 kind: "memory"
  // 这样不会触发独占槽位机制，memory-core 继续工作
}
```

**核心策略**：memory-smart 选择**不独占 memory 槽位**，与 memory-core 共存：

```
┌──────────────────────────────────────────────────────────────┐
│ memory-core（默认 memory 槽位，继续启用）                       │
│   职责: 提供 memory_search / memory_get 工具                  │
│         SQLite + FTS5 + embedding 搜索引擎                   │
│         自动索引 memory/ 目录下的所有文件                       │
│         CLI: openclaw memory search/get                      │
│   → 只读，不主动写入任何记忆文件                                │
├──────────────────────────────────────────────────────────────┤
│ memory-smart（无 kind，作为普通插件加载）                        │
│   职责: 自动记录 L0 对话 → 写入 memory/auto/conversations/        │
│         自动提取 L1 记忆 → 写入 memory/auto/memories/*.jsonl       │
│         自动提炼 L2 场景 → 写入 memory/auto/scenes/*.md           │
│         自动生成 L3 画像 → 写入 memory/auto/persona.md（含场景导航）│
│         before_agent_start 钩子注入画像+记忆上下文（渐进式披露）    │
│         注册 memory_scene_read 工具供 Agent 按需读取 L2 场景       │
│   → 负责写入，读取复用 memory-core 的搜索能力                     │
└──────────────────────────────────────────────────────────────┘

数据流:
  memory-smart 写入文件 → QMD 自动感知变化 → 重新索引 → memory-core 搜索可见
```

### A.4 共存 vs 替代：两种方案对比

| 维度 | 方案 A: 共存（当前设计） | 方案 B: 替代（kind: "memory"） |
|------|------------------------|-------------------------------|
| memory-core 状态 | 继续启用 | 被禁用 |
| memory_search 工具 | memory-core 提供 | 需自行实现 |
| 搜索引擎 | 复用 FTS5 + embedding | 需自建或依赖外部服务 |
| 插件复杂度 | 低（只需写文件） | 高（需重建搜索能力） |
| recall 实现 | 可直接调 memory-core API | 需自行实现搜索和注入 |
| 文件索引 | QMD 自动索引 | 需自行实现 |
| 工具名冲突 | 无（不注册同名工具） | 需要注册 memory_search 等 |
| Agent 习惯 | 无变化（Agent 仍用 memory_search） | 无变化（工具名可保持一致） |

**选择方案 A 的原因**：memory-core 已经有成熟的搜索栈（SQLite + FTS5 + embedding + MMR + 时间衰减），重新实现既无必要也增加风险。memory-smart 专注于**写入端**（自动提取 + 分层提炼），读取端复用核心能力，是最佳分工。

### A.5 总结：三层关系图

```
┌─────────────────────────────────────────────────────────────────┐
│                    OpenClaw 核心（不受插件影响）                    │
│                                                                 │
│  [Session Transcript]  → ~/.openclaw/sessions/*.jsonl           │
│  [Memory Flush]        → memory/YYYY-MM-DD.md (compaction 时)   │
│  [Session Memory Hook] → memory/YYYY-MM-DD-slug.md (/new 时)   │
│  [QMD Manager]         → SQLite 自动索引 memory/ 所有文件        │
└─────────────────────────────┬───────────────────────────────────┘
                              │ 文件写入触发索引
┌─────────────────────────────▼───────────────────────────────────┐
│                memory-core 插件（memory 槽位）                    │
│                                                                 │
│  [memory_search 工具]  → Agent 可搜索记忆                        │
│  [memory_get 工具]     → Agent 可读取记忆片段                     │
│  [CLI]                 → openclaw memory search/get/list         │
│  搜索引擎: FTS5 BM25 + embedding 向量 + 混合排序                  │
└─────────────────────────────┬───────────────────────────────────┘
                              │ 提供搜索 API
┌─────────────────────────────▼───────────────────────────────────┐
│              memory-smart 插件（普通插件，共存）                    │
│                                                                 │
│  [agent_end 钩子]            → L0 记录（从钩子上下文直接获取对话）│
│                              → memory/auto/conversations/          │
│                              → L1 提取 → memory/auto/memories/*.jsonl│
│  [ExtractionScheduler]       → L2 场景 → memory/auto/scenes/   │
│  [PersonaTrigger]            → L3 画像 → memory/auto/persona.md │
│                                          （含场景导航索引）       │
│  [before_agent_start 钩子]   → 读取画像(含场景导航) + 搜索记忆    │
│                                → 注入（渐进式披露：L2 按需读取）   │
│  [memory_scene_read 工具]    → Agent 按需读取 L2 场景原文         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 附录 B：启用 memory-smart 后 Token 消耗变化分析

> 核心问题：memory-smart 与 memory-core 共存，整体 token 消耗如何变化？

### B.1 Token 消耗来源全景

启用 memory-smart 后，每轮对话的 LLM token 消耗由以下部分组成：

```
单轮对话 Token 流向：

┌─────────────────────────────────────────────────────────────────┐
│                      📥 输入侧 (Input Tokens)                    │
│                                                                 │
│  ① 系统提示词 ········ ~500-2000 tokens（已有，不变）              │
│  ② 工具定义 ·········· ~200-800 tokens（已有，不变）               │
│  ③ ★ 记忆注入 ······· ~200-1500 tokens（memory-smart 新增）      │
│     ├─ L3 画像 ······ ~400-1000 tokens（含场景导航索引）           │
│     └─ L1 记忆碎片 ·· ~100-500 tokens（5 条 × ~20-100 tokens）  │
│     （注: L2 场景不主动注入，Agent 按需通过工具读取）               │
│  ④ 对话历史 ·········· ~500-8000 tokens（已有，不变）              │
│  ⑤ 用户当前消息 ······ ~50-500 tokens（已有，不变）                │
│                                                                 │
│  合计新增输入: ~200-1500 tokens/轮                                │
├─────────────────────────────────────────────────────────────────┤
│                      📤 Agent 主调用侧 (Output Tokens)           │
│                                                                 │
│  Agent 响应 ·········· 无变化（Agent 输出不因记忆注入而增加）        │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                  🔄 后台 LLM 调用（memory-smart 新增）             │
│                                                                 │
│  ⑥ L1 提取 ·········· 每 N 轮触发（默认 N=1）                     │
│     输入: ~1500 tokens（prompt + 最近 10 条消息）                  │
│     输出: ~500 tokens（结构化 JSON）                               │
│                                                                 │
│  ⑦ L1 去重 ·········· 每条记忆（仅有相似候选时触发）                │
│     输入: ~800 tokens（新记忆 + 3 条候选）                         │
│     输出: ~200 tokens（决策 JSON）                                 │
│     每轮 0-3 次（取决于提取出几条记忆及是否有相似记忆）              │
│                                                                 │
│  ⑧ L2 场景提取 ······ 每 N 轮触发（默认 N=5）                     │
│     输入: ~3000 tokens（积累的 L1 记忆 + 现有场景摘要）             │
│     输出: ~2000 tokens（场景 JSON）                                │
│                                                                 │
│  ⑨ L3 画像生成 ······ 偶发（默认 200 条记忆触发一次）               │
│     输入: ~4000 tokens（全部场景内容 + 现有画像）                   │
│     输出: ~2000 tokens（完整画像）                                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### B.2 各场景 Token 消耗量化

#### 场景一：未启用 memory-smart（纯 memory-core 基线）

```
每轮对话:
  主 Agent 调用: [系统提示] + [工具定义] + [对话历史] + [用户消息] → 响应
  后台 LLM:     0（memory-core 不做后台 LLM 调用）
  Memory Flush: 偶发（接近 context window 时才触发，每 compaction 周期最多 1 次）

Token 消耗 = 主 Agent 调用（不变）
```

#### 场景二：默认配置（l1ExtractionEveryN=1, enableDedup=true）

```
每轮对话（稳定期）:
  主 Agent 输入增量: +200~1500 tokens（记忆注入 ③）
  L1 提取:          +2000 tokens（1500 in + 500 out）
  L1 去重:          +0~3000 tokens（0~3 次 × 1000 tokens）
  ────────────────────────────────────────────────
  每轮额外:         ~2200 ~ 6500 tokens

每 5 轮额外触发:
  L2 场景提取:      +5000 tokens（3000 in + 2000 out）
  ────────────────────────────────────────────────
  均摊到每轮:       +1000 tokens

偶发（~每 200 条记忆 ≈ ~100-200 轮对话）:
  L3 画像生成:      +6000 tokens（4000 in + 2000 out）
  ────────────────────────────────────────────────
  均摊到每轮:       +30~60 tokens（可忽略）

═══════════════════════════════════════════════════
总计每轮额外消耗（默认配置）: ~3200 ~ 7500 tokens
典型值:                      ~4000 ~ 5000 tokens/轮
═══════════════════════════════════════════════════
```

#### 场景三：省 Token 配置（l1ExtractionEveryN=3, enableDedup=false）

```
每轮对话（稳定期）:
  主 Agent 输入增量: +200~1500 tokens（记忆注入，同上）
  L1 提取:          每 3 轮触发 1 次 = 均摊 ~667 tokens/轮
  L1 去重:          关闭 = 0
  ────────────────────────────────────────────────
  每轮额外:         ~867 ~ 2167 tokens

L2 均摊:            +1000 tokens/轮（同上）
═══════════════════════════════════════════════════
总计每轮额外消耗（省Token配置）: ~1867 ~ 3167 tokens
典型值:                         ~2000 ~ 2500 tokens/轮
═══════════════════════════════════════════════════
```

#### 场景四：极简配置（autoCapture=false, 仅手动 memory_save）

```
每轮对话:
  主 Agent 输入增量: +200~1500 tokens（记忆注入仍工作）
  后台 LLM:         0（不自动提取）
  ────────────────────────────────────────────────
  每轮额外:         仅 +200~1500 tokens（纯注入成本）
═══════════════════════════════════════════════════
```

### B.3 增量 vs 收益 — 值不值？

```
┌─────────────────────────────────────────────────────────────────┐
│                  Token 增量 vs 用户体验收益                        │
│                                                                 │
│  主 Agent 调用（典型）:  ~5000 ~ 50000 tokens/轮                 │
│                         （取决于对话长度和任务复杂度）              │
│                                                                 │
│  memory-smart 额外:     ~4000 ~ 5000 tokens/轮（默认配置）       │
│                                                                 │
│  占比:                  ~8% ~ 50%（短对话占比高，长对话占比低）     │
│                                                                 │
│  收益:                                                          │
│  ✅ Agent 了解用户偏好 → 减少重复解释 → 长期反而省 token          │
│  ✅ 记忆注入精准 → Agent 首轮即给出贴合用户习惯的回复              │
│  ✅ 场景画像 → 对话质量显著提升                                   │
│  ✅ 减少用户纠正 → 减少多余来回对话轮次                            │
└─────────────────────────────────────────────────────────────────┘
```

### B.4 与 Memory Flush 的叠加效应

Memory Flush 是 OpenClaw 核心的 compaction 前记忆落盘机制，**无论是否启用 memory-smart 都会存在**。

```
不启用 memory-smart:
  Memory Flush 写入 memory/YYYY-MM-DD.md → memory-core 索引
  下次 memory_search 可搜到 → 但内容是粗粒度的（Agent 自行决定写什么）

启用 memory-smart:
  Memory Flush 继续工作 → 写入 memory/YYYY-MM-DD.md
  memory-smart 也写入 → memory/auto/memories/*.jsonl
  两者写不同子目录/文件，不冲突，都被 QMD 索引

  ⚠️ 潜在重复:
  Memory Flush 和 L1 提取可能对同一轮对话提取出相似的记忆。
  但 L1 去重机制会处理这种情况——搜索已有记忆时也能搜到 Memory Flush 写入的内容。

  ⚠️ Token 叠加:
  Memory Flush 本身消耗: ~3000-8000 tokens（一次完整的 embedded Agent run）
  但它只在 context window 快满时触发（每 compaction 周期最多 1 次），
  频率远低于 memory-smart 的每轮 L1 提取。
  两者的 token 消耗是叠加的，但 Memory Flush 的触发稀少，影响有限。
```

### B.5 消耗控制建议

| 用户类型 | 推荐配置 | 每轮额外 Token | 说明 |
|----------|---------|---------------|------|
| **重度用户**（对记忆质量要求高） | 默认配置 | ~4000-5000 | 每轮提取 + 去重，记忆质量最高 |
| **普通用户** | `l1ExtractionEveryN=3` | ~2000-2500 | 每 3 轮提取 1 次，降 ~50% |
| **预算敏感** | 同上 + `enableDedup=false` | ~1500-2000 | 关闭去重，可能有少量重复记忆 |
| **极简模式** | `autoCapture=false` | ~200-1500 | 仅注入已有记忆，不自动提取 |
| **纯手动** | `autoCapture=false` + `autoRecall=false` | 0 | 仅保留 `memory_save`/`memory_forget` 工具 |

---

## 附录 C：OpenViking 如何大幅减少 Token 开销

> 核心问题：memory-openviking 插件使用 OpenViking 作为后端，在 LoCoMo10 测试中相比原生 memory-core **降低 91% input tokens**（24.6M → 2.1M），它是如何做到的？

### C.1 LoCoMo10 实测数据回顾

（来自 README.md 中的实验数据）

```
┌─────────────────────────────────────────────────────────────────┐
│                    LoCoMo10 (1540 cases)                         │
│                                                                 │
│  方案                                    完成率    Input Tokens  │
│  ─────────────────────────────────────────────────────────────  │
│  OpenClaw (memory-core)                  35.65%   24,611,530    │
│  OpenClaw + LanceDB (-memory-core)       44.55%   51,574,530    │
│  OpenClaw + OpenViking (-memory-core)    52.08%    4,264,396    │
│  OpenClaw + OpenViking (+memory-core)    51.23%    2,099,622    │
│                                                                 │
│  对比                                                           │
│  ─────────────────────────────────────────────────────────────  │
│  vs memory-core:     完成率 +43%,  token -91% (24.6M → 2.1M)   │
│  vs LanceDB:         完成率 +15%,  token -96% (51.6M → 2.1M)   │
└─────────────────────────────────────────────────────────────────┘
```

### C.2 Token 节省的三大核心机制

OpenViking 的 token 节省**不是单一技术**，而是三个机制协同作用的结果：

```
┌─────────────────────────────────────────────────────────────────┐
│        机制 ①: L0/L1/L2 分层上下文加载（写入时预处理）            │
│                                                                 │
│  传统 RAG / memory-core 方式:                                    │
│    用户问 "我喜欢什么颜色?"                                       │
│    → 向量搜索找到 5 条记忆                                        │
│    → 返回完整文本注入 Agent context                               │
│    → 每条记忆 ~200-500 tokens × 5 = ~1000-2500 tokens           │
│                                                                 │
│  OpenViking 方式:                                                │
│    写入时自动生成三层:                                            │
│      L0 (Abstract)  ~100 tokens — 一句话摘要                     │
│      L1 (Overview)  ~1-2k tokens — 核心信息 + 导航指引            │
│      L2 (Detail)    完整原文 — 只有在需要时才加载                  │
│                                                                 │
│    检索时:                                                       │
│      向量索引只用 L0 abstract → ~100 tokens/条                   │
│      Rerank 也只用 L0 abstract → 不额外消耗                      │
│      注入 Agent context 时:                                      │
│        只注入 L2 叶子节点的 content（已经是提炼后的记忆）          │
│        而非原始对话的大段文本                                     │
│                                                                 │
│  ★ 关键: 记忆不是原始对话文本的片段，                             │
│    而是 LLM 提取出的结构化精炼内容（L2 detail）                   │
│    一条 L2 记忆通常只有 20-100 tokens，远小于原始对话片段         │
│                                                                 │
│  节省估算: 检索阶段节省 ~70-80% tokens                           │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│        机制 ②: 目录递归检索（避免全量扫描）                        │
│                                                                 │
│  传统 RAG / memory-core 方式:                                    │
│    向量搜索 → 扁平匹配所有记忆 → 返回 topK                       │
│    问题: 无法理解记忆的组织结构，相关性全靠 embedding 距离         │
│    当记忆量大时，搜索范围大，误召回多                              │
│                                                                 │
│  OpenViking 方式 — 层级递归搜索:                                  │
│                                                                 │
│    Step 1: 根据 context_type 缩小根目录范围                      │
│      MEMORY → viking://user/memories + viking://agent/memories   │
│      不搜 resources、skills 等无关目录                            │
│                                                                 │
│    Step 2: 全局向量搜索找到 top-3 "起始目录"                     │
│      只搜目录级别的 abstract，不搜所有叶子节点                    │
│                                                                 │
│    Step 3: 在起始目录内递归搜索                                   │
│      score = 0.5 × embedding_score + 0.5 × parent_score         │
│      只递归进入高分目录，低分目录直接跳过                         │
│      收敛检测: topK 连续 3 轮未变化 → 提前停止                    │
│                                                                 │
│    Step 4: 返回结果只含 L0 abstract                              │
│      Agent 按需选择性读取 L1/L2                                   │
│                                                                 │
│  ★ 关键: 不是"搜所有记忆取 topK"，                               │
│    而是"先锁定相关目录，再在目录内精确搜索"                       │
│    大量不相关目录根本不会被展开遍历                                │
│                                                                 │
│  节省估算: 减少 ~60-80% 无效候选的处理                            │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│        机制 ③: 插件端精准注入 + 无额外 Agent 调用                  │
│                                                                 │
│  memory-core 的隐性 token 开销:                                   │
│    memory-core 注册了 memory_search / memory_get 工具             │
│    Agent 在对话中 **自主决定** 是否调用这些工具                     │
│    每次工具调用 = 一轮 Agent 响应 + 工具结果 + 后续处理           │
│    Agent 可能多次调用 memory_search 探索不同维度                   │
│    → 工具调用本身就产生大量 input/output tokens                   │
│                                                                 │
│  memory-openviking 插件的方式:                                    │
│    before_agent_start 钩子:                                      │
│      → 提取用户最新消息作为 query                                 │
│      → 直接调用 OpenViking find API（HTTP，非 LLM）              │
│      → 搜索 viking://user/memories + viking://agent/memories     │
│      → 客户端 postProcess + pickForInjection 排序去重             │
│      → 对 top 条 L2 节点读取正文（client.read）                  │
│      → 拼接为 <relevant-memories> 注入 Agent context             │
│                                                                 │
│    agent_end 钩子:                                               │
│      → 提取新增的 user+assistant 消息                             │
│      → 创建临时 OpenViking session                                │
│      → addSessionMessage → extractSessionMemories                │
│      → 删除临时 session                                          │
│                                                                 │
│  ★ 关键差异:                                                     │
│    ┌────────────────────────┬───────────────┬──────────────────┐ │
│    │                        │ memory-core   │ memory-openviking│ │
│    ├────────────────────────┼───────────────┼──────────────────┤ │
│    │ 记忆召回               │ Agent 主动调   │ 钩子自动注入     │ │
│    │                        │ 用工具(LLM轮) │ (无LLM轮)        │ │
│    │ 记忆存储               │ Agent 主动调   │ 钩子自动提取     │ │
│    │                        │ 用工具(LLM轮) │ (Server端LLM)   │ │
│    │ 主Agent工具定义token   │ 需要（每轮）   │ 不需要           │ │
│    │ 工具调用往返token      │ 多轮           │ 0轮              │ │
│    └────────────────────────┴───────────────┴──────────────────┘ │
│                                                                 │
│  当 memory-openviking 设 kind:"memory" 替换 memory-core 时:     │
│    - memory_search / memory_get 工具定义从主 Agent 提示中移除     │
│    - Agent 不再产生"要不要搜记忆"的决策 token                    │
│    - Agent 不再产生工具调用/工具结果的往返 token                  │
│                                                                 │
│  节省估算: 每轮减少 ~1000-3000 tokens（工具定义 + 工具调用往返）  │
│            在 1540 cases 中累计节省巨大                            │
└─────────────────────────────────────────────────────────────────┘
```

### C.3 为什么 +memory-core 反而比 -memory-core 更省 Token？

这是测试数据中最反直觉的发现：

```
OpenClaw + OpenViking (-memory-core):  52.08%,  4,264,396 tokens
OpenClaw + OpenViking (+memory-core):  51.23%,  2,099,622 tokens  ← 更省!
```

分析原因：

```
┌─────────────────────────────────────────────────────────────────┐
│  +memory-core 更省 token 的可能解释:                              │
│                                                                 │
│  1. memory-openviking 设 kind:"memory" → 替换了 memory-core      │
│     (-memory-core 模式下 memory-core 被禁用)                     │
│                                                                 │
│  2. +memory-core 模式下，memory-core 仍然活跃                    │
│     memory-openviking 也活跃（因为它也设了 kind:"memory"）        │
│     → 但 OpenClaw 的 memory 槽位只允许一个                       │
│     → 实际效果取决于加载顺序：                                   │
│       如果 openviking 后加载，则替换 memory-core                  │
│       如果 openviking 先加载，memory-core 替换它                  │
│                                                                 │
│  3. 更可能的解释:                                                │
│     +memory-core 配置下，OpenClaw 核心的 Memory Flush 仍工作     │
│     → 对话历史被定期落盘压缩                                     │
│     → context window 不会撑满                                    │
│     → 每轮对话的 input tokens 更少（历史更短）                   │
│                                                                 │
│     -memory-core 配置下，memory flush 可能也仍工作               │
│     但缺少 memory-core 的 compaction 优化                        │
│     → context window 管理效率略低                                │
│     → 某些 case 需要更多轮对话才能完成                            │
│     → 总 token 更高                                              │
│                                                                 │
│  4. 关键洞察:                                                    │
│     memory-core 的 compaction/flush 机制 + OpenViking 的精准注入  │
│     = 最优组合                                                   │
│     memory-core 负责 context window 管理                         │
│     OpenViking 负责长期记忆的精准召回                             │
│     两者协作比单独使用任一方都更高效                               │
└─────────────────────────────────────────────────────────────────┘
```

### C.4 OpenViking vs memory-smart：Token 节省策略对比

```
┌─────────────────────────────────────────────────────────────────┐
│              OpenViking         vs        memory-smart           │
│                                                                 │
│  ┌────────────────────────┬─────────────────┬─────────────────┐ │
│  │ 维度                   │ OpenViking      │ memory-smart    │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 后端                   │ 独立 Python 服   │ 纯 TS，复用     │ │
│  │                        │ 务 (HTTP API)   │ memory-core     │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 记忆存储               │ AGFS 虚拟文件   │ L0 JSON +       │ │
│  │                        │ 系统(viking://) │ L1 JSONL +      │ │
│  │                        │                 │ L2/L3 Markdown  │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 分层加载               │ ✅ L0/L1/L2     │ ✅ 渐进式披露   │ │
│  │                        │ 写入时预处理    │ L3导航→Agent   │ │
│  │                        │                 │ 按需读L2原文    │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 检索方式               │ 目录递归检索    │ 向量搜索(扁平)  │ │
│  │                        │ + 收敛停止      │ 复用 memory-    │ │
│  │                        │                 │ core 搜索引擎   │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 记忆提取 LLM 调用      │ Server 端异步   │ 插件端后台      │ │
│  │                        │ (commit 时集中) │ (每 N 轮触发)   │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 单次提取 LLM 调用次数  │ 6-9 次          │ 1-4 次          │ │
│  │                        │ (归档+提取+去重 │ (L1提取+去重)   │ │
│  │                        │  +合并)         │                 │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 去重机制               │ 向量预过滤 +    │ 向量搜索 +      │ │
│  │                        │ LLM 决策(skip/  │ LLM 判断        │ │
│  │                        │ create/merge)   │ (merge/replace) │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 记忆分类               │ 8 类 (profile,  │ 3 层 (L1碎片,   │ │
│  │                        │ preferences,    │ L2场景, L3画像) │ │
│  │                        │ entities,events,│                 │ │
│  │                        │ cases,patterns, │                 │ │
│  │                        │ tools,skills)   │                 │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 注入主 Agent 方式      │ before_agent_   │ before_agent_   │ │
│  │                        │ start 钩子      │ start 钩子      │ │
│  │                        │ (prependContext) │ (prependContext) │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 主 Agent 工具调用      │ 无(注入制)      │ 注入制+渐进式   │ │
│  │                        │ + 3 个备用工具  │ 披露            │ │
│  │                        │ (recall/store/  │ + 4 个工具      │ │
│  │                        │ forget)         │ (save/forget/   │ │
│  │                        │                 │ scene_read/     │ │
│  │                        │                 │ persona_refresh)│ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 额外部署要求           │ Python 3.10+,   │ 无              │ │
│  │                        │ Go 1.22+,       │ (纯 TS 插件)    │ │
│  │                        │ C++ 编译器      │                 │ │
│  ├────────────────────────┼─────────────────┼─────────────────┤ │
│  │ 适合场景               │ 重度用户，大量  │ 轻量级，开箱    │ │
│  │                        │ 记忆+资源管理   │ 即用            │ │
│  └────────────────────────┴─────────────────┴─────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### C.5 OpenViking Token 节省的量化拆解

基于 LoCoMo10 数据，我们可以反推各机制的贡献：

```
基线（memory-core）:  24,611,530 tokens / 1540 cases = ~15,982 tokens/case

OpenViking (+core):   2,099,622 tokens / 1540 cases  = ~1,363 tokens/case

节省: ~14,619 tokens/case（~91%）

┌─────────────────────────────────────────────────────────────────┐
│  节省来源拆解（估算）:                                            │
│                                                                 │
│  ① 消除工具调用往返 (最大贡献):           ~5,000-8,000 tokens    │
│     memory-core 下 Agent 主动调用 memory_search → 工具定义 +     │
│     决策 token + 工具调用 + 工具结果 + 后续处理                   │
│     → 被 before_agent_start 钩子注入替代，主 Agent 零工具调用    │
│                                                                 │
│  ② L0/L1/L2 分层（第二大贡献）:           ~3,000-5,000 tokens    │
│     注入的是 L2 精炼记忆（~20-100 tokens/条），而非原始文本片段  │
│     检索完全基于 L0 abstract，不加载完整内容                     │
│                                                                 │
│  ③ 目录递归检索精准性:                     ~1,000-2,000 tokens    │
│     减少误召回 → 减少无关记忆注入 → 减少 Agent 处理无关信息      │
│     收敛检测提前停止 → 不遍历全部记忆                             │
│                                                                 │
│  ④ context window 管理协同（+core 模式）:  ~1,000-2,000 tokens    │
│     memory-core 的 compaction/flush 机制仍工作                    │
│     保持 context window 紧凑 → 每轮历史更短                      │
│                                                                 │
│  合计: ~10,000-17,000 tokens/case 节省                           │
│  与实际 ~14,619 tokens/case 节省基本吻合                          │
└─────────────────────────────────────────────────────────────────┘
```

### C.6 OpenViking 的 "隐藏成本" — Server 端 LLM 消耗

OpenViking 的 token 节省是从**主 Agent 侧**衡量的（即 LoCoMo10 测试报告的 input tokens）。
但 OpenViking Server 端也有自己的 LLM 调用成本：

```
OpenViking Server 端 LLM 调用（不计入主 Agent tokens）:

  资源/记忆写入时:
    ├─ L0/L1 自动生成:   ~1-2 次 LLM 调用/文件（SemanticProcessor 异步处理）
    ├─ 代码文件优化:     AST 模式可跳过 LLM（tree-sitter 直接提取结构骨架）
    └─ 大量文件:         并发 100 LLM 调用，但只在写入时触发一次

  Session commit 时（对话结束后触发）:
    ├─ 归档摘要:         1 次 LLM（~4k input tokens）
    ├─ 记忆候选提取:     1 次 LLM（~5k input tokens，380行 prompt 模板指导 8 类分类）
    ├─ 每个候选去重:     0-1 次 LLM（~1-2k input tokens，向量预过滤后决定）
    ├─ 每个候选合并:     0-1 次 LLM（~2-3k input tokens，仅 merge 决策时）
    └─ 总计: 约 6-9 次 LLM 调用 / session commit

  检索时:
    ├─ find() API:       0 次 LLM（纯向量 + rerank，无 LLM 调用）
    └─ search() API:     1 次 LLM（意图分析，生成 0-5 个 TypedQuery）
       memory-openviking 插件的 auto-recall 使用 find()，所以 0 次 LLM

  ⚠️ 这些 Server 端 LLM 调用的成本:
    - 使用配置的 VLM 模型（可以是便宜的模型如 doubao-seed-2-0-pro）
    - 与主 Agent 使用的 LLM（如 Claude/GPT-4o）可以是不同模型
    - 通常 Server 端 VLM 调用成本远低于主 Agent 的 LLM 成本
    - 这些调用是异步的，不阻塞主 Agent 的响应
```

### C.7 总结：OpenViking 为什么能同时提升效果和降低成本

```
┌─────────────────────────────────────────────────────────────────┐
│  核心洞察: OpenViking 不是简单的"少用 token"，                    │
│  而是"把 token 花在刀刃上"                                       │
│                                                                 │
│  传统方式（memory-core / LanceDB）:                              │
│    token 花在:                                                   │
│    - Agent 决定"要不要搜记忆"的决策轮次                           │
│    - 工具定义的重复传输                                          │
│    - 工具调用的往返通信                                          │
│    - 返回大段不相关的记忆文本                                     │
│    → 大量 token 花在"找记忆"的过程中，而非"使用记忆"             │
│                                                                 │
│  OpenViking 方式:                                                │
│    token 花在:                                                   │
│    - 精准注入的 L2 记忆内容（已提炼，无冗余）                    │
│    - Agent 直接使用这些记忆生成回答                               │
│    → token 集中在"使用记忆"的实际价值上                          │
│                                                                 │
│  类比:                                                           │
│    memory-core = 每次去图书馆查资料都要排队、找书架、翻书         │
│    OpenViking = 助手提前把相关的关键段落摘抄好放在桌上            │
│                                                                 │
│  结果: 更少的 token，更好的效果                                   │
└─────────────────────────────────────────────────────────────────┘
```
