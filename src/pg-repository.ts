import { Pool } from "pg";
import type { ContextRepository } from "./repository.js";
import type {
  ContextBinding,
  ContextMemory,
  ContextRecord,
  ContextSource,
  GenerationTrace,
  RetrieveRequest,
} from "./types.js";
const schema = `CREATE SCHEMA IF NOT EXISTS ch;
CREATE TABLE IF NOT EXISTS ch.sources(id uuid PRIMARY KEY,name text NOT NULL,kind text NOT NULL,enabled boolean NOT NULL,scope jsonb NOT NULL DEFAULT '{}',config jsonb NOT NULL DEFAULT '{}',freshness_ttl_seconds integer,last_ingested_at timestamptz,last_error text,status text NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS ch.bindings(id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES ch.sources(id) ON DELETE CASCADE,bot_id text NOT NULL,enabled boolean NOT NULL,priority integer NOT NULL,max_age_seconds integer,tags text[] NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,UNIQUE(source_id,bot_id));
CREATE TABLE IF NOT EXISTS ch.records(id uuid PRIMARY KEY,source_id uuid NOT NULL REFERENCES ch.sources(id) ON DELETE CASCADE,external_id text,title text,content text NOT NULL,content_hash text NOT NULL,mime_type text,resource_ref text,metadata jsonb NOT NULL DEFAULT '{}',tags text[] NOT NULL DEFAULT '{}',scope jsonb NOT NULL DEFAULT '{}',source_updated_at timestamptz,ingested_at timestamptz NOT NULL,expires_at timestamptz,deleted_at timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,search_vector tsvector GENERATED ALWAYS AS(to_tsvector('simple',coalesce(title,'')||' '||content)) STORED);
CREATE UNIQUE INDEX IF NOT EXISTS records_source_external_uq ON ch.records(source_id,external_id) WHERE external_id IS NOT NULL;CREATE UNIQUE INDEX IF NOT EXISTS records_source_hash_uq ON ch.records(source_id,content_hash) WHERE external_id IS NULL;CREATE INDEX IF NOT EXISTS records_search_idx ON ch.records USING gin(search_vector);CREATE INDEX IF NOT EXISTS records_tags_idx ON ch.records USING gin(tags);
CREATE TABLE IF NOT EXISTS ch.memories(id uuid PRIMARY KEY,bot_id text NOT NULL,user_id text,conversation_id text,workspace_id text,layer text NOT NULL,content text NOT NULL,status text NOT NULL,confidence double precision NOT NULL,evidence_refs text[] NOT NULL DEFAULT '{}',generation_trace_id uuid,confirmed_by text,confirmed_at timestamptz,forgotten_at timestamptz,forget_reason text,expires_at timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);CREATE INDEX IF NOT EXISTS memories_lookup_idx ON ch.memories(bot_id,status,updated_at DESC);
CREATE TABLE IF NOT EXISTS ch.generation_traces(id uuid PRIMARY KEY,bot_id text NOT NULL,operation text NOT NULL,query text,candidate_ids text[] NOT NULL DEFAULT '{}',selected_ids text[] NOT NULL DEFAULT '{}',policy_decision_id text,correlation_id text NOT NULL,metadata jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL);CREATE INDEX IF NOT EXISTS generation_traces_lookup_idx ON ch.generation_traces(bot_id,correlation_id,created_at DESC);`;
const iso = (v: Date | null) => v?.toISOString();
const source = (r: any): ContextSource => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  enabled: r.enabled,
  scope: r.scope,
  config: r.config,
  freshnessTtlSeconds: r.freshness_ttl_seconds ?? undefined,
  lastIngestedAt: iso(r.last_ingested_at),
  lastError: r.last_error ?? undefined,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
