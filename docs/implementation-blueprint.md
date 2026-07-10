# Context Hub 可执行设计蓝图

本文把 [`context-hub.md`](context-hub.md) 中的领域设计收口成可直接建设的工程蓝图。它面向后续实现、测试、迁移和验收，不重新解释 CH 为什么存在。

## 1. 建设目标

P0 目标是先在 macOS 单机版内形成可替换的 Context Hub 子系统，承接当前 QuarkfanTools 中分散在 Skill `knowledge/`、飞书受控缓存、runtime transcript、会话摘要和 Bot 配置里的上下文能力。

P0 必须做到：

- 上下文源、知识、记忆、摘要、chunk、freshness、权限和审计都有统一 DTO。
- 一个 Bot 一个默认隔离上下文域；未经授权的来源不能被召回、入模或写入长期记忆。
- Skill `knowledge/`、受控飞书文件/文档缓存、会话摘要和手工记忆都通过 CH facade 进入 runtime context。
- 召回结果必须带来源、scope、freshness、置信度、引用和 auditRef。
- 记忆写入必须先成为 candidate，再通过用户/Owner/策略/多证据强化进入 confirmed。
- stale、冲突、删除、遗忘、权限缺失和部分失败必须显式返回，不能静默吞掉。
- 管理面能看到 source list、index status、fresh/stale、memory candidates、confirmed memories、recall trace 和 forget/audit。

P0 不做：

- 不建设独立服务端，不改变当前 macOS 本机交付形态。
- 不直接引入重型 RAG 平台作为运行时依赖。
- 不做自动无确认长期记忆写入。
- 不做复杂知识图谱、跨 Bot 自动共享记忆、多租户云端知识库或向量库选择 UI。
- 不把资源缓存、日志、完整聊天 transcript、runtime prompt 或文件系统当成 CH 事实源。
- 不绕过治理中心读取、导出、入模或删除上下文。

## 2. 模块边界

CH 内部拆成八个工程模块。P0 可以先在单机版里实现为一个 `ContextHub` facade 和若干本地模块，后续再迁移为独立包或进程。

| 模块 | P0 职责 | 主要持久化 | 对外接口 |
| --- | --- | --- | --- |
| Source Registry | 管理上下文来源、source scope、connector/resource 引用、freshness key | `sources/*.json` | `sources list/status/probe` |
| Collection Manager | 管理知识库、记忆域、项目上下文集合、Bot 默认域 | `collections/*.json` | `collections list/create/update` |
| Ingestion Pipeline | 解析、切块、摘要、索引、入库、增量刷新 | `ingestion-runs.jsonl`、`records.jsonl`、`chunks.jsonl` | `ingestSource`、`refreshSource` |
| Memory Manager | 记忆候选、确认、拒绝、强化、过期、冲突、遗忘 | `memories.jsonl`、`memory-events.jsonl` | `memory propose/confirm/reject/forget` |
| Context Store | 保存 ContextRecord、Chunk、Memory、Relationship、Snapshot、Audit | JSONL / SQLite | store repository |
| Retrieval Engine | keyword P0、metadata filter、freshness filter、score、引用重建 | `indexes/keyword/*` | `retrieveContext` |
| Policy Bridge | 调用治理中心判断可读、可写、可入模、可导出、可遗忘 | policy audit refs | `checkContextPolicy` |
| Diagnostics | 召回日志、入库日志、记忆事件、source probe、排障摘要 | `recall-history.jsonl`、`diagnostics/*.jsonl` | `diagnostics export/query` |

工程边界规则：

- Source Registry 不保存正文，只保存来源、scope、连接器和 freshness 摘要。
- Ingestion Pipeline 不决定 Bot 是否可以使用结果，只写入带 scope 的记录。
- Retrieval Engine 不直接读取平台文件和 token，只读取 CH store 和受控 `resourceRef/contentRef`。
- Memory Manager 不直接调用 runtime，不把模型输出直接确认为长期记忆。
- Policy Bridge 是所有 read/write/use-in-model/export/forget 的必经检查点。
- Diagnostics 只输出脱敏摘要和引用，不输出未脱敏知识正文、用户消息全文或凭据。

## 3. P0 数据模型清单

P0 先稳定以下类型，字段名应作为后续 TypeScript/JSON Schema/IPC 的事实来源。实现时可以拆文件，但语义不要漂移。

### 3.1 Scope / Actor / Policy

