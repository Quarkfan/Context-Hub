export type ExtensionState =
  | "installed"
  | "verified"
  | "canary"
  | "active"
  | "draining"
  | "disabled"
  | "failed"
  | "retired";
export interface ExtensionDescriptor {
  providerId: string;
  family: string;
  version: string;
  contractVersion: string;
  displayName: string;
  isolation: "in-process" | "worker" | "process" | "container" | "remote";
  capabilities: Record<string, boolean | string | number>;
}
export interface ExtensionRecord {
  descriptor: ExtensionDescriptor;
  lifecycleState: ExtensionState;
  lastProbe?: {
    status: "ready" | "unavailable";
    checkedAt: string;
    reason?: string;
  };
}
const transitions: Record<ExtensionState, ExtensionState[]> = {
  installed: ["verified", "disabled", "retired"],
  verified: ["canary", "active", "disabled", "retired"],
  canary: ["active", "draining", "disabled", "failed"],
  active: ["draining", "disabled", "failed"],
  draining: ["active", "disabled", "retired"],
  disabled: ["verified", "active", "retired"],
  failed: ["verified", "disabled", "retired"],
  retired: [],
};
export class ExtensionCatalog {
  private records = new Map<string, ExtensionRecord>();
  private events: Array<{
    id: string;
    providerId: string;
    action: string;
    message: string;
    createdAt: string;
  }> = [];
  constructor(descriptors: ExtensionDescriptor[]) {
    for (const descriptor of descriptors)
      this.records.set(descriptor.providerId, {
        descriptor,
        lifecycleState: "active",
      });
  }
  list() {
    return [...this.records.values()];
  }
  get(id: string) {
    const record = this.records.get(id);
    if (!record)
      throw Object.assign(new Error(`Extension not found: ${id}`), {
        statusCode: 404,
      });
    return record;
  }
  require(id: string) {
    const record = this.get(id);
    if (!["active", "canary"].includes(record.lifecycleState))
      throw Object.assign(
        new Error(`Extension ${id} is ${record.lifecycleState}`),
        { statusCode: 409 },
      );
    return record;
  }
  probe(id: string) {
    const record = this.get(id);
    record.lastProbe = {
      status: ["active", "canary", "verified"].includes(record.lifecycleState)
        ? "ready"
        : "unavailable",
      checkedAt: new Date().toISOString(),
      reason: record.lifecycleState,
    };
    this.log(id, "probe", record.lastProbe.status);
    return record.lastProbe;
  }
  transition(id: string, state: ExtensionState) {
    const record = this.get(id);
    if (
      record.lifecycleState !== state &&
      !transitions[record.lifecycleState].includes(state)
    )
      throw Object.assign(
        new Error(
          `Cannot move extension from ${record.lifecycleState} to ${state}`,
        ),
        { statusCode: 409 },
      );
    record.lifecycleState = state;
    this.log(id, "lifecycle", `Extension moved to ${state}`);
    return record;
  }
  logs(id?: string) {
    return this.events
      .filter((event) => !id || event.providerId === id)
      .slice(-200)
      .reverse();
  }
  private log(providerId: string, action: string, message: string) {
    this.events.push({
      id: crypto.randomUUID(),
      providerId,
      action,
      message,
      createdAt: new Date().toISOString(),
    });
  }
}
const source = (kind: string, displayName: string): ExtensionDescriptor => ({
  providerId: `context-source.${kind}`,
  family: "context-source",
  version: "1.0.0",
  contractVersion: "1.0",
  displayName,
  isolation: "in-process",
  capabilities: { ingest: true, retrieve: true },
});
export const contextExtensions = new ExtensionCatalog([
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
]);
