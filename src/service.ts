import { createHash, randomUUID } from "node:crypto";
import type { ContextRepository } from "./repository.js";
import type {
  ContextBinding,
  ContextMemory,
  ContextRecord,
  ContextSource,
  RetrieveRequest,
  RetrievedContext,
} from "./types.js";
import { HubError } from "./platform.js";
import {
  createContextExtensions,
  type ExtensionStateRepository,
} from "./extensions.js";
const now = () => new Date().toISOString(),
  hash = (v: string) => createHash("sha256").update(v).digest("hex"),
  stableUuid = (v: string) => {
    const digest = hash(v),
      variant = ((Number.parseInt(digest[16]!, 16) & 0x3) | 0x8).toString(16);
    return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  };
const words = (v: string) => [
  ...new Set(
    v
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((x) => x.length > 1),
  ),
];
export class ContextHubService {
  readonly extensions;
  constructor(
    readonly repo: ContextRepository,
    extensionRepository?: ExtensionStateRepository,
  ) {
    this.extensions = createContextExtensions(extensionRepository);
  }
  async source(id: string) {
    const v = await this.repo.getSource(id);
    if (!v) throw new HubError("NOT_FOUND", `Source not found: ${id}`, 404);
    return v;
  }
  async saveSource(
    i: Partial<ContextSource> & Pick<ContextSource, "name" | "kind">,
  ) {
    this.extensions.require(`context-source.${i.kind}`);
    const old = i.id ? await this.repo.getSource(i.id) : undefined,
      n = now();
    return this.repo.saveSource({
      id: i.id ?? randomUUID(),
      name: i.name,
      kind: i.kind,
      enabled: i.enabled ?? old?.enabled ?? true,
      scope: i.scope ?? old?.scope ?? {},
      config: i.config ?? old?.config ?? {},
      freshnessTtlSeconds: i.freshnessTtlSeconds ?? old?.freshnessTtlSeconds,
      lastIngestedAt: old?.lastIngestedAt,
      lastError: old?.lastError,
      status:
        (i.enabled ?? old?.enabled) === false
          ? "disabled"
          : (old?.status ?? "configured"),
      createdAt: old?.createdAt ?? n,
      updatedAt: n,
    });
  }
  async removeSource(id: string) {
    const source = await this.source(id);
    if (source.config.managedType === "runtime-transcript")
      throw new HubError(
        "CONFLICT",
        "Runtime transcript sources are managed by the platform",
        409,
      );
    const bindings = (await this.repo.listBindings()).filter(
      (binding) => binding.sourceId === id,
    );
    if (bindings.length)
      throw new HubError(
        "CONFLICT",
        "Context source is still bound to bots",
        409,
        { bindingIds: bindings.map((binding) => binding.id) },
      );
    await this.repo.removeSource(id);
    return { removed: true };
  }
  async binding(id: string) {
    const value = (await this.repo.listBindings()).find(
      (binding) => binding.id === id,
    );
    if (!value)
      throw new HubError("NOT_FOUND", `Binding not found: ${id}`, 404);
    return value;
  }
  async removeBinding(id: string) {
    await this.binding(id);
    await this.repo.removeBinding(id);
    return { removed: true };
  }
  async saveBinding(
    i: Partial<ContextBinding> & Pick<ContextBinding, "sourceId" | "botId">,
  ) {
    await this.source(i.sourceId);
    const old = i.id
        ? (await this.repo.listBindings()).find(
            (binding) => binding.id === i.id,
          )
        : undefined,
      n = now();
    return this.repo.saveBinding({
      id: i.id ?? randomUUID(),
      sourceId: i.sourceId,
      botId: i.botId,
      enabled: i.enabled ?? old?.enabled ?? true,
      priority: i.priority ?? old?.priority ?? 100,
      maxAgeSeconds: i.maxAgeSeconds ?? old?.maxAgeSeconds,
      tags: i.tags ?? old?.tags ?? [],
      createdAt: old?.createdAt ?? n,
      updatedAt: n,
    });
  }
  async ingest(
    sourceId: string,
    items: Array<Partial<ContextRecord> & Pick<ContextRecord, "content">>,
  ) {
    const source = await this.source(sourceId);
    this.extensions.require(`context-source.${source.kind}`);
    if (!source.enabled)
      throw new HubError("UNAVAILABLE", "Source is disabled", 409);
    const results = [];
    for (const i of items) {
      const n = now();
      results.push(
        await this.repo.saveRecord({
          id: i.id ?? randomUUID(),
          sourceId,
          externalId: i.externalId,
          title: i.title,
          content: i.content,
          contentHash: hash(i.content),
          mimeType: i.mimeType,
          resourceRef: i.resourceRef,
          metadata: i.metadata ?? {},
          tags: i.tags ?? [],
          scope: i.scope ?? {},
          sourceUpdatedAt: i.sourceUpdatedAt,
          ingestedAt: n,
          expiresAt: i.expiresAt,
          createdAt: n,
          updatedAt: n,
        }),
      );
    }
    source.lastIngestedAt = now();
    source.status = "ready";
    source.lastError = undefined;
    source.updatedAt = source.lastIngestedAt;
    await this.repo.saveSource(source);
    return {
      sourceId,
      created: results.filter((x) => x.created).length,
      updated: results.filter((x) => !x.created).length,
      records: results.map((x) => x.record),
    };
  }
  async recordTranscript(input: {
    tenantId: string;
    botId: string;
    executionId: string;
    sessionId: string;
    workspaceId: string;
    conversationId?: string;
    userId?: string;
    prompt: string;
    response: string;
    runtime: string;
    status: string;
    resourceRefs?: string[];
    eventRefs?: string[];
    createdAt: string;
    finishedAt?: string;
    retentionDays?: number;
  }) {
    let source = (await this.repo.listSources()).find(
      (item) =>
        item.kind === "conversation" &&
        item.scope.tenantId === input.tenantId &&
        item.config.managedType === "runtime-transcript",
    );
    if (!source)
      source = await this.saveSource({
        id: stableUuid(`runtime-transcript-source:${input.tenantId}`),
        name: `Runtime transcripts (${input.tenantId})`,
        kind: "conversation",
        scope: { tenantId: input.tenantId },
        config: {
          managedType: "runtime-transcript",
          retentionDays: input.retentionDays ?? 90,
        },
      });
    const bindings = await this.repo.listBindings(input.botId);
    if (!bindings.some((item) => item.sourceId === source!.id))
      await this.saveBinding({
        id: stableUuid(
          `runtime-transcript-binding:${source.id}:${input.botId}`,
        ),
        sourceId: source.id,
        botId: input.botId,
        priority: 10,
        tags: ["transcript"],
      });
    const retentionDays = Math.min(
      3650,
      Math.max(
        1,
        input.retentionDays ?? Number(source.config.retentionDays ?? 90),
      ),
    );
    const [result] = (
      await this.ingest(source.id, [
        {
          externalId: `execution:${input.executionId}`,
          title: `Execution ${input.executionId}`,
          content: `User:\n${input.prompt}\n\nAssistant:\n${input.response}`,
          mimeType: "text/plain",
          resourceRef: `execution:${input.executionId}`,
          metadata: {
            type: "execution-transcript",
            tenantId: input.tenantId,
            botId: input.botId,
            executionId: input.executionId,
            sessionId: input.sessionId,
            workspaceId: input.workspaceId,
            conversationId: input.conversationId,
            runtime: input.runtime,
            status: input.status,
            resourceRefs: [...new Set(input.resourceRefs ?? [])],
            eventRefs: [...new Set(input.eventRefs ?? [])],
            createdAt: input.createdAt,
            finishedAt: input.finishedAt,
          },
          tags: ["transcript", input.runtime, input.status],
          scope: {
            botIds: [input.botId],
            workspaceIds: [input.workspaceId],
            conversationIds: input.conversationId
              ? [input.conversationId]
              : undefined,
            userIds: input.userId ? [input.userId] : undefined,
          },
          sourceUpdatedAt: input.finishedAt ?? input.createdAt,
          expiresAt: new Date(
            Date.now() + retentionDays * 86400_000,
          ).toISOString(),
        },
      ])
    ).records;
    return { sourceId: source.id, record: result };
  }
  async transcripts(filter: {
    tenantId?: string;
    botId?: string;
    conversationId?: string;
    limit: number;
  }) {
    const sourceIds = (await this.repo.listSources())
      .filter(
        (item) =>
          item.kind === "conversation" &&
          item.config.managedType === "runtime-transcript" &&
          (!filter.tenantId || item.scope.tenantId === filter.tenantId),
      )
      .map((item) => item.id);
    return (await this.repo.listRecords())
      .filter(
        (record) =>
          sourceIds.includes(record.sourceId) &&
          record.metadata.type === "execution-transcript" &&
          (!filter.botId || record.metadata.botId === filter.botId) &&
          (!filter.conversationId ||
            record.metadata.conversationId === filter.conversationId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit);
  }
  async retrieve(r: RetrieveRequest) {
    const bindings = (await this.repo.listBindings(r.botId)).filter(
        (x) => x.enabled,
      ),
      sourceIds: string[] = [];
    const freshnessBySource = new Map<string, RetrievedContext["freshness"]>();
    for (const b of bindings.sort((a, b) => b.priority - a.priority)) {
      const s = await this.repo.getSource(b.sourceId);
      if (!s?.enabled) continue;
      if (s.scope.botIds && !s.scope.botIds.includes(r.botId)) continue;
      if (
        s.scope.workspaceIds &&
        (!r.workspaceId || !s.scope.workspaceIds.includes(r.workspaceId))
      )
        continue;
      const age = s.lastIngestedAt
          ? (Date.now() - new Date(s.lastIngestedAt).getTime()) / 1000
          : Infinity,
        ttl = b.maxAgeSeconds ?? s.freshnessTtlSeconds,
        freshness =
          ttl === undefined ? "unknown" : age <= ttl ? "fresh" : "stale";
      if (freshness === "stale") continue;
      sourceIds.push(s.id);
      freshnessBySource.set(s.id, freshness);
    }
    const found = await this.repo.searchRecords(r, sourceIds),
      contexts: RetrievedContext[] = found.map((x) => ({
        id: x.record.id,
        kind: "record",
        sourceId: x.record.sourceId,
        title: x.record.title,
        content: x.record.content,
        score: x.score,
        confidence: Math.min(1, Math.max(0, x.score)),
        freshness: freshnessBySource.get(x.record.sourceId) ?? "unknown",
        scope: x.record.scope,
        metadata: {
          ...x.record.metadata,
          resourceRef: x.record.resourceRef,
          tags: x.record.tags,
        },
      }));
    if (r.includeMemory) {
      const q = words(r.query);
      for (const m of await this.repo.listMemories({
        botId: r.botId,
        status: "confirmed",
      })) {
        if (
          (m.expiresAt && m.expiresAt <= now()) ||
          (m.workspaceId && m.workspaceId !== r.workspaceId) ||
          (m.conversationId && m.conversationId !== r.conversationId) ||
          (m.userId && m.userId !== r.userId)
        )
          continue;
        const text = m.content.toLocaleLowerCase(),
          score = q.length
            ? q.filter((x) => text.includes(x)).length / q.length
            : 0;
        if (score > 0)
          contexts.push({
            id: m.id,
            kind: "memory",
            content: m.content,
            score: score * m.confidence,
            confidence: m.confidence,
            freshness: "fresh",
            scope: {
              botId: m.botId,
              userId: m.userId,
              conversationId: m.conversationId,
              workspaceId: m.workspaceId,
            },
            metadata: { layer: m.layer, evidenceRefs: m.evidenceRefs },
          });
      }
    }
    contexts.sort((a, b) => b.score - a.score);
    const selected = contexts.slice(0, r.limit),
      traceId = randomUUID();
    await this.repo.appendTrace({
      id: traceId,
      botId: r.botId,
      operation: "retrieve",
      query: r.query,
      candidateIds: contexts.map((x) => x.id),
      selectedIds: selected.map((x) => x.id),
      correlationId: r.correlationId,
      metadata: { sourceIds, limit: r.limit, includeMemory: r.includeMemory },
      createdAt: now(),
    });
    return { items: selected, traceId, totalCandidates: contexts.length };
  }
  async createMemory(i: {
    botId: string;
    userId?: string;
    conversationId?: string;
    workspaceId?: string;
    layer: ContextMemory["layer"];
    content: string;
    confidence: number;
    evidenceRefs: string[];
    correlationId: string;
  }) {
    if (i.layer === "long" && !i.evidenceRefs.length)
      throw new HubError(
        "INVALID_REQUEST",
        "Long-term memory candidate requires evidence",
        400,
      );
    const n = now(),
      traceId = randomUUID(),
      memory: ContextMemory = {
        id: randomUUID(),
        botId: i.botId,
        userId: i.userId,
        conversationId: i.conversationId,
        workspaceId: i.workspaceId,
        layer: i.layer,
        content: i.content,
        status: "candidate",
        confidence: i.confidence,
        evidenceRefs: i.evidenceRefs,
        generationTraceId: traceId,
        createdAt: n,
        updatedAt: n,
      };
    await this.repo.saveMemory(memory);
    await this.repo.appendTrace({
      id: traceId,
      botId: i.botId,
      operation: "memory-candidate",
      candidateIds: [memory.id],
      selectedIds: [],
      correlationId: i.correlationId,
      metadata: { layer: i.layer, evidenceCount: i.evidenceRefs.length },
      createdAt: n,
    });
    return memory;
  }
  async memory(id: string) {
    const v = await this.repo.getMemory(id);
    if (!v) throw new HubError("NOT_FOUND", `Memory not found: ${id}`, 404);
    return v;
  }
  async confirmMemory(id: string, actorId: string, correlationId: string) {
    const v = await this.memory(id);
    if (v.status !== "candidate")
      throw new HubError(
        "CONFLICT",
        `Memory cannot be confirmed from ${v.status}`,
        409,
      );
    v.status = "confirmed";
    v.confirmedBy = actorId;
    v.confirmedAt = now();
    v.updatedAt = v.confirmedAt;
    await this.repo.saveMemory(v);
    await this.repo.appendTrace({
      id: randomUUID(),
      botId: v.botId,
      operation: "memory-confirm",
      candidateIds: [id],
      selectedIds: [id],
      correlationId,
      metadata: { actorId },
      createdAt: now(),
    });
    return v;
  }
  async forgetMemory(id: string, reason: string, correlationId: string) {
    const v = await this.memory(id);
    if (v.status === "forgotten") return v;
    v.status = "forgotten";
    v.forgottenAt = now();
    v.forgetReason = reason;
    v.updatedAt = v.forgottenAt;
    await this.repo.saveMemory(v);
    await this.repo.appendTrace({
      id: randomUUID(),
      botId: v.botId,
      operation: "memory-forget",
      candidateIds: [id],
      selectedIds: [],
      correlationId,
      metadata: { reason },
      createdAt: now(),
    });
    return v;
  }
  async freshness() {
    return (await this.repo.listSources()).map((s) => {
      const age = s.lastIngestedAt
        ? (Date.now() - new Date(s.lastIngestedAt).getTime()) / 1000
        : undefined;
      return {
        id: s.id,
        name: s.name,
        status: s.status,
        ageSeconds: age,
        ttlSeconds: s.freshnessTtlSeconds,
        fresh:
          s.enabled &&
          age !== undefined &&
          (s.freshnessTtlSeconds === undefined || age <= s.freshnessTtlSeconds),
      };
    });
  }
}
