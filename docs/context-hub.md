# Context Hub（CH，上下文中心）设计

本文定义 QuarkfanTools 的 Context Hub，简称 CH。CH 是平台八个中心之一，替代原“知识中心”命名。原因是该中心不只管理传统知识库和 RAG，也承担系统级记忆模块职责，包括短期记忆、中期记忆和长期记忆。

## 1. 定位

CH 负责管理“运行时可以合法使用的上下文”。这里的上下文包括：

- 显式知识：Skill `knowledge/`、飞书文档/Wiki/云盘、客户知识库、本地文件知识库、外部知识源。
- 短期记忆：当前任务、当前消息窗口、当前会话内的临时事实、最近工具结果、当前用户意图。
- 中期记忆：某 Bot 在一段时间内稳定复用的会话摘要、项目状态、用户偏好、待办线索、近期上下文。
- 长期记忆：跨会话、跨任务、可审计沉淀的事实、偏好、组织知识、客户资料、项目历史、知识图谱实体关系。
- 派生上下文：摘要、索引、向量、关键词、实体、关系、freshness、权限判断、引用和审计记录。

CH 对外提供的是“上下文召回能力”和“记忆读写治理能力”，不是最终回复能力。

## 2. 设计目标

CH 的核心目标：

1. 统一接入各种上下文源。
2. 统一表达知识、记忆、摘要、chunk、实体和关系。
3. 在 Bot、用户、会话、来源和权限范围内管理上下文可见性。
4. 提供可审计的召回结果，供运行时中心转换为具体 runtime 的上下文格式。
5. 提供记忆写入、更新、合并、过期、遗忘和人工确认机制。
6. 让知识和记忆都具备 freshness、来源、权限、置信度和生命周期。

CH 必须满足：

- 不能把“文件存在”当作“可被某 Bot 使用”。
- 不能把“模型说值得记住”直接当作长期记忆写入。
- 不能把短期会话 transcript、资源缓存、日志和知识索引混成一个存储池。
- 不能把 runtime prompt 当作知识库事实来源。
- 任何召回和记忆写入都必须可追踪到来源、触发者、治理判定和时间。

## 3. 参考项目策略

当前已完成第一轮源码级参考：

- AnythingLLM：本地知识库、workspace、documents、vector DB、文档管道。
- Open WebUI：Knowledge / Directory / File 模型、访问授权、RAG tool、知识事件。
- Dify：dataset / knowledge config、process rule、retrieval DTO、metadata filtering、rerank。
- LlamaIndex：Document / Node / Relationship / NodeWithScore / Retriever 抽象。

这些项目对“知识库和 RAG”参考价值很高，但对“记忆系统”不足。CH 后续建议补充第二批 memory 参考：

| 方向 | 候选项目 | 重点看什么 |
| --- | --- | --- |
| AI Memory | Mem0 / OpenMemory | user memory、fact extraction、memory scoring、update/delete、cross-session recall |
| Agent OS / Memory | Letta | archival memory、core memory、agent state、memory blocks |
| Temporal / Graph Memory | Zep / Graphiti | episode、entity、relationship、temporal graph、事实冲突和时间有效性 |
| Runtime Memory | LangGraph / LangMem | short-term state、checkpoint、long-term store、memory namespace |
| Personal Knowledge | Logseq / Obsidian | local-first notes、links、backlinks、graph、用户可编辑知识 |

使用原则：

- 可以直接依赖成熟项目，也可以只借鉴接口、状态机、数据结构、测试方法或少量许可允许的代码片段。
- 记忆类项目要特别关注删除、纠错、冲突、隐私、跨 Bot 隔离和用户可见编辑能力。
- CH 第一版先使用 QuarkfanTools 自有 DTO 和最小实现，不直接绑定某个大型项目。

## 4. 核心概念

### 4.1 ContextSource

`ContextSource` 是上下文来源。

```ts
type ContextSourceKind =
  | "skill-knowledge"
  | "lark-doc"
  | "lark-wiki"
  | "lark-drive"
  | "local-file"
  | "manual-note"
  | "conversation"
  | "task"
  | "tool-result"
  | "external";

interface ContextSource {
  sourceId: string;
  kind: ContextSourceKind;
  ownerScope: ContextScope;
  displayName: string;
  connectorRef?: string;
  resourceRef?: string;
  status: "active" | "disabled" | "stale" | "failed";
  createdAt: string;
  updatedAt: string;
}
```

### 4.2 ContextCollection

`ContextCollection` 是一组上下文的管理单元，可以是知识库、项目记忆库、Bot 记忆域或客户空间。

```ts
interface ContextCollection {
  collectionId: string;
  name: string;
  kind: "knowledge" | "memory" | "mixed";
  scope: ContextScope;
  retention?: ContextRetentionPolicy;
  retrievalPolicy: ContextRetrievalPolicy;
  writePolicy: ContextWritePolicy;
  status: "active" | "paused" | "archived";
  createdAt: string;
  updatedAt: string;
}
```

### 4.3 ContextRecord

