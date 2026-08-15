import type {
  ContextBinding,
  ContextMemory,
  ContextRecord,
  ContextSource,
  GenerationTrace,
  RetrieveRequest,
} from "./types.js";
export interface ContextRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<boolean>;
  listSources(): Promise<ContextSource[]>;
  getSource(id: string): Promise<ContextSource | undefined>;
  saveSource(v: ContextSource): Promise<ContextSource>;
  removeSource(id: string): Promise<boolean>;
  listBindings(botId?: string): Promise<ContextBinding[]>;
  saveBinding(v: ContextBinding): Promise<ContextBinding>;
  removeBinding(id: string): Promise<boolean>;
  saveRecord(
    v: ContextRecord,
  ): Promise<{ record: ContextRecord; created: boolean }>;
  listRecords(sourceId?: string): Promise<ContextRecord[]>;
  searchRecords(
    request: RetrieveRequest,
    sourceIds: string[],
  ): Promise<Array<{ record: ContextRecord; score: number }>>;
  listMemories(filter: {
    botId: string;
    status?: ContextMemory["status"];
  }): Promise<ContextMemory[]>;
  getMemory(id: string): Promise<ContextMemory | undefined>;
  saveMemory(v: ContextMemory): Promise<ContextMemory>;
  appendTrace(v: GenerationTrace): Promise<void>;
  listTraces(filter: {
    botId?: string;
    correlationId?: string;
    limit: number;
  }): Promise<GenerationTrace[]>;
}
const tokens = (v: string) => [
  ...new Set(
    v
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((x) => x.length > 1),
  ),
];
export class MemoryContextRepository implements ContextRepository {
  sources = new Map<string, ContextSource>();
  bindings = new Map<string, ContextBinding>();
  records = new Map<string, ContextRecord>();
  recordKeys = new Map<string, string>();
  memories = new Map<string, ContextMemory>();
  traces: GenerationTrace[] = [];
  async migrate() {}
  async close() {}
  async ping() {
    return true;
  }
  async listSources() {
    return [...this.sources.values()];
  }
  async getSource(id: string) {
    return this.sources.get(id);
  }
  async saveSource(v: ContextSource) {
    this.sources.set(v.id, structuredClone(v));
    return v;
  }
  async removeSource(id: string) {
    return this.sources.delete(id);
  }
  async listBindings(botId?: string) {
    return [...this.bindings.values()].filter(
      (x) => !botId || x.botId === botId,
    );
  }
  async saveBinding(v: ContextBinding) {
    this.bindings.set(v.id, structuredClone(v));
    return v;
  }
  async removeBinding(id: string) {
    return this.bindings.delete(id);
  }
  async saveRecord(v: ContextRecord) {
    const key = `${v.sourceId}:${v.externalId ?? v.contentHash}`,
      id = this.recordKeys.get(key);
    if (id) {
      const old = this.records.get(id)!;
      const next = { ...v, id: old.id, createdAt: old.createdAt };
      this.records.set(id, next);
      return { record: next, created: false };
    }
    this.recordKeys.set(key, v.id);
    this.records.set(v.id, structuredClone(v));
    return { record: v, created: true };
  }
  async listRecords(sourceId?: string) {
    return [...this.records.values()].filter(
      (x) => !sourceId || x.sourceId === sourceId,
    );
  }
  async searchRecords(r: RetrieveRequest, sourceIds: string[]) {
    const q = tokens(r.query);
    return [...this.records.values()]
      .filter(
        (x) =>
          sourceIds.includes(x.sourceId) &&
          !x.deletedAt &&
          (!x.expiresAt || x.expiresAt > new Date().toISOString()) &&
          (!x.scope.botIds || x.scope.botIds.includes(r.botId)) &&
          (!x.scope.workspaceIds ||
            (!!r.workspaceId &&
              x.scope.workspaceIds.includes(r.workspaceId))) &&
          (!x.scope.conversationIds ||
            (!!r.conversationId &&
              x.scope.conversationIds.includes(r.conversationId))) &&
          (!x.scope.userIds ||
            (!!r.userId && x.scope.userIds.includes(r.userId))) &&
          (!r.tags?.length || r.tags.some((t) => x.tags.includes(t))),
      )
      .map((record) => {
        const text =
          `${record.title ?? ""} ${record.content}`.toLocaleLowerCase();
        const score = q.length
          ? q.filter((t) => text.includes(t)).length / q.length
          : 0;
        return { record, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, r.limit);
  }
  async listMemories(f: { botId: string; status?: ContextMemory["status"] }) {
    return [...this.memories.values()].filter(
      (x) => x.botId === f.botId && (!f.status || x.status === f.status),
    );
  }
  async getMemory(id: string) {
    return this.memories.get(id);
  }
  async saveMemory(v: ContextMemory) {
    this.memories.set(v.id, structuredClone(v));
    return v;
  }
  async appendTrace(v: GenerationTrace) {
    this.traces.unshift(structuredClone(v));
  }
  async listTraces(f: {
    botId?: string;
    correlationId?: string;
    limit: number;
  }) {
    return this.traces
      .filter(
        (x) =>
          (!f.botId || x.botId === f.botId) &&
          (!f.correlationId || x.correlationId === f.correlationId),
      )
      .slice(0, f.limit);
  }
}
