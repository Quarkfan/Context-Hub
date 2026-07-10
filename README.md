# Context Hub

This repository is the standalone home for Context Hub（CH，上下文中心）design and future implementation.

QuarkfanTools consumes this repository as a platform center. Until code is moved over, this repository primarily carries the Context Hub contracts, boundaries, and memory/knowledge design.

## Scope

- Context source and collection management
- Skill knowledge, Lark docs/wiki/drive, local file knowledge, customer knowledge, and external context sources
- Short-term, mid-term, and long-term memory
- Context records, chunks, summaries, entities, relationships, indexes, freshness, scopes, and audit records
- Context retrieval contracts for runtime use
- Memory candidate, confirmation, reinforcement, expiration, conflict, and forget flows
- Bot-level authorization and governance hooks for context read/write/use-in-model

Authoritative Context Hub notes live here:

- `STATUS.md`: current phase, source of truth, and next work.
- `docs/context-hub.md`: domain design and responsibility boundaries.

Platform-wide center boundaries, cross-center protocols, reference matrix, and deployment blueprints live in the parent QuarkfanTools repository.

## New Session Checklist

1. Read `AGENTS.md` and `STATUS.md`.
2. Read `docs/context-hub.md` for the domain model, memory tiers, interfaces, and P0 scope.
3. If the task touches cross-center protocols or platform ownership, also read the parent repository docs: `docs/platform-centers.md` and `docs/platform-interface-protocols.md`.
4. If implementation moves into the standalone app first, update both this repository and the parent submodule pointer after committing here.
