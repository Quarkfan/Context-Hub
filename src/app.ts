import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ContextRepository } from "./repository.js";
import { ContextHubService } from "./service.js";
import { HubError, fail, ok } from "./platform.js";
import {
  DocumentIngestService,
  type ResourceReader,
} from "./document-ingest.js";
import type { ExtensionStateRepository } from "./extensions.js";
export interface BuildOptions {
  repository: ContextRepository;
  internalToken: string;
  resourceReader?: ResourceReader;
  logger?: boolean | { level: string };
  extensionRepository?: ExtensionStateRepository;
}
const sourceKinds = [
  "skill-knowledge",
  "lark-document",
  "lark-wiki",
  "file",
  "url",
  "conversation",
  "manual",
  "external",
] as const;
const scope = z.object({
  tenantId: z.string().optional(),
  botIds: z.array(z.string()).optional(),
  workspaceIds: z.array(z.string()).optional(),
});
const sourceBody = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  kind: z.enum(sourceKinds),
  enabled: z.boolean().optional(),
  scope: scope.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  freshnessTtlSeconds: z.number().int().positive().optional(),
});
const bindingBody = z.object({
  id: z.string().uuid().optional(),
  sourceId: z.string().uuid(),
  botId: z.string().min(1),
  enabled: z.boolean().optional(),
  priority: z.number().int().optional(),
  maxAgeSeconds: z.number().int().positive().optional(),
  tags: z.array(z.string()).optional(),
});
export function buildApp(o: BuildOptions): FastifyInstance {
  const app = Fastify({
      logger: o.logger ?? false,
      genReqId: () => randomUUID(),
    }),
    service = new ContextHubService(o.repository, o.extensionRepository),
    documents = new DocumentIngestService(
      service,
      o.resourceReader ?? {
        read: async () => {
          throw new HubError(
            "UNAVAILABLE",
            "Resource Center is not configured",
            503,
          );
        },
      },
    );
  app.addHook("onReady", async () => service.extensions.initialize());
  app.addHook("onClose", async () => service.extensions.close());
  app.addHook("onRequest", async (req, reply) => {
    if (["/healthz", "/readyz", "/version"].includes(req.url)) return;
    if (req.headers.authorization !== `Bearer ${o.internalToken}`)
      return reply
        .code(401)
        .send(
          fail(
            "UNAUTHORIZED",
            "Missing or invalid internal service token",
            req.id,
          ),
        );
  });
  app.setErrorHandler((e, req, reply) => {
    if (
      !(e instanceof HubError) &&
      e instanceof Error &&
      "statusCode" in e &&
      typeof e.statusCode === "number"
    )
      return reply
        .code(e.statusCode)
        .send(
          fail(
            e.statusCode === 404 ? "NOT_FOUND" : "CONFLICT",
            e.message,
            req.id,
          ),
        );
    if (e instanceof HubError)
      return reply
        .code(e.statusCode)
        .send(fail(e.code, e.message, req.id, e.details));
    if (e instanceof z.ZodError)
      return reply.code(400).send(
        fail("INVALID_REQUEST", "Request validation failed", req.id, {
          issues: e.issues,
        }),
      );
    req.log.error(e);
    return reply
      .code(500)
      .send(fail("INTERNAL", "Unexpected Context Hub error", req.id));
  });
  app.get("/healthz", async (req) =>
    ok({ service: "context-hub", status: "ok" }, req.id),
  );
  app.get("/readyz", async (req, reply) => {
    const r = await o.repository.ping();
    return reply
      .code(r ? 200 : 503)
      .send(
        r
          ? ok({ service: "context-hub", status: "ready" }, req.id)
          : fail("UNAVAILABLE", "Database is unavailable", req.id),
      );
  });
  app.get("/version", async (req) =>
    ok(
      {
        service: "context-hub",
        version: "0.1.0",
        protocolVersion: "2026-07-04",
      },
      req.id,
    ),
  );
  app.get("/v1/sources", async (req) =>
    ok(await o.repository.listSources(), req.id),
  );
  app.get("/v1/extensions", async (req) =>
    ok(service.extensions.list(), req.id),
  );
  app.get("/v1/extensions/:id", async (req) =>
    ok(
      service.extensions.get(z.object({ id: z.string() }).parse(req.params).id),
      req.id,
    ),
  );
  app.post("/v1/extensions/:id/probe", async (req) =>
    ok(
      await service.extensions.probe(
        z.object({ id: z.string() }).parse(req.params).id,
      ),
      req.id,
    ),
  );
  app.post("/v1/extensions/:id/lifecycle/:state", async (req) => {
    const { id, state } = z
      .object({
        id: z.string(),
        state: z.enum([
          "installed",
          "verified",
          "canary",
          "active",
          "draining",
          "disabled",
          "failed",
          "retired",
        ]),
      })
      .parse(req.params);
    return ok(await service.extensions.transition(id, state), req.id);
  });
  app.get("/v1/extensions/:id/logs", async (req) =>
    ok(
      await service.extensions.logs(
        z.object({ id: z.string() }).parse(req.params).id,
      ),
      req.id,
    ),
  );
  app.post("/v1/sources", async (req, reply) => {
    const b = sourceBody.parse(req.body);
    return reply.code(201).send(ok(await service.saveSource(b), req.id));
  });
  app.get("/v1/sources/:id", async (req) =>
    ok(
      await service.source(
        z.object({ id: z.string().uuid() }).parse(req.params).id,
      ),
      req.id,
    ),
  );
  app.put("/v1/sources/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await service.source(id);
    return ok(
      await service.saveSource({
        ...sourceBody.omit({ id: true }).parse(req.body),
        id,
      }),
      req.id,
    );
  });
  app.delete("/v1/sources/:id", async (req) =>
    ok(
      await service.removeSource(
        z.object({ id: z.string().uuid() }).parse(req.params).id,
      ),
      req.id,
    ),
  );
  app.get("/v1/bindings", async (req) => {
    const q = z.object({ botId: z.string().optional() }).parse(req.query);
    return ok(await o.repository.listBindings(q.botId), req.id);
  });
  app.post("/v1/bindings", async (req, reply) => {
    const b = bindingBody.parse(req.body);
    return reply.code(201).send(ok(await service.saveBinding(b), req.id));
  });
  app.get("/v1/bindings/:id", async (req) =>
    ok(
      await service.binding(
        z.object({ id: z.string().uuid() }).parse(req.params).id,
      ),
      req.id,
    ),
  );
  app.put("/v1/bindings/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await service.binding(id);
    return ok(
      await service.saveBinding({
        ...bindingBody.omit({ id: true }).parse(req.body),
        id,
      }),
      req.id,
    );
  });
  app.delete("/v1/bindings/:id", async (req) =>
    ok(
      await service.removeBinding(
        z.object({ id: z.string().uuid() }).parse(req.params).id,
      ),
      req.id,
    ),
  );
  app.post("/v1/sources/:id/records", async (req, reply) => {
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const recordScope = z.object({
      botIds: z.array(z.string()).optional(),
      workspaceIds: z.array(z.string()).optional(),
      conversationIds: z.array(z.string()).optional(),
      userIds: z.array(z.string()).optional(),
    });
    const records = z
      .object({
        records: z
          .array(
            z.object({
              id: z.string().uuid().optional(),
              externalId: z.string().optional(),
              title: z.string().optional(),
              content: z.string().min(1),
              mimeType: z.string().optional(),
              resourceRef: z.string().optional(),
              metadata: z.record(z.string(), z.unknown()).optional(),
              tags: z.array(z.string()).optional(),
              scope: recordScope.optional(),
              sourceUpdatedAt: z.string().datetime().optional(),
              expiresAt: z.string().datetime().optional(),
            }),
          )
          .min(1)
          .max(1000),
      })
      .parse(req.body);
    return reply
      .code(201)
      .send(ok(await service.ingest(id, records.records), req.id));
  });
  app.get("/v1/records", async (req) => {
    const q = z
      .object({ sourceId: z.string().uuid().optional() })
      .parse(req.query);
    return ok(await o.repository.listRecords(q.sourceId), req.id);
  });
  app.post("/v1/transcripts", async (req, reply) => {
    const body = z
      .object({
        tenantId: z.string().min(1),
        botId: z.string().min(1),
        executionId: z.string().uuid(),
        sessionId: z.string().uuid(),
        workspaceId: z.string().uuid(),
        conversationId: z.string().max(500).optional(),
        userId: z.string().max(500).optional(),
        prompt: z.string().min(1).max(100_000),
        response: z.string().max(200_000),
        runtime: z.string().min(1).max(100),
        status: z.string().min(1).max(100),
        resourceRefs: z.array(z.string().max(500)).max(1000).optional(),
        eventRefs: z.array(z.string().max(500)).max(1000).optional(),
        createdAt: z.string().datetime(),
        finishedAt: z.string().datetime().optional(),
        retentionDays: z.number().int().min(1).max(3650).optional(),
      })
      .parse(req.body);
    return reply
      .code(201)
      .send(ok(await service.recordTranscript(body), req.id));
  });
  app.get("/v1/transcripts", async (req) => {
    const query = z
      .object({
        tenantId: z.string().optional(),
        botId: z.string().optional(),
        conversationId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(100),
      })
      .parse(req.query);
    return ok(await service.transcripts(query), req.id);
  });
  app.post("/v1/sources/:id/resources", async (req, reply) => {
    service.extensions.require("context-processor.document-parser");
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id;
    const recordScope = z.object({
      botIds: z.array(z.string()).optional(),
      workspaceIds: z.array(z.string()).optional(),
      conversationIds: z.array(z.string()).optional(),
      userIds: z.array(z.string()).optional(),
    });
    const body = z
      .object({
        tenantId: z.string().min(1),
        resourceId: z.string().uuid(),
        name: z.string().min(1).max(512),
        mimeType: z.string().max(255).optional(),
        tags: z.array(z.string()).max(100).optional(),
        scope: recordScope.optional(),
        chunkSize: z.number().int().min(200).max(4000).optional(),
        chunkOverlap: z.number().int().min(0).max(1000).optional(),
      })
      .parse(req.body);
    return reply.code(201).send(ok(await documents.ingest(id, body), req.id));
  });
  app.post("/v1/retrieve", async (req) => {
    service.extensions.require("context-processor.lexical");
    const b = z
      .object({
        botId: z.string().min(1),
        query: z.string().min(1),
        workspaceId: z.string().optional(),
        conversationId: z.string().optional(),
        userId: z.string().optional(),
        tags: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(100).default(10),
        includeMemory: z.boolean().default(true),
        correlationId: z.string().min(1),
      })
      .parse(req.body);
    return ok(await service.retrieve(b), req.id);
  });
  app.get("/v1/memories", async (req) => {
    const q = z
      .object({
        botId: z.string().min(1),
        status: z
          .enum(["candidate", "confirmed", "rejected", "forgotten"])
          .optional(),
      })
      .parse(req.query);
    return ok(await o.repository.listMemories(q), req.id);
  });
  app.post("/v1/memories/candidates", async (req, reply) => {
    service.extensions.require("context-processor.memory-lifecycle");
    const b = z
      .object({
        botId: z.string().min(1),
        userId: z.string().optional(),
        conversationId: z.string().optional(),
        workspaceId: z.string().optional(),
        layer: z.enum(["short", "medium", "long"]),
        content: z.string().min(1),
        confidence: z.number().min(0).max(1),
        evidenceRefs: z.array(z.string()).default([]),
        correlationId: z.string().min(1),
      })
      .parse(req.body);
    return reply.code(201).send(ok(await service.createMemory(b), req.id));
  });
  app.post("/v1/memories/:id/confirm", async (req) => {
    service.extensions.require("context-processor.memory-lifecycle");
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id,
      b = z
        .object({
          actorId: z.string().min(1),
          correlationId: z.string().min(1),
        })
        .parse(req.body);
    return ok(
      await service.confirmMemory(id, b.actorId, b.correlationId),
      req.id,
    );
  });
  app.post("/v1/memories/:id/forget", async (req) => {
    service.extensions.require("context-processor.memory-lifecycle");
    const id = z.object({ id: z.string().uuid() }).parse(req.params).id,
      b = z
        .object({ reason: z.string().min(1), correlationId: z.string().min(1) })
        .parse(req.body);
    return ok(
      await service.forgetMemory(id, b.reason, b.correlationId),
      req.id,
    );
  });
  app.get("/v1/freshness", async (req) =>
    ok(await service.freshness(), req.id),
  );
  app.get("/v1/traces", async (req) => {
    const q = z
      .object({
        botId: z.string().optional(),
        correlationId: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    return ok(await o.repository.listTraces(q), req.id);
  });
  app.addHook("onClose", async () => o.repository.close());
  return app;
}