```ts
interface ContextActor {
  actorType: "user" | "bot" | "system" | "scheduler" | "tool" | "runtime";
  actorId: string;
  ownerId?: string;
  displayName?: string;
}

interface ContextScope {
  botId?: string;
  userId?: string;
  ownerId?: string;
  conversationId?: string;
  workspaceId?: string;
  sourceTenantId?: string;
  capabilityRef?: string;
  projectId?: string;
  organizationId?: string;
}

type ContextPolicyAction =
  | "context.read"
  | "context.write"
  | "context.use_in_model"
  | "context.export"
  | "context.forget"
  | "context.admin";

interface ContextPolicyDecision {
  allowed: boolean;
  action: ContextPolicyAction;
  scope: ContextScope;
  obligations: Array<"mask-sensitive" | "cite-source" | "owner-confirm" | "fresh-only" | "no-export">;
  reason?: string;
  auditRef: string;
}
```

约束：

- `scope.botId` 是 P0 默认隔离边界。
- `ownerId` 表示管理责任，不等于所有 Bot 都能读取。
- `workspaceId/projectId/organizationId` 只在明确授权后用于共享。
- Policy 决定必须记录 `auditRef`，召回结果不能只有“允许/拒绝”。

### 3.2 Source / Collection

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
  externalRef?: {
    provider: string;
    id: string;
    url?: string;
  };
  status: "active" | "disabled" | "stale" | "failed" | "needs-auth";
  freshness: ContextFreshness;
  createdAt: string;
  updatedAt: string;
  lastProbedAt?: string;
  lastError?: PlatformErrorSummary;
}

interface ContextCollection {
  collectionId: string;
  name: string;
  kind: "knowledge" | "memory" | "mixed";
  scope: ContextScope;
  sourceIds: string[];
  retention?: ContextRetentionPolicy;
  retrievalPolicy: ContextRetrievalPolicy;
  writePolicy: ContextWritePolicy;
  status: "active" | "paused" | "archived";
  createdAt: string;
  updatedAt: string;
}
```

### 3.3 Freshness / Snapshot

```ts
interface ContextFreshness {
  key: string;
  status: "fresh" | "stale" | "unknown" | "failed";
  checkedAt?: string;
  sourceUpdatedAt?: string;
  contentHash?: string;
  version?: string;
  snapshotId?: string;
  reason?: string;
}

interface ContextSnapshot {
  snapshotId: string;
  sourceId: string;
  freshnessKey: string;
  resourceRef?: string;
  contentHash?: string;
  recordCount: number;
  chunkCount: number;
  createdAt: string;
  createdBy: ContextActor;
}
```

规则：

- `freshness.key` 用于增量判断，优先由外部版本/mtime/hash 组合生成。
- P0 允许 stale-but-marked，但 `fresh-only` 召回必须过滤 stale records。
- 源不可达时不能直接删除旧索引，应标记 `unknown/failed` 并保留可审计状态。

### 3.4 Record / Chunk / Relationship

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
  contentRef?: string;
  contentPreview?: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
  relationships?: ContextRelationship[];
  freshness: ContextFreshness;
  confidence?: number;
  sensitivity: "public" | "internal" | "user-content" | "credential" | "restricted";
  status: "active" | "draft" | "stale" | "superseded" | "deleted";
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

interface ContextChunk {
  chunkId: string;
  recordId: string;
  sourceId: string;
  collectionId: string;
  scope: ContextScope;
  chunkKind: "text" | "qa" | "parent" | "child" | "summary" | "entity";
  contentRef?: string;
  textPreview: string;
  tokenCount?: number;
  ordinal: number;
  parentChunkId?: string;
  previousChunkId?: string;
  nextChunkId?: string;
  metadata?: Record<string, unknown>;
  freshness: ContextFreshness;
  status: "active" | "stale" | "superseded" | "deleted";
  createdAt: string;
  updatedAt: string;
}

interface ContextRelationship {
  relationshipId: string;
  fromRecordId: string;
  toRecordId: string;
  kind: "source" | "previous" | "next" | "parent" | "child" | "entity" | "related" | "contradicts" | "supersedes";
  confidence?: number;
  evidenceRefs?: string[];
}
```

P0 存储建议：

- 正文优先放 `contentRef`，列表和诊断只展示 `contentPreview`。
- `credential/restricted` sensitivity 默认不能入模，除非治理中心显式允许并附带 obligations。
- 删除时记录状态和审计，不保留可恢复正文到普通检索索引。

### 3.5 Memory