const binding = (r: any): ContextBinding => ({
  id: r.id,
  sourceId: r.source_id,
  botId: r.bot_id,
  enabled: r.enabled,
  priority: r.priority,
  maxAgeSeconds: r.max_age_seconds ?? undefined,
  tags: r.tags,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
const record = (r: any): ContextRecord => ({
  id: r.id,
  sourceId: r.source_id,
  externalId: r.external_id ?? undefined,
  title: r.title ?? undefined,
  content: r.content,
  contentHash: r.content_hash,
  mimeType: r.mime_type ?? undefined,
  resourceRef: r.resource_ref ?? undefined,
  metadata: r.metadata,
  tags: r.tags,
  scope: r.scope,
  sourceUpdatedAt: iso(r.source_updated_at),
  ingestedAt: r.ingested_at.toISOString(),
  expiresAt: iso(r.expires_at),
  deletedAt: iso(r.deleted_at),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
const memory = (r: any): ContextMemory => ({
  id: r.id,
  botId: r.bot_id,
  userId: r.user_id ?? undefined,
  conversationId: r.conversation_id ?? undefined,
  workspaceId: r.workspace_id ?? undefined,
  layer: r.layer,
  content: r.content,
  status: r.status,
  confidence: r.confidence,
  evidenceRefs: r.evidence_refs,
  generationTraceId: r.generation_trace_id ?? undefined,
  confirmedBy: r.confirmed_by ?? undefined,
  confirmedAt: iso(r.confirmed_at),
  forgottenAt: iso(r.forgotten_at),
  forgetReason: r.forget_reason ?? undefined,
  expiresAt: iso(r.expires_at),
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
const trace = (r: any): GenerationTrace => ({
  id: r.id,
  botId: r.bot_id,
  operation: r.operation,
  query: r.query ?? undefined,
  candidateIds: r.candidate_ids,
  selectedIds: r.selected_ids,
  policyDecisionId: r.policy_decision_id ?? undefined,
  correlationId: r.correlation_id,
  metadata: r.metadata,
  createdAt: r.created_at.toISOString(),
});
export class PgContextRepository implements ContextRepository {
  private pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 10 });
  }
  async migrate() {
    await this.pool.query(schema);
  }
  async close() {
    await this.pool.end();
  }
  async ping() {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
  async listSources() {
    return (
      await this.pool.query("SELECT * FROM ch.sources ORDER BY name")
    ).rows.map(source);
  }
  async getSource(id: string) {
    const r = (
      await this.pool.query("SELECT * FROM ch.sources WHERE id=$1", [id])
    ).rows[0];
    return r ? source(r) : undefined;
  }
  async saveSource(v: ContextSource) {
    const r = (
      await this.pool.query(
        `INSERT INTO ch.sources(id,name,kind,enabled,scope,config,freshness_ttl_seconds,last_ingested_at,last_error,status,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)ON CONFLICT(id)DO UPDATE SET name=EXCLUDED.name,kind=EXCLUDED.kind,enabled=EXCLUDED.enabled,scope=EXCLUDED.scope,config=EXCLUDED.config,freshness_ttl_seconds=EXCLUDED.freshness_ttl_seconds,last_ingested_at=EXCLUDED.last_ingested_at,last_error=EXCLUDED.last_error,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at RETURNING *`,
        [
          v.id,
          v.name,
          v.kind,
          v.enabled,
          v.scope,
          v.config,
          v.freshnessTtlSeconds ?? null,
          v.lastIngestedAt ?? null,
          v.lastError ?? null,
          v.status,
          v.createdAt,
          v.updatedAt,
        ],
      )
    ).rows[0];
    return source(r);
  }
  async removeSource(id: string) {
    return (
      (await this.pool.query("DELETE FROM ch.sources WHERE id=$1", [id]))
        .rowCount === 1
    );
  }
  async listBindings(botId?: string) {
    return (
      await this.pool.query(
        `SELECT * FROM ch.bindings ${botId ? "WHERE bot_id=$1" : ""} ORDER BY priority DESC`,
        botId ? [botId] : [],
      )
    ).rows.map(binding);
  }
  async saveBinding(v: ContextBinding) {
    const r = (
      await this.pool.query(
        `INSERT INTO ch.bindings(id,source_id,bot_id,enabled,priority,max_age_seconds,tags,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)ON CONFLICT(source_id,bot_id)DO UPDATE SET enabled=EXCLUDED.enabled,priority=EXCLUDED.priority,max_age_seconds=EXCLUDED.max_age_seconds,tags=EXCLUDED.tags,updated_at=EXCLUDED.updated_at RETURNING *`,
        [
          v.id,
          v.sourceId,
          v.botId,
          v.enabled,
          v.priority,
          v.maxAgeSeconds ?? null,
          v.tags,
          v.createdAt,
          v.updatedAt,
        ],
      )
    ).rows[0];
    return binding(r);
  }
  async removeBinding(id: string) {
    return (
      (await this.pool.query("DELETE FROM ch.bindings WHERE id=$1", [id]))
        .rowCount === 1
    );
  }
  async saveRecord(v: ContextRecord) {
    const old = (
      await this.pool.query(
        v.externalId
          ? "SELECT id FROM ch.records WHERE source_id=$1 AND external_id=$2"
          : "SELECT id FROM ch.records WHERE source_id=$1 AND external_id IS NULL AND content_hash=$2",
        [v.sourceId, v.externalId ?? v.contentHash],
      )
    ).rows[0];
    if (old) {
      const r = (
        await this.pool.query(
          `UPDATE ch.records SET title=$2,content=$3,content_hash=$4,mime_type=$5,resource_ref=$6,metadata=$7,tags=$8,scope=$9,source_updated_at=$10,ingested_at=$11,expires_at=$12,deleted_at=$13,updated_at=$14 WHERE id=$1 RETURNING *`,
          [
            old.id,
            v.title ?? null,
            v.content,
            v.contentHash,
            v.mimeType ?? null,
            v.resourceRef ?? null,
            v.metadata,
            v.tags,
            v.scope,
            v.sourceUpdatedAt ?? null,
            v.ingestedAt,
            v.expiresAt ?? null,
            v.deletedAt ?? null,
            v.updatedAt,
          ],
        )
      ).rows[0];
      return { record: record(r), created: false };
    }
    const r = (
      await this.pool.query(
        `INSERT INTO ch.records(id,source_id,external_id,title,content,content_hash,mime_type,resource_ref,metadata,tags,scope,source_updated_at,ingested_at,expires_at,deleted_at,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)RETURNING *`,
        [
          v.id,
          v.sourceId,
          v.externalId ?? null,
          v.title ?? null,
          v.content,
          v.contentHash,
          v.mimeType ?? null,
          v.resourceRef ?? null,
          v.metadata,
          v.tags,
          v.scope,
          v.sourceUpdatedAt ?? null,
          v.ingestedAt,
          v.expiresAt ?? null,
          v.deletedAt ?? null,
          v.createdAt,
          v.updatedAt,
        ],
      )
    ).rows[0];
    return { record: record(r), created: true };
  }
  async listRecords(sourceId?: string) {
    return (
      await this.pool.query(
        `SELECT * FROM ch.records ${sourceId ? "WHERE source_id=$1" : ""} ORDER BY ingested_at DESC`,
        sourceId ? [sourceId] : [],
      )
    ).rows.map(record);
  }
  async searchRecords(q: RetrieveRequest, ids: string[]) {
    if (!ids.length) return [];
    const rows = (
      await this.pool.query(
        `SELECT *,ts_rank_cd(search_vector,plainto_tsquery('simple',$1)) score FROM ch.records WHERE source_id=ANY($2) AND deleted_at IS NULL AND(expires_at IS NULL OR expires_at>now())AND(scope->'botIds' IS NULL OR scope->'botIds' ? $3)AND($4::text IS NULL OR scope->'workspaceIds' IS NULL OR scope->'workspaceIds' ? $4)AND($5::text IS NULL OR scope->'conversationIds' IS NULL OR scope->'conversationIds' ? $5)AND($6::text IS NULL OR scope->'userIds' IS NULL OR scope->'userIds' ? $6)AND(cardinality($7::text[])=0 OR tags && $7::text[])AND search_vector@@plainto_tsquery('simple',$1)ORDER BY score DESC,ingested_at DESC LIMIT $8`,
        [
          q.query,
          ids,
          q.botId,
          q.workspaceId ?? null,
          q.conversationId ?? null,
          q.userId ?? null,
          q.tags ?? [],
          q.limit,
        ],
      )
    ).rows;
    return rows.map((r) => ({ record: record(r), score: Number(r.score) }));
  }
  async listMemories(f: { botId: string; status?: ContextMemory["status"] }) {
    return (
      await this.pool.query(
        `SELECT * FROM ch.memories WHERE bot_id=$1 ${f.status ? "AND status=$2" : ""} ORDER BY updated_at DESC`,
        f.status ? [f.botId, f.status] : [f.botId],
      )
    ).rows.map(memory);
  }
  async getMemory(id: string) {
    const r = (
      await this.pool.query("SELECT * FROM ch.memories WHERE id=$1", [id])
    ).rows[0];
    return r ? memory(r) : undefined;
  }
  async saveMemory(v: ContextMemory) {
    const r = (
      await this.pool.query(
        `INSERT INTO ch.memories(id,bot_id,user_id,conversation_id,workspace_id,layer,content,status,confidence,evidence_refs,generation_trace_id,confirmed_by,confirmed_at,forgotten_at,forget_reason,expires_at,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)ON CONFLICT(id)DO UPDATE SET layer=EXCLUDED.layer,content=EXCLUDED.content,status=EXCLUDED.status,confidence=EXCLUDED.confidence,evidence_refs=EXCLUDED.evidence_refs,generation_trace_id=EXCLUDED.generation_trace_id,confirmed_by=EXCLUDED.confirmed_by,confirmed_at=EXCLUDED.confirmed_at,forgotten_at=EXCLUDED.forgotten_at,forget_reason=EXCLUDED.forget_reason,expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at RETURNING *`,
        [
          v.id,
          v.botId,
          v.userId ?? null,
          v.conversationId ?? null,
          v.workspaceId ?? null,
          v.layer,
          v.content,
          v.status,
          v.confidence,
          v.evidenceRefs,
          v.generationTraceId ?? null,
          v.confirmedBy ?? null,
          v.confirmedAt ?? null,
          v.forgottenAt ?? null,
          v.forgetReason ?? null,
          v.expiresAt ?? null,
          v.createdAt,
          v.updatedAt,
        ],
      )
    ).rows[0];
    return memory(r);
  }
  async appendTrace(v: GenerationTrace) {
    await this.pool.query(
      "INSERT INTO ch.generation_traces(id,bot_id,operation,query,candidate_ids,selected_ids,policy_decision_id,correlation_id,metadata,created_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [
        v.id,
        v.botId,
        v.operation,
        v.query ?? null,
        v.candidateIds,
        v.selectedIds,
        v.policyDecisionId ?? null,
        v.correlationId,
        v.metadata,
        v.createdAt,
      ],
    );
  }
  async listTraces(f: {
    botId?: string;
    correlationId?: string;
    limit: number;
  }) {
    const vals: unknown[] = [],
      w: string[] = [];
    if (f.botId) {
      vals.push(f.botId);
      w.push(`bot_id=$${vals.length}`);
    }
    if (f.correlationId) {
      vals.push(f.correlationId);
      w.push(`correlation_id=$${vals.length}`);
    }
    vals.push(f.limit);
    const clause = w.length ? `WHERE ${w.join(" AND ")} ` : "";
    return (
      await this.pool.query(
        `SELECT * FROM ch.generation_traces ${clause}ORDER BY created_at DESC LIMIT $${vals.length}`,
        vals,
      )
    ).rows.map(trace);
  }
}
