export type SourceKind =
  | "skill-knowledge"
  | "lark-document"
  | "lark-wiki"
  | "file"
  | "url"
  | "conversation"
  | "manual"
  | "external";
export interface ContextSource {
  id: string;
  name: string;
  kind: SourceKind;
  enabled: boolean;
  scope: { tenantId?: string; botIds?: string[]; workspaceIds?: string[] };
  config: Record<string, unknown>;
  freshnessTtlSeconds?: number;
  lastIngestedAt?: string;
  lastError?: string;
  status: "configured" | "ready" | "stale" | "error" | "disabled";
  createdAt: string;
  updatedAt: string;
}
export interface ContextBinding {
  id: string;
  sourceId: string;
  botId: string;
  enabled: boolean;
  priority: number;
  maxAgeSeconds?: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}
export interface ContextRecord {
  id: string;
  sourceId: string;
  externalId?: string;
  title?: string;
  content: string;
  contentHash: string;
  mimeType?: string;
  resourceRef?: string;
  metadata: Record<string, unknown>;
  tags: string[];
  scope: {
    botIds?: string[];
    workspaceIds?: string[];
    conversationIds?: string[];
    userIds?: string[];
  };
  sourceUpdatedAt?: string;
  ingestedAt: string;
  expiresAt?: string;
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export type MemoryLayer = "short" | "medium" | "long";
export interface ContextMemory {
  id: string;
  botId: string;
  userId?: string;
  conversationId?: string;
  workspaceId?: string;
  layer: MemoryLayer;
  content: string;
  status: "candidate" | "confirmed" | "rejected" | "forgotten";
  confidence: number;
  evidenceRefs: string[];
  generationTraceId?: string;
  confirmedBy?: string;
  confirmedAt?: string;
  forgottenAt?: string;
  forgetReason?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface GenerationTrace {
  id: string;
  botId: string;
  operation:
    "retrieve" | "memory-candidate" | "memory-confirm" | "memory-forget";
  query?: string;
  candidateIds: string[];
  selectedIds: string[];
  policyDecisionId?: string;
  correlationId: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface RetrieveRequest {
  botId: string;
  query: string;
  workspaceId?: string;
  conversationId?: string;
  userId?: string;
  tags?: string[];
  limit: number;
  includeMemory: boolean;
  correlationId: string;
}
export interface RetrievedContext {
  id: string;
  kind: "record" | "memory";
  sourceId?: string;
  title?: string;
  content: string;
  score: number;
  confidence: number;
  freshness: "fresh" | "stale" | "unknown";
  scope: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