```ts
type MemoryTier = "short-term" | "mid-term" | "long-term";

interface ContextMemory {
  memoryId: string;
  recordId: string;
  tier: MemoryTier;
  subject: ContextScope;
  memoryKind: "fact" | "preference" | "instruction" | "project-state" | "relationship" | "summary";
  writeState: "candidate" | "confirmed" | "rejected" | "superseded" | "expired" | "forgotten";
  confidence: number;
  evidenceRefs: string[];
  proposedBy: ContextActor;
  confirmedBy?: ContextActor;
  expiresAt?: string;
  lastReinforcedAt?: string;
  conflictWithMemoryIds?: string[];
  createdAt: string;
  updatedAt: string;
}

interface MemoryCandidate {
  candidateId: string;
  proposedRecord: Omit<ContextRecord, "recordId" | "status">;
  proposedMemory: Omit<ContextMemory, "memoryId" | "recordId" | "writeState" | "createdAt" | "updatedAt">;
  reason: string;
  evidenceRefs: string[];
  risk: "low" | "medium" | "high";
  requiredConfirmation: "none" | "user" | "owner" | "policy";
  createdAt: string;
}
```

规则：

- `short-term` 可以随任务或会话清理，不默认进入长期 store。
- `mid-term` 默认 TTL，适合恢复上下文和近期项目状态。
- `long-term` 必须 confirmed，且必须有 evidenceRefs。
- 冲突不能静默覆盖，必须产生 `contradicts/supersedes` 关系或冲突状态。

### 3.6 Retrieval

```ts
type RetrievalMode = "keyword" | "semantic" | "hybrid" | "graph";

interface ContextRetrieveRequest {
  requestId: string;
  correlationId: string;
  actor: ContextActor;
  scope: ContextScope;
  query: string;
  intent?: string;
  sources?: ContextSourceSelector[];
  memoryTiers?: MemoryTier[];
  retrievalMode: RetrievalMode;
  topK: number;
  freshness?: "fresh-only" | "allow-stale-marked" | "snapshot" | "any";
  metadataFilters?: Record<string, unknown>;
  useInModel?: boolean;
}

interface ContextSourceSelector {
  sourceId?: string;
  collectionId?: string;
  kind?: ContextSourceKind;
  includeStale?: boolean;
}

interface ContextRetrieveRecord {
  recordId: string;
  chunkId?: string;
  sourceId: string;
  collectionId: string;
  type: ContextRecordType;
  memoryTier?: MemoryTier;
  title?: string;
  contentRef?: string;
  textPreview: string;
  score: number;
  confidence?: number;
  freshness: ContextFreshness;
  sensitivity: ContextRecord["sensitivity"];
  citation: ContextCitation;
  policyAuditRef: string;
  metadata?: Record<string, unknown>;
}

interface ContextRetrieveResult {
  requestId: string;
  records: ContextRetrieveRecord[];
  staleRecords: ContextRetrieveRecord[];
  missingPermissions: PolicyObjectRef[];
  partialFailures: ContextPartialFailure[];
  auditRefs: string[];
}
```

## 4. 存储布局

P0 先使用单机本地文件存储，接口按 repository 抽象，后续可以迁移到 SQLite 或独立服务。

```text
state/context-hub/
  sources/
    <source-id>.json
  collections/
    <collection-id>.json
  records.jsonl
  chunks.jsonl
  relationships.jsonl
  memories.jsonl
  memory-candidates.jsonl
  snapshots.jsonl
  ingestion-runs.jsonl
  recall-history.jsonl
  audit-refs.jsonl
  indexes/
    keyword/
      <collection-id>.json
    vector/
      .gitkeep
  diagnostics/
    source-probes.jsonl
    policy-denials.jsonl
    stale-records.jsonl
```

Bot 视图：

```text
state/bots/<bot-id>/context/
  authorized-sources.json
  default-collections.json
  memory-candidates.jsonl
  confirmed-memories.jsonl
  recall-history.jsonl
  used-context.jsonl
```

存储规则：

- `records.jsonl/chunks.jsonl/memories.jsonl` 是 append-friendly 事实日志，最新状态可由 compact 任务生成快照。
- `contentRef/resourceRef` 指向资源中心托管内容，CH 不重复保存大文件和原始附件。
- 任何索引项必须能反查到 record/chunk，并在 forget/delete 后被清理或 tombstone。
- diagnostics 默认脱敏；需要导出正文必须走治理中心。

## 5. 管理面 API

