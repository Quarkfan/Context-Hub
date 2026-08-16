# Session Context Projection

## Boundary decision

Runtime Center owns the durable Session Event Ledger because it records execution truth, model-visible inputs, tool calls and continuation state. Context Hub owns reusable context, knowledge, summaries, memories, retrieval and context transformation policy.

CH must not become a duplicate session event store. Runtime must not turn its ledger into a knowledge or long-term-memory database.

## Integration model

Before a model request, Runtime asks CH for a versioned `ContextMaterialization`. CH returns ordered context contributions with source/citation references, scope/freshness decisions, transformation metadata and a materialization ID. Runtime appends a `context/materialized` event referring to that immutable result before calling the model.

After a turn, Runtime may publish a bounded event-range reference to CH. CH can create:

- short-term working summaries;
- mid-term memory candidates;
- long-term memory candidates requiring evidence and policy/confirmation;
- compaction artifacts for future model-history projections.

CH outputs are new immutable records with lineage to source session event ranges. They never rewrite Runtime events.

## Context Processor provider

CH adds an extensible provider family for retrieval, reranking, summarization, compaction, entity extraction and memory candidate generation.

The first implemented catalog includes lexical retrieval, document parsing and memory lifecycle processors plus all current source kinds. Source ingest, retrieve, document parsing and memory mutations resolve the catalog before execution. Reranking, summarization, compaction and entity extraction remain open Provider additions.

```ts
interface ContextProcessorDescriptor {
  providerId: string;
  version: string;
  contractVersion: string;
  processorKinds: string[];
  deterministic: boolean;
  supportsCheckpoint: boolean;
  configurationSchemaRef: string;
}
```

Bindings select processors by tenant/Bot/context policy. Every run records exact provider version, input citations, output resource references, policy decisions, model usage where applicable and checkpoint identity.

## Compaction

Compaction is a projection transform, not source deletion. A compaction artifact identifies the covered event range, preserved facts/tool pairs, summary, processor version and token estimate. Runtime may use it in future model-history projections while retaining event provenance and applying Resource/Governance retention rules independently.

Model-free pruning of oversized tool output should run before model summarization when semantics allow it. Tool calls and results must remain paired, and any omitted payload remains discoverable through an authorized resource reference until retention policy removes it.

## Memory promotion

Session events are evidence, not automatically memory. Promotion follows the existing candidate, confirmation, reinforcement, expiration, conflict and forget lifecycle. A later corrected event can create a conflict or superseding candidate; it does not mutate prior memory evidence.

## Required tests

- context materialization is reproducible from citations and provider version;
- Runtime ledger and CH records preserve tenant/Bot scope;
- compaction never hides unmatched tool calls/results;
- source event ranges remain attributable after projection checkpointing;
- long-term memory cannot bypass candidate/evidence policy;
- processor upgrade and rollback do not reinterpret historical artifacts silently;
- deletion/forget propagates through projections and resource references according to policy.
