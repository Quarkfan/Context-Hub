import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryContextRepository } from "../src/repository.js";
import type { ResourceReader } from "../src/document-ingest.js";
const token = "test-token",
  headers = { authorization: `Bearer ${token}` };
const setup = (resourceReader?: ResourceReader) => {
  const repository = new MemoryContextRepository(),
    app = buildApp({ repository, internalToken: token, resourceReader });
  return { app, repository };
};
async function source(
  app: ReturnType<typeof buildApp>,
  body: Record<string, unknown>,
) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/sources",
    headers,
    payload: body,
  });
  expect(r.statusCode).toBe(201);
  return r.json().data;
}
async function bind(
  app: ReturnType<typeof buildApp>,
  sourceId: string,
  botId: string,
  maxAgeSeconds?: number,
) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/bindings",
    headers,
    payload: { sourceId, botId, maxAgeSeconds },
  });
  expect(r.statusCode).toBe(201);
}
describe("Context Hub API", () => {
  const apps: Array<ReturnType<typeof buildApp>> = [];
  afterEach(async () => Promise.all(apps.splice(0).map((x) => x.close())));
  it("isolates records by bot", async () => {
    const { app } = setup();
    apps.push(app);
    const s = await source(app, { name: "private", kind: "manual" });
    await bind(app, s.id, "bot-a");
    await bind(app, s.id, "bot-b");
    await app.inject({
      method: "POST",
      url: `/v1/sources/${s.id}/records`,
      headers,
      payload: {
        records: [
          {
            content: "refund policy is seven days",
            scope: { botIds: ["bot-a"] },
          },
        ],
      },
    });
    const a = await app.inject({
        method: "POST",
        url: "/v1/retrieve",
        headers,
        payload: { botId: "bot-a", query: "refund policy", correlationId: "a" },
      }),
      b = await app.inject({
        method: "POST",
        url: "/v1/retrieve",
        headers,
        payload: { botId: "bot-b", query: "refund policy", correlationId: "b" },
      });
    expect(a.json().data.items).toHaveLength(1);
    expect(b.json().data.items).toHaveLength(0);
  });
  it("stores execution transcripts in a managed conversation source", async () => {
    const { app, repository } = setup();
    apps.push(app);
    const payload = {
      tenantId: "tenant-a",
      botId: "bot-a",
      executionId: "00000000-0000-4000-8000-000000000011",
      sessionId: "00000000-0000-4000-8000-000000000012",
      workspaceId: "00000000-0000-4000-8000-000000000013",
      conversationId: "chat-a",
      userId: "user-a",
      prompt: "What changed?",
      response: "The snapshot was updated.",
      runtime: "model-tool-loop",
      status: "succeeded",
      resourceRefs: ["resource:one", "resource:one"],
      eventRefs: ["event:one"],
      createdAt: "2026-08-16T00:00:00.000Z",
      finishedAt: "2026-08-16T00:00:01.000Z",
    };
    const created = await app.inject({
      method: "POST",
      url: "/v1/transcripts",
      headers,
      payload,
    });
    expect(created.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: "/v1/transcripts",
      headers,
      payload: { ...payload, response: "The snapshot was updated again." },
    });
    const listed = await app.inject({
      method: "GET",
      url: "/v1/transcripts?tenantId=tenant-a&botId=bot-a",
      headers,
    });
    expect(listed.json().data).toHaveLength(1);
    expect(listed.json().data[0]).toMatchObject({
      content: expect.stringContaining("updated again"),
      metadata: {
        executionId: payload.executionId,
        sessionId: payload.sessionId,
        resourceRefs: ["resource:one"],
      },
      scope: { botIds: ["bot-a"], conversationIds: ["chat-a"] },
    });
    expect(await repository.listBindings("bot-a")).toHaveLength(1);
  });
  it("converges concurrent first transcripts on one managed source and binding", async () => {
    const { app, repository } = setup();
    apps.push(app);
    const base = {
      tenantId: "tenant-concurrent",
      botId: "bot-concurrent",
      sessionId: "00000000-0000-4000-8000-000000000021",
      workspaceId: "00000000-0000-4000-8000-000000000022",
      prompt: "Concurrent prompt",
      response: "Concurrent response",
      runtime: "openai-agents",
      status: "succeeded",
      createdAt: "2026-08-16T00:00:00.000Z",
    };
    const results = await Promise.all(
      [31, 32].map((suffix) =>
        app.inject({
          method: "POST",
          url: "/v1/transcripts",
          headers,
          payload: {
            ...base,
            executionId: `00000000-0000-4000-8000-0000000000${suffix}`,
          },
        }),
      ),
    );
    expect(results.map((result) => result.statusCode)).toEqual([201, 201]);
    const managed = (await repository.listSources()).filter(
      (item) => item.config.managedType === "runtime-transcript",
    );
    expect(managed).toHaveLength(1);
    expect(await repository.listBindings("bot-concurrent")).toHaveLength(1);
    expect(await repository.listRecords(managed[0]!.id)).toHaveLength(2);
  });
  it("blocks stale sources", async () => {
    const { app, repository } = setup();
    apps.push(app);
    const s = await source(app, { name: "short lived", kind: "manual" });
    await bind(app, s.id, "bot-a", 1);
    await app.inject({
      method: "POST",
      url: `/v1/sources/${s.id}/records`,
      headers,
      payload: { records: [{ content: "current store roster" }] },
    });
    const stored = await repository.getSource(s.id);
    await repository.saveSource({
      ...stored!,
      lastIngestedAt: "2020-01-01T00:00:00.000Z",
    });
    const r = await app.inject({
      method: "POST",
      url: "/v1/retrieve",
      headers,
      payload: {
        botId: "bot-a",
        query: "store roster",
        correlationId: "stale",
      },
    });
    expect(r.json().data.items).toHaveLength(0);
  });
  it("requires evidence and confirmation for long memory", async () => {
    const { app } = setup();
    apps.push(app);
    const invalid = await app.inject({
      method: "POST",
      url: "/v1/memories/candidates",
      headers,
      payload: {
        botId: "bot-a",
        layer: "long",
        content: "prefers monthly reports",
        confidence: 0.9,
        evidenceRefs: [],
        correlationId: "invalid",
      },
    });
    expect(invalid.statusCode).toBe(400);
    const made = await app.inject({
        method: "POST",
        url: "/v1/memories/candidates",
        headers,
        payload: {
          botId: "bot-a",
          layer: "long",
          content: "prefers monthly reports",
          confidence: 0.9,
          evidenceRefs: ["message:1"],
          correlationId: "create",
        },
      }),
      id = made.json().data.id;
    const before = await app.inject({
      method: "POST",
      url: "/v1/retrieve",
      headers,
      payload: {
        botId: "bot-a",
        query: "monthly reports",
        correlationId: "before",
      },
    });
    expect(before.json().data.items).toHaveLength(0);
    await app.inject({
      method: "POST",
      url: `/v1/memories/${id}/confirm`,
      headers,
      payload: { actorId: "admin", correlationId: "confirm" },
    });
    const after = await app.inject({
      method: "POST",
      url: "/v1/retrieve",
      headers,
      payload: {
        botId: "bot-a",
        query: "monthly reports",
        correlationId: "after",
      },
    });
    expect(after.json().data.items[0].kind).toBe("memory");
    await app.inject({
      method: "POST",
      url: `/v1/memories/${id}/forget`,
      headers,
      payload: { reason: "user request", correlationId: "forget" },
    });
    const gone = await app.inject({
      method: "POST",
      url: "/v1/retrieve",
      headers,
      payload: {
        botId: "bot-a",
        query: "monthly reports",
        correlationId: "gone",
      },
    });
    expect(gone.json().data.items).toHaveLength(0);
  });
  it("parses Resource Center documents into stable, traceable chunks", async () => {
    const reads: Array<{ resourceId: string; tenantId: string }> = [],
      resourceId = "11111111-1111-4111-8111-111111111111",
      { app, repository } = setup({
        read: async (id, tenantId) => {
          reads.push({ resourceId: id, tenantId });
          return Buffer.from(
            "# Refund policy\n\nRefunds are available for seven days.\n\n## Contact\n\nAsk the store manager.",
          );
        },
      });
    apps.push(app);
    const s = await source(app, {
      name: "handbook",
      kind: "file",
      scope: { tenantId: "tenant-a" },
    });
    const payload = {
      tenantId: "tenant-a",
      resourceId,
      name: "handbook.md",
      mimeType: "text/markdown",
      tags: ["policy"],
      scope: { botIds: ["bot-a"] },
      chunkSize: 200,
    };
    const first = await app.inject({
      method: "POST",
      url: `/v1/sources/${s.id}/resources`,
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().data).toMatchObject({
      resourceId,
      resourceRef: `resource:${resourceId}`,
      parser: "officeparser",
    });
    expect(first.json().data.chunkCount).toBeGreaterThan(0);
    const records = await repository.listRecords(s.id);
    expect(records).toHaveLength(first.json().data.chunkCount);
    expect(
      records.some((record) => record.content.includes("seven days")),
    ).toBe(true);
    expect(first.json().data.warnings).toContainEqual(
      expect.objectContaining({ code: "CHUNK_COVERAGE_FALLBACK" }),
    );
    expect(records[0]?.externalId).toBe(`${resourceId}:chunk:0`);
    expect(records[0]?.metadata).toMatchObject({
      provenance: {
        resourceId,
        resourceRef: `resource:${resourceId}`,
        fileName: "handbook.md",
        parser: "officeparser",
      },
      chunk: { index: 0, count: records.length },
    });
    const second = await app.inject({
      method: "POST",
      url: `/v1/sources/${s.id}/resources`,
      headers,
      payload,
    });
    expect(second.json().data.created).toBe(0);
    expect(await repository.listRecords(s.id)).toHaveLength(records.length);
    expect(reads).toEqual([
      { resourceId, tenantId: "tenant-a" },
      { resourceId, tenantId: "tenant-a" },
    ]);
  });
  it("enforces source tenant scope before reading a resource", async () => {
    let reads = 0;
    const { app } = setup({
      read: async () => {
        reads += 1;
        return Buffer.from("secret");
      },
    });
    apps.push(app);
    const s = await source(app, {
      name: "private",
      kind: "file",
      scope: { tenantId: "tenant-a" },
    });
    const response = await app.inject({
      method: "POST",
      url: `/v1/sources/${s.id}/resources`,
      headers,
      payload: {
        tenantId: "tenant-b",
        resourceId: "11111111-1111-4111-8111-111111111111",
        name: "secret.txt",
        mimeType: "text/plain",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(reads).toBe(0);
  });
});