P0 管理面可先作为 Electron IPC / local service API，后续再映射 CLI 或 HTTP。命名先稳定，不绑定传输协议。

| API | 调用方 | 作用 |
| --- | --- | --- |
| `ch.sources.list` | UI / runtime admin | 查看上下文源 |
| `ch.sources.status` | UI / scheduler | 查看 source freshness、last probe、last error |
| `ch.sources.probe` | UI / scheduler | 检测来源是否可达和是否 stale |
| `ch.sources.refresh` | UI / scheduler | 触发增量入库/索引 |
| `ch.collections.list` | UI / runtime | 查看集合 |
| `ch.collections.updatePolicy` | UI / governance | 调整召回和写入策略 |
| `ch.retrieve` | runtime / tool / scheduler | 上下文召回 |
| `ch.recall.trace` | UI / diagnostics | 查看一次回复使用了哪些上下文 |
| `ch.memory.propose` | runtime / scheduler | 创建记忆候选 |
| `ch.memory.listCandidates` | UI | 查看待确认记忆 |
| `ch.memory.confirm` | UI / owner / policy | 确认记忆 |
| `ch.memory.reject` | UI / owner / policy | 拒绝记忆 |
| `ch.memory.forget` | UI / owner / policy | 遗忘记忆并清理索引 |
| `ch.diagnostics.export` | UI | 导出脱敏排障摘要 |

Admin list/status/logs 最小字段：

```ts
interface ContextSourceStatusView {
  sourceId: string;
  displayName: string;
  kind: ContextSourceKind;
  status: ContextSource["status"];
  freshness: ContextFreshness;
  recordCount: number;
  chunkCount: number;
  lastIngestedAt?: string;
  lastError?: PlatformErrorSummary;
}

interface ContextRecallTraceView {
  requestId: string;
  botId?: string;
  queryPreview: string;
  recordIds: string[];
  deniedSourceIds: string[];
  staleRecordIds: string[];
  partialFailures: ContextPartialFailure[];
  createdAt: string;
}
```

## 6. 核心流程

### 6.1 Source 注册

1. 调用方提交 source kind、displayName、scope、connectorRef/resourceRef。
2. CH 调用 Policy Bridge 检查 `context.write` 或 `context.admin`。
3. Source Registry 写入 `ContextSource`。
4. 如果 source 属于 Bot 默认集合，Collection Manager 绑定 sourceId。
5. Diagnostics 写 source-created 事件。

验收点：

- 同一个外部文档可以被多个 Bot 授权，但每个 Bot 的可见性独立。
- 禁止只有路径或 URL、没有 scope 的 source 进入 active 状态。

### 6.2 入库 / 刷新

1. Scheduler 或 UI 调用 `ch.sources.refresh`。
2. Source Adapter 读取 freshness key。
3. 若 freshness 未变化，写入 skipped ingestion run。
4. 若变化，Resource Center 物化受控内容引用。
5. Ingestion Pipeline 解析文本、切块、生成摘要或实体候选。
6. 写入 records/chunks/relationships/snapshot。
7. 更新 keyword index。
8. 旧 record/chunk 标记 superseded 或 stale。
9. Diagnostics 写入 ingestion result。

失败处理：

- 源不可达：source freshness 标记 `unknown/failed`，不删除旧索引。
- 权限失败：source 标记 `needs-auth`，召回时返回 partial failure。
- 解析失败：保留 source，写入 ingestion run failed，并暴露 UI 错误。

### 6.3 上下文召回

1. Runtime / Tool 调用 `ch.retrieve`，传入 actor、scope、query、source selectors、memory tiers。
2. Policy Bridge 对候选 source/collection 做 `context.read`。
3. Retrieval Engine 读取 keyword index 和 memory records。
4. 应用 metadata filter、freshness filter、scope filter。
5. 计算 score，并重建 citation。
6. 若 `useInModel=true`，逐条检查 `context.use_in_model`。
7. 返回 records、staleRecords、missingPermissions、partialFailures、auditRefs。
8. 写 recall-history 和 used-context trace。

硬规则：

- `missingPermissions` 不能被吞掉，UI 和 runtime 应能看见。
- `staleRecords` 不能混入 `records`，除非请求允许 `allow-stale-marked`。
- `restricted/credential` 不能入模，除非 Policy 返回明确 obligation 和 auditRef。

### 6.4 记忆候选

