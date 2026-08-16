import {
  ExtensionCatalog,
  type ExtensionDescriptor,
  type ExtensionStateRepository,
} from "./extension-catalog.js";

export * from "./extension-catalog.js";

const source = (kind: string, displayName: string): ExtensionDescriptor => ({
  providerId: `context-source.${kind}`,
  family: "context-source",
  version: "1.0.0",
  contractVersion: "1.0",
  displayName,
  isolation: "in-process",
  capabilities: { ingest: true, retrieve: true },
});

export const createContextExtensions = (
  repository?: ExtensionStateRepository,
) =>
  new ExtensionCatalog(
    [
      source("skill-knowledge", "Skill Knowledge Source"),
      source("lark-document", "Lark Document Source"),
      source("lark-wiki", "Lark Wiki Source"),
      source("file", "File Source"),
      source("url", "URL Source"),
      source("conversation", "Conversation Source"),
      source("manual", "Manual Source"),
      source("external", "External Source"),
      {
        providerId: "context-processor.lexical",
        family: "context-processor",
        version: "1.0.0",
        contractVersion: "1.0",
        displayName: "Lexical Retrieval Processor",
        isolation: "in-process",
        capabilities: { retrieve: true, deterministic: true },
      },
      {
        providerId: "context-processor.document-parser",
        family: "context-processor",
        version: "1.0.0",
        contractVersion: "1.0",
        displayName: "Office/PDF Document Parser",
        isolation: "worker",
        capabilities: { pdf: true, office: true, text: true },
      },
      {
        providerId: "context-processor.memory-lifecycle",
        family: "context-processor",
        version: "1.0.0",
        contractVersion: "1.0",
        displayName: "Memory Lifecycle Processor",
        isolation: "in-process",
        capabilities: { shortTerm: true, mediumTerm: true, longTerm: true },
      },
    ],
    repository,
  );
