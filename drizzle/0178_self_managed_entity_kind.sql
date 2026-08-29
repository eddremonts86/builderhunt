-- `builder_embeddings` learns one more entity kind (plan: phase-2/07-perfiles-autogestionados,
-- "Index public self-managed profiles for semantic search").
--
-- Only this table's CHECK moves. `solution_components.kind` and
-- `solution_component_projections.kind` carry the same eight-value list and keep it: a self-managed
-- person is a thing this projection can describe, not a component the Solutions catalog can hold.
-- `SEMANTIC_ENTITY_KINDS` in `src/shared/lib/semantic/entity-kinds.ts` is the type-level half of
-- exactly this split, and widening `COMPONENT_KINDS` instead would have produced a type that says
-- yes over two tables that say no.
--
-- A distinct kind rather than `human_profile` because that is what keeps inclusion opt-in: every
-- semantic query that filters for humans today keeps returning exactly what it returned yesterday,
-- and adding self-managed people to a surface becomes a deliberate line of code rather than a
-- side effect of this migration.
ALTER TABLE "builder_embeddings" DROP CONSTRAINT IF EXISTS "builder_embeddings_entity_kind_check";--> statement-breakpoint

ALTER TABLE "builder_embeddings"
  ADD CONSTRAINT "builder_embeddings_entity_kind_check"
  CHECK ("entity_kind" IN (
    'human_profile', 'human_role', 'agent', 'model', 'model_endpoint', 'mcp_server', 'tool',
    'service', 'self_managed_person'
  ));