1. Runtime / Scheduler 提供消息摘要、工具结果、用户明确指令或项目状态。
2. Memory Manager 生成 `MemoryCandidate`。
3. Policy Bridge 检查 `context.write`。
4. 对高风险候选标记 `requiredConfirmation=owner`。
5. 写入 `memory-candidates.jsonl`。
6. UI 展示候选、证据、风险和作用 scope。

候选来源：

- 用户明确说“记住/以后都/我的偏好是”。
- 同一事实在多个证据中重复出现。
- 项目状态或任务状态需要跨会话恢复。
- 受信知识源同步出来的长期事实。

禁止来源：

- 单次不确定模型推断。
- 未授权群聊成员的个人信息。
- 低可信工具输出。
- 含凭据、敏感正文或未脱敏客户数据的片段。

### 6.5 记忆确认 / 遗忘

确认：

1. UI / Owner / Policy 调用 `ch.memory.confirm`。
2. 检查 candidate scope 和 evidenceRefs。
3. 检测冲突记忆。
4. 写 ContextRecord + ContextMemory confirmed。
5. 更新 index。
6. 写 audit。

遗忘：

1. UI / Owner / Policy 调用 `ch.memory.forget`。
2. Policy Bridge 检查 `context.forget`。
3. memory 标记 forgotten，record/chunk 删除或 tombstone。
4. keyword/vector index 清理。
5. diagnostics 只保留脱敏审计摘要。

验收点：

- confirmed memory 必须可在 UI 中查看、编辑、删除。
- forget 后召回不能返回正文或旧 chunk。
- 审计可以证明发生过遗忘动作，但不能泄露被遗忘正文。

## 7. 适配器合同

### 7.1 Source Adapter

```ts
interface ContextSourceAdapter {
  kind: ContextSourceKind;
  list(request: ContextSourceListRequest): Promise<ContextSourceItem[]>;
  fetch(request: ContextFetchRequest): Promise<ContextSourceContent>;
  freshness(request: ContextFreshnessRequest): Promise<ContextFreshness>;
}
```

P0 adapter：

- `SkillKnowledgeAdapter`：读取授权 Skill 的 `knowledge/`。
- `LarkCachedFileAdapter`：读取受控飞书缓存协议产物，不直接下载裸文件。
- `ManualMemoryAdapter`：读取用户手工创建的记忆/笔记。
- `ConversationSummaryAdapter`：读取调度/运行时生成的会话摘要引用。

### 7.2 Index Adapter

```ts
interface ContextIndexAdapter {
  index(request: ContextIndexRequest): Promise<ContextIndexResult>;
  remove(request: ContextIndexRemoveRequest): Promise<void>;
  search(request: ContextIndexSearchRequest): Promise<ContextIndexSearchResult>;
  compact(request: ContextIndexCompactRequest): Promise<ContextIndexCompactResult>;
}
```

P0 只要求 keyword index。Vector index 必须挂在 adapter 后面，不能让 runtime 直接依赖具体向量库类型。

### 7.3 Policy Bridge

```ts
interface ContextPolicyBridge {
  check(request: ContextPolicyCheckRequest): Promise<ContextPolicyDecision>;
  recordAudit(request: ContextAuditRequest): Promise<ContextAuditRef>;
}
```

P0 可以先接现有 Bot 授权和本地配置，接口必须为未来治理中心预留。

## 8. UI / 可见性

P0 管理面至少包含：

- Sources：名称、类型、Bot scope、freshness、last probe、last indexed、record/chunk count、last error。
- Collections：集合类型、绑定 sources、检索策略、写入策略、retention。
- Recall Test：输入 query，选择 Bot/source/memory tier，查看 records/stale/denied/partial failures。
- Memory Candidates：候选内容摘要、证据、风险、确认/拒绝。
- Confirmed Memories：按 Bot/user/conversation/project 过滤，支持编辑、supersede、forget。
- Recall Trace：某次 runtime 使用了哪些上下文，哪些被拒绝，哪些 stale。
- Diagnostics：source probe、ingestion runs、policy denials、forget events。

UI 原则：

- 让用户看到“为什么没有召回”和“召回的是不是过期的”。
- 长期记忆必须可见、可改、可删。
- 不展示完整敏感正文；需要查看时走受控打开和权限检查。

## 9. 清理与保留策略

P0 清理规则：