`ContextRecord` 是 CH 的统一上下文事实。知识文档、记忆条目、摘要、实体、关系、chunk 都可以被表达为 record，但通过 type 区分。

```ts
type ContextRecordType =
  | "document"
  | "chunk"
  | "summary"
  | "memory"
  | "preference"
  | "fact"
  | "entity"
  | "relationship"
  | "tool-observation";

interface ContextRecord {
  recordId: string;
  collectionId: string;
  sourceId: string;
  type: ContextRecordType;
  scope: ContextScope;
  title?: string;
  content: string;
  metadata?: Record<string, unknown>;
  relationships?: ContextRelationship[];
  freshness: ContextFreshness;
  confidence?: number;
  sensitivity: "public" | "internal" | "user-content" | "credential" | "restricted";
  status: "active" | "draft" | "stale" | "superseded" | "deleted";
  createdAt: string;
  updatedAt: string;
}
```

### 4.4 ContextMemory

`ContextMemory` 是专门的记忆视图，不是单独脱离 ContextRecord 的事实表。它用于表达记忆的层级、生命周期和写入治理。

```ts
type MemoryTier = "short-term" | "mid-term" | "long-term";

interface ContextMemory {
  memoryId: string;
  recordId: string;
  tier: MemoryTier;
  subject: {
    botId?: string;
    userId?: string;
    conversationId?: string;
    projectId?: string;
    organizationId?: string;
  };
  memoryKind: "fact" | "preference" | "instruction" | "project-state" | "relationship" | "summary";
  writeState: "candidate" | "confirmed" | "rejected" | "superseded";
  evidenceRefs: string[];
  expiresAt?: string;
  lastReinforcedAt?: string;
}
```

### 4.5 ContextScope

`ContextScope` 是隔离边界。

```ts
interface ContextScope {
  botId?: string;
  userId?: string;
  ownerId?: string;
  conversationId?: string;
  workspaceId?: string;
  sourceTenantId?: string;
  capabilityRef?: string;
}
```

规则：

- 默认按 Bot 隔离。
- 私聊记忆默认属于 `botId + userId/conversationId`。
- 群聊记忆默认属于 `botId + conversationId + senderId` 或明确的项目空间。
- 长期记忆写入必须有明确 scope，不允许写入无主全局记忆。

## 5. 记忆分层

### 5.1 短期记忆

短期记忆是当前处理链路内的上下文缓存。

来源：

- 当前消息。
- 最近 N 条消息。
- 当前工具调用结果。
- 当前任务计划。
- 当前 runtime 临时状态。

特点：

- 生命周期短，默认随任务或会话结束过期。
- 可进入 runtime context，但不一定持久化为长期事实。
- 由调度中心和运行时中心产生，CH 可以保存摘要和引用。

### 5.2 中期记忆

中期记忆是近期可复用上下文。

来源：

- 会话摘要。
- 最近项目状态。
- 用户近期偏好。
- 待办线索。
- 反复出现的事实候选。

特点：

- 可配置 TTL，例如 7 天、30 天、90 天。
- 可以被 CH 自动提取为候选，但需要策略确认后进入 confirmed。
- 适合用于“恢复上下文”“继续上次工作”“客户最近在做什么”。

### 5.3 长期记忆

长期记忆是跨会话稳定事实。

来源：

- 用户明确保存。
- Owner 确认。
- 多次证据强化。
- 受信知识源同步。
- 手工导入或编辑。

特点：

- 必须可编辑、可删除、可溯源。
- 必须有证据链和最近确认时间。
- 对敏感内容需要治理策略。
- 冲突时不得静默覆盖，应标记 conflict 或 superseded。

## 6. Context Hub 模块

| 模块 | 职责 |
| --- | --- |
| Source Registry | 管理上下文来源、连接器、source scope、freshness key |
| Collection Manager | 管理知识库、记忆域、项目上下文集合 |
| Ingestion Pipeline | 文档解析、切块、摘要、实体抽取、索引写入 |
| Memory Manager | 记忆候选、确认、强化、过期、遗忘、冲突处理 |
| Context Store | 保存 ContextRecord、Memory、Chunk、Entity、Relationship、Snapshot |
| Retrieval Engine | 关键词、向量、混合检索、metadata filtering、rerank、freshness filtering |
| Policy Bridge | 调用治理中心判断可读、可写、可进入模型上下文 |
| Audit & Diagnostics | 召回日志、写入日志、过期/冲突/删除记录、排障摘要 |

## 7. 核心接口

### 7.1 上下文源

```ts
interface ContextSourceAdapter {
  list(request: ContextSourceListRequest): Promise<ContextSourceItem[]>;
  fetch(request: ContextFetchRequest): Promise<ContextSourceContent>;
  freshness(request: ContextFreshnessRequest): Promise<ContextFreshness>;
}
```

### 7.2 入库

```ts
interface ContextIngestionPipeline {
  ingest(request: ContextIngestRequest): AsyncIterable<ContextIngestionEvent>;
}
```

### 7.3 召回

