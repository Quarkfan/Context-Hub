import { extname } from "node:path";
import {
  OfficeParser,
  type OfficeChunk,
  type SupportedFileType,
} from "officeparser";
import { HubError } from "./platform.js";
import { ContextHubService } from "./service.js";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;
const PARSER_VERSION = "officeparser@7.5.1";

export interface ResourceReader {
  read(resourceId: string, tenantId: string): Promise<Buffer>;
}

export class HttpResourceReader implements ResourceReader {
  constructor(
    readonly url: string,
    readonly token: string,
  ) {}

  async read(resourceId: string, tenantId: string) {
    const response = await fetch(
      `${this.url}/v1/resources/${resourceId}/content?tenantId=${encodeURIComponent(tenantId)}`,
      {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok)
      throw new HubError(
        "UNAVAILABLE",
        `Resource Center returned ${response.status}`,
        response.status === 404 ? 404 : 502,
      );
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > MAX_INPUT_BYTES)
      throw new HubError("INVALID_REQUEST", "Document exceeds 50 MB", 413);
    const data = Buffer.from(await response.arrayBuffer());
    if (data.byteLength > MAX_INPUT_BYTES)
      throw new HubError("INVALID_REQUEST", "Document exceeds 50 MB", 413);
    return data;
  }
}

export interface DocumentIngestInput {
  tenantId: string;
  resourceId: string;
  name: string;
  mimeType?: string;
  tags?: string[];
  scope?: {
    botIds?: string[];
    workspaceIds?: string[];
    conversationIds?: string[];
    userIds?: string[];
  };
  chunkSize?: number;
  chunkOverlap?: number;
}

export class DocumentIngestService {
  constructor(
    readonly context: ContextHubService,
    readonly resources: ResourceReader,
  ) {}

  async ingest(sourceId: string, input: DocumentIngestInput) {
    const source = await this.context.source(sourceId);
    if (source.scope.tenantId && source.scope.tenantId !== input.tenantId)
      throw new HubError(
        "POLICY_BLOCKED",
        "Resource tenant does not match the Context Source",
        403,
      );
    const data = await this.resources.read(input.resourceId, input.tenantId);
    if (data.byteLength > MAX_INPUT_BYTES)
      throw new HubError("INVALID_REQUEST", "Document exceeds 50 MB", 413);
    const chunkSize = input.chunkSize ?? 1200;
    const chunkOverlap = Math.min(input.chunkOverlap ?? 200, chunkSize - 1);
    const fileType = detectFileType(input.name, input.mimeType);
    const parsed = fileType
      ? await parseOfficeDocument(data, fileType, chunkSize, chunkOverlap)
      : parsePlainText(
          data,
          input.name,
          input.mimeType,
          chunkSize,
          chunkOverlap,
        );
    if (!parsed.chunks.length)
      throw new HubError(
        "INVALID_REQUEST",
        "The document did not contain indexable text",
        422,
      );
    const resourceRef = `resource:${input.resourceId}`;
    const records = parsed.chunks.map((chunk, index) => ({
      externalId: `${input.resourceId}:chunk:${index}`,
      title:
        typeof chunk.metadata.closestHeading === "string"
          ? chunk.metadata.closestHeading
          : `${input.name} (${index + 1}/${parsed.chunks.length})`,
      content: chunk.text,
      mimeType: input.mimeType,
      resourceRef,
      tags: input.tags ?? [],
      scope: input.scope ?? {},
      metadata: {
        provenance: {
          resourceId: input.resourceId,
          resourceRef,
          fileName: input.name,
          mimeType: input.mimeType,
          parser: parsed.parser,
          parserVersion: parsed.parserVersion,
          sourceType: parsed.sourceType,
        },
        chunk: {
          index,
          count: parsed.chunks.length,
          startIndex: chunk.startIndex,
          endIndex: chunk.endIndex,
          ...chunk.metadata,
        },
        document: parsed.documentMetadata,
        warnings: parsed.warnings,
      },
    }));
    const result = await this.context.ingest(sourceId, records);
    return {
      ...result,
      resourceId: input.resourceId,
      resourceRef,
      parser: parsed.parser,
      sourceType: parsed.sourceType,
      chunkCount: parsed.chunks.length,
      warnings: parsed.warnings,
    };
  }
}