| 数据 | 默认保留 | 清理方式 |
| --- | --- | --- |
| short-term memory | 任务结束或 24 小时 | 定时清理 |
| mid-term memory candidate | 30 天 | 过期变 expired |
| rejected candidate | 30 天 | 保留脱敏审计后清理正文 |
| confirmed long-term memory | 直到用户删除或策略过期 | forget/supersede |
| recall-history | 30 天 | 脱敏压缩或删除 |
| ingestion-runs | 90 天 | 保留摘要 |
| stale records | 30 天或下一次 compact | tombstone/compact |
| deleted/forgotten content | 立即不可召回 | 只保留脱敏 audit |

空间清理必须同时处理：

- records/chunks 正文引用。
- keyword/vector index。
- memory candidate 正文。
- recall trace 中的 preview。
- diagnostics 中可能残留的 source title/path。

## 10. 迁移路径

### 阶段一：单机版 facade

- 在 `QuarkfanTools-Single/` 内新增 `ContextHub` facade。
- 先接 Skill `knowledge/` 和受控飞书缓存。
- Runtime 不再直接拼接知识来源，而是调用 `retrieveContext`。
- 保持现有用户行为不变。

### 阶段二：本地 store 和管理面

- 增加 `state/context-hub/` 本地存储。
- 增加 source list、fresh/stale、recall trace、memory candidates UI。
- 定时任务接入 source refresh。
- 空间清理接入 CH retention。

### 阶段三：记忆治理

- 接入会话摘要作为 mid-term candidate。
- 支持手工确认 long-term memory。
- 支持 forget、supersede、conflict。
- Runtime 使用 confirmed memory 和 recent summary。

### 阶段四：索引增强

- 将 keyword index 抽象为 adapter。
- 评估轻量 vector store，优先 macOS 打包稳定性。
- 接入 rerank/embedding 时走模型中心。
- 增加 source-level snapshot 和增量刷新。

### 阶段五：独立模块实现

- 将 facade 内部实现逐步迁移到 `Context-Hub/`。
- 保留单机版本地调用适配层。
- 根据产品路线决定是否拆独立进程或本地服务。

## 11. 测试矩阵

P0 必须覆盖以下测试：

| 类型 | 场景 | 期望 |
| --- | --- | --- |
| Source | 注册无 scope source | 拒绝或 disabled |
| Source | 飞书缓存不可达 | 标记 failed/unknown，不删除旧索引 |
| Ingestion | 同一 source freshness 未变化 | 跳过入库并记录 skipped |
| Ingestion | 文档更新 | 新 record active，旧 record stale/superseded |
| Retrieval | Bot 未授权 source | 返回 missingPermissions |
| Retrieval | fresh-only + stale record | stale 不进入 records |
| Retrieval | allow-stale-marked | stale 进入 staleRecords 或带标记返回 |
| Retrieval | restricted record useInModel | 需要 policy allow，否则过滤 |
| Memory | 模型单次推断 | 只能成为 candidate 或被拒绝，不能 confirmed |
| Memory | Owner 确认 | candidate 变 confirmed 并可召回 |
| Memory | 冲突事实 | 标记 conflict/contradicts，不静默覆盖 |
| Memory | forget | 正文和索引不可召回，仅保留脱敏 audit |
| Cleanup | retention 到期 | candidate/trace 按策略清理 |
| Diagnostics | 导出排障包 | 不含凭据、未脱敏正文和用户完整消息 |

## 12. 验收标准

P0 可认为完成，当且仅当：

1. Runtime 获取 Skill knowledge / 飞书缓存 / 会话摘要 / confirmed memory 都通过 CH facade。
2. Bot scope 能阻止未授权 source 或其他 Bot memory 被召回。
3. 一次召回可以在 UI 或日志里看到 source、record、freshness、score、policy audit 和 missing permissions。
4. 用户可以确认、拒绝、遗忘长期记忆。
5. Source 不可达、权限失败、stale、部分失败都可见。
6. 空间清理能覆盖 CH records、chunks、index、memory candidates、recall trace 和 diagnostics。
7. 文档中的 DTO、API、状态机和测试矩阵至少有一组实现或合同测试对应。

## 13. 当前建议

- P0 从 keyword retrieval 开始，先把边界、权限、freshness、可见性和记忆治理做稳。
- 不急于接向量库；向量能力应在 Index Adapter 稳定后进入。
- 第二批 memory 参考项目应在实现长期记忆前完成源码级评估，尤其关注 deletion、conflict、temporal validity 和 user-visible editing。
- CH 的价值不是“把更多内容塞进 prompt”，而是让 runtime 使用的上下文变得可授权、可解释、可更新、可删除、可审计。