```ts
interface ContextRetriever {
  retrieve(request: ContextRetrieveRequest): Promise<ContextRetrieveResult>;
}

interface ContextRetrieveRequest {
  requestId: string;
  correlationId: string;
  actor: ContextActor;
  scope: ContextScope;
  query: string;
  intent?: string;
  sources?: ContextSourceSelector[];
  memoryTiers?: MemoryTier[];
  retrievalMode: "keyword" | "semantic" | "hybrid" | "graph";
  topK: number;
  freshness?: "fresh-only" | "allow-stale-marked" | "any";
  metadataFilters?: Record<string, unknown>;
}

interface ContextRetrieveResult {
  records: ContextRetrieveRecord[];
  staleRecords: ContextRetrieveRecord[];
  partialFailures: ContextPartialFailure[];
  auditRefs: string[];
}
```

### 7.4 记忆写入

```ts
interface ContextMemoryWriter {
  propose(request: MemoryProposeRequest): Promise<MemoryCandidate[]>;
  confirm(request: MemoryConfirmRequest): Promise<ContextMemory>;
  reject(request: MemoryRejectRequest): Promise<void>;
  forget(request: MemoryForgetRequest): Promise<void>;
}
```

规则：

- `propose` 可以自动运行，但只生成候选。
- `confirm` 需要策略允许，可以由用户、Owner、明确规则或多证据强化触发。
- `forget` 必须保留审计摘要，但删除或不可逆脱敏正文。

## 8. 与其他中心关系

| 中心 | 关系 |
| --- | --- |
| MG | 提供消息事实、历史查询和 conversation context；CH 不直接监听 IM |
| 运行时中心 | 消费 CH 的召回结果；不直接读取 CH 存储 |
| 工具与能力中心 | Skill、自定义应用、Workflow 可声明上下文源或写入候选；是否可用由治理判断 |
| 模型中心 | CH 可请求 embedding、summary、rerank 模型候选；不直接管理 provider |
| 资源中心 | 资源中心保存文件、缓存、日志、排障包；CH 保存语义记录、索引和引用 |
| 调度与系统基础中心 | 调度 CH 入库、定期刷新、记忆提取、过期清理 |
| 治理与安全中心 | 判定上下文可读、可写、可入模、可导出、可遗忘 |

## 9. P0 建设范围

P0 目标不是一次性做完整 RAG 和长期记忆系统，而是先把边界打稳。

P0 包含：

- CH 命名和协议收口。
- `ContextSource`、`ContextCollection`、`ContextRecord`、`ContextMemory`、`ContextRetrieveRequest/Result` DTO。
- 只读接入 Skill `knowledge/`。
- 只读接入受控飞书文件/文档缓存引用。
- 会话摘要作为中期记忆候选。
- 手工确认的长期记忆。
- 基础关键词检索。
- freshness、source、scope、audit 字段。
- 每 Bot 授权过滤。
- UI/排障可见性：来源、最后更新时间、是否 stale、召回记录、记忆候选。

P0 暂不包含：

- 自动无确认写入长期记忆。
- 全量知识图谱。
- 复杂向量库选择 UI。
- 多用户云端共享知识库。
- 自动跨 Bot 共享记忆。
- 直接把任何开源项目完整嵌入 CH。

## 10. P0 数据落点

建议先在单机版内落最小本地存储，后续再拆独立仓库。

```text
state/context-hub/
  sources.json
  collections.json
  records.jsonl
  memories.jsonl
  retrieval-audit.jsonl
  ingestion-runs.jsonl
  indexes/
    keyword/
    vector/
```

Bot 级视图：

```text
state/bots/<bot-id>/context/
  authorized-sources.json
  memory-candidates.jsonl
  confirmed-memories.jsonl
  recall-history.jsonl
```

## 11. UI 可见性

CH 需要独立的管理视图，至少包含：

- 上下文源列表。
- 每个 Bot 可用的上下文源。
- 知识文档 fresh/stale 状态。
- 入库/索引任务状态。
- 记忆候选列表。
- 已确认记忆列表。
- 召回测试入口。
- 某次回复使用了哪些上下文。
- 删除/遗忘入口和审计说明。

## 12. 风险

- 记忆污染：模型误把一次性信息写成长期事实。
- 权限污染：Bot 召回了未授权知识或其他 Bot 记忆。
- 过期知识污染：源文档已更新但索引仍返回旧内容。
- 删除不彻底：用户删除知识或记忆后仍残留在向量索引、摘要或排障包。
- Prompt 污染：把不可信工具输出或用户输入沉淀成高可信记忆。
- 过度召回：把无关记忆塞进 runtime context，降低回答质量。

## 13. 下一步

1. 持续巡检平台文档和后续实现，避免重新引入独立“知识中心”边界。
2. 继续保留 AnythingLLM / Open WebUI / Dify / LlamaIndex 作为知识与 RAG 参考。
3. 补充第二批 memory 项目源码级评估，优先 Mem0 / OpenMemory、Letta、Zep / Graphiti、LangGraph / LangMem。
4. 基于本文收口 CH P0 合同文档。
5. 再决定 CH 是否独立为子仓库；短期可以先在单机版中以 facade 方式落地。