async function parseOfficeDocument(
  data: Buffer,
  fileType: SupportedFileType,
  chunkSize: number,
  chunkOverlap: number,
) {
  const signal = AbortSignal.timeout(60_000);
  let ast;
  try {
    ast = await OfficeParser.parseOffice(data, {
      fileType,
      extractAttachments: false,
      includeRawContent: false,
      serializeRawContent: false,
      ocr: false,
      abortSignal: signal,
      decompressionLimits: {
        maxUncompressedBytes: 100 * 1024 * 1024,
        maxZipEntries: 5_000,
        maxTableCells: 200_000,
      },
    });
  } catch (error) {
    const issue = (error as any)?.officeIssue;
    throw new HubError(
      "INVALID_REQUEST",
      issue?.message ??
        (error instanceof Error ? error.message : "Document parsing failed"),
      422,
      issue?.code ? { parserCode: issue.code } : undefined,
    );
  }
  const [generated, renderedText] = await Promise.all([
    ast.to("chunks", {
      abortSignal: signal,
      chunksConfig: {
        strategy: "document-structure",
        splitBy: "paragraph",
        maxChunkSize: chunkSize,
        tableSplitStrategy: "row",
        includeMetadata: true,
        addStartIndex: true,
      },
    }),
    ast.to("text", { abortSignal: signal }),
  ]);
  let chunks = generated.value.filter((chunk) => chunk.text.trim());
  const completeText = String(renderedText.value).trim();
  const coverage = tokenCoverage(
    completeText,
    chunks.map((chunk) => chunk.text).join("\n"),
  );
  const usedFallback = completeText.length > 0 && coverage < 0.9;
  if (usedFallback)
    chunks = chunkText(
      completeText,
      chunkSize,
      Math.min(chunkOverlap, chunkSize - 1),
      ast.type,
    );
  const warnings: Array<{ code: string; message: string; type: string }> = [
    ...ast.warnings,
    ...generated.messages,
    ...renderedText.messages,
  ]
    .slice(0, 49)
    .map((warning) => ({
      code: warning.code,
      message: warning.message,
      type: warning.type,
    }));
  if (usedFallback)
    warnings.push({
      code: "CHUNK_COVERAGE_FALLBACK",
      message: `Structured chunks covered ${Math.round(coverage * 100)}% of parsed text; complete-text chunking was used`,
      type: "warning",
    });
  return {
    chunks,
    parser: "officeparser",
    parserVersion: PARSER_VERSION,
    sourceType: ast.type,
    documentMetadata: compactMetadata(ast.metadata),
    warnings,
  };
}

function parsePlainText(
  data: Buffer,
  name: string,
  mimeType: string | undefined,
  chunkSize: number,
  overlap: number,
) {
  if (data.includes(0))
    throw new HubError(
      "UNSUPPORTED",
      `Unsupported document type: ${mimeType ?? (extname(name) || "unknown")}`,
      415,
    );
  const text = data.toString("utf8").replace(/\r\n/g, "\n").trim();
  const chunks = chunkText(text, chunkSize, overlap, "md");
  return {
    chunks,
    parser: "context-hub-text",
    parserVersion: "1",
    sourceType: "text",
    documentMetadata: {},
    warnings: [] as Array<{ code: string; message: string; type: string }>,
  };
}

function chunkText(
  text: string,
  chunkSize: number,
  overlap: number,
  sourceType: SupportedFileType,
) {
  const chunks: OfficeChunk[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + chunkSize);
    if (end < text.length) {
      const boundary = Math.max(
        text.lastIndexOf("\n\n", end),
        text.lastIndexOf("\n", end),
        text.lastIndexOf(" ", end),
      );
      if (boundary > start + Math.floor(chunkSize / 2)) end = boundary;
    }
    const value = text.slice(start, end).trim();
    if (value)
      chunks.push({
        text: value,
        metadata: { sourceType },
        startIndex: start,
        endIndex: end,
      });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

function tokenCoverage(expected: string, actual: string) {
  const tokens = (value: string) =>
    new Set(value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const expectedTokens = tokens(expected);
  if (!expectedTokens.size) return actual.trim() ? 1 : 0;
  const actualTokens = tokens(actual);
  return (
    [...expectedTokens].filter((token) => actualTokens.has(token)).length /
    expectedTokens.size
  );
}

function detectFileType(
  name: string,
  mimeType?: string,
): SupportedFileType | undefined {
  const extension = extname(name).toLowerCase().slice(1);
  const supported = new Set<SupportedFileType>([
    "docx",
    "pptx",
    "xlsx",
    "odt",
    "odp",
    "ods",
    "pdf",
    "rtf",
    "md",
    "html",
    "csv",
    "epub",
  ]);
  if (supported.has(extension as SupportedFileType))
    return extension as SupportedFileType;
  const byMime: Record<string, SupportedFileType> = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      "pptx",
    "text/markdown": "md",
    "text/csv": "csv",
    "text/html": "html",
    "application/rtf": "rtf",
    "application/epub+zip": "epub",
  };
  return mimeType
    ? byMime[mimeType.split(";", 1)[0]!.toLowerCase()]
    : undefined;
}

function compactMetadata(metadata: object) {
  const values = metadata as Record<string, unknown>;
  return Object.fromEntries(
    [
      "title",
      "author",
      "subject",
      "description",
      "language",
      "created",
      "modified",
    ]
      .filter((key) => values[key] !== undefined)
      .map((key) => [key, values[key]]),
  );
}
