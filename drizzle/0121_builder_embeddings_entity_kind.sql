-- Custom SQL migration file, put your code below! --
-- plans/phase-1/43-solutions-intelligence Phase 2, "Unify embedding dimension and entity
-- contracts": the shared vector projection must be able to hold catalog components (agents,
-- models, endpoints, MCP servers, tools, services) and generic human roles alongside the real
-- people it holds today, so Phase 5 can retrieve across all of them from one HNSW index instead
-- of standing up a parallel one.
--
-- `entity_kind` uses the Solutions catalog's own `COMPONENT_KINDS` vocabulary rather than a
-- parallel enum, so the retrieval path needs no translation table. Every existing row is a real
-- person, which is exactly what the DEFAULT backfills.
ALTER TABLE "builder_embeddings"
  ADD COLUMN "entity_kind" text NOT NULL DEFAULT 'human_profile';

ALTER TABLE "builder_embeddings"
  ADD CONSTRAINT "builder_embeddings_entity_kind_check"
  CHECK ("entity_kind" IN ('human_profile', 'human_role', 'agent', 'model', 'model_endpoint', 'mcp_server', 'tool', 'service'));

-- The uniqueness key widens to include the kind. A catalog component and a person can legitimately
-- share a (source, source_id) pair — a GitHub org that is both an indexed account and a `service`
-- in the catalog is the obvious case — and under the old two-column key one would silently
-- overwrite the other's document and vector on upsert.
--
-- Safe to swap in this order because every pre-existing row now carries the same 'human_profile'
-- value, so (entity_kind, source, source_id) is unique for exactly the rows (source, source_id)
-- was unique for.
ALTER TABLE "builder_embeddings" DROP CONSTRAINT "builder_embeddings_source_unique";

ALTER TABLE "builder_embeddings"
  ADD CONSTRAINT "builder_embeddings_entity_unique" UNIQUE ("entity_kind", "source", "source_id");

-- Phase 5 filters by kind before the vector sort (an AI-only or human-only lane), and without this
-- the planner scans the entire projection to apply the filter.
CREATE INDEX IF NOT EXISTS "builder_embeddings_entity_kind_idx" ON "builder_embeddings" ("entity_kind");
