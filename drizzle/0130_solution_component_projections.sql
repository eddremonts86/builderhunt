-- Custom SQL migration file, put your code below! --
-- Retrieval projections for catalog components (plan 43 Phase 5, "Build versioned search
-- projections").
--
-- A projection is derived data: the lexical document and the structured filter columns that retrieval
-- actually queries, rebuilt from a component version rather than stored alongside it. Kept in its own
-- table rather than as columns on `solution_component_versions` for three reasons:
--
-- 1. A version is history and must never be rewritten (0128 grants the worker UPDATE on `valid_until`
--    alone for exactly that reason). A projection is a cache and is rewritten whenever the document
--    builder changes.
-- 2. `projection_version` lets a document-format change be rolled out incrementally, and lets a stale
--    job be recognised as stale instead of silently overwriting newer work.
-- 3. Rebuilding all projections is a DELETE + reinsert, which is a normal operation here and would be
--    unthinkable against version history.
--
-- The vector lane is NOT here. It lives in `builder_embeddings`, which migration 0121 widened with
-- `entity_kind` precisely so catalog components could share it: one embedding column, one dimension to
-- keep in step with `AI_EMBEDDING_DIM`, one HNSW index, and one re-embed script. A second vector column
-- would mean a second dimension that could silently diverge.

CREATE TABLE "solution_component_projections" (
  "component_id" text NOT NULL,
  "version" integer NOT NULL,
  -- Denormalized from `solution_components` so a filtered retrieval does not join per query. Safe to
  -- copy because neither value changes for a given (component, version): a component's kind is part of
  -- its identity (`solution_components_kind_slug_unique`) and its source is where it came from.
  "kind" text NOT NULL,
  "source_key" text NOT NULL,
  -- What gets full-text indexed. A *derived* prose document — display name, capability labels, and the
  -- metadata fields worth matching on — not the raw metadata JSON, which contains download counts and
  -- library names that would only add noise to a lexical match.
  "search_document" text NOT NULL,
  -- Generated, so it cannot drift from `search_document`. A trigger or an application-side write could
  -- be forgotten on one code path; a generated column cannot.
  --
  -- 'english' rather than 'simple': the catalog is model, package and service metadata, which is
  -- overwhelmingly English, and stemming is what makes a brief asking for "translating documents" match
  -- a component whose card says "translation". The known exception is Jobindex's Danish role titles,
  -- where the English stemmer will not stem Danish words — those still match unstemmed, and their
  -- discriminating terms ("developer", "engineer", "analyst") are English loanwords anyway. Choosing a
  -- per-row language configuration would mean storing a language per component and is deliberately not
  -- done until something actually needs it.
  "search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('english', "search_document")) STORED,
  -- Exact structured filtering. The spec requires hard filters to be exact, so a capability requirement
  -- is an array containment test against this column and never a substring match on the document.
  "capability_keys" text[] DEFAULT '{}'::text[] NOT NULL,
  -- The strongest evidence level among this version's claims, for scoring. Denormalized because it is
  -- read on every candidate and computing it needs an aggregate over claims.
  "max_evidence_level" text NOT NULL,
  -- Hash of the projection's own inputs. An unchanged rebuild writes nothing, so re-running the
  -- projector over the whole catalog is cheap and safe.
  "content_hash" text NOT NULL,
  -- Bumped when the document builder changes shape. The upsert below refuses to go backwards on this,
  -- which is what stops a job that started before a rollout from overwriting a newer projection.
  "projection_version" integer NOT NULL,
  "observed_at" timestamp with time zone NOT NULL,
  "projected_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solution_component_projections_pkey" PRIMARY KEY ("component_id", "version"),
  -- CASCADE, not RESTRICT: a projection is derived. If the version it describes is gone, keeping the
  -- projection would mean retrieval could return a candidate whose version no longer exists — which is
  -- exactly the dangling reference the RESTRICT on evidence exists to prevent, inverted.
  CONSTRAINT "solution_component_projections_version_fkey"
    FOREIGN KEY ("component_id", "version")
    REFERENCES "solution_component_versions" ("component_id", "version") ON DELETE CASCADE,
  CONSTRAINT "solution_component_projections_kind_check"
    CHECK ("kind" IN ('human_profile', 'human_role', 'agent', 'model', 'model_endpoint', 'mcp_server', 'tool', 'service')),
  CONSTRAINT "solution_component_projections_evidence_check"
    CHECK ("max_evidence_level" IN ('claimed', 'observed', 'verified', 'production_evidence')),
  CONSTRAINT "solution_component_projections_version_positive_check"
    CHECK ("projection_version" > 0)
);

CREATE INDEX "solution_component_projections_search_idx"
  ON "solution_component_projections" USING gin ("search_vector");
-- GIN over the array so `capability_keys && $1` is an index scan. A brief names up to twenty
-- capabilities, so this is the filter that runs first on every retrieval.
CREATE INDEX "solution_component_projections_capabilities_idx"
  ON "solution_component_projections" USING gin ("capability_keys");
CREATE INDEX "solution_component_projections_kind_idx"
  ON "solution_component_projections" ("kind", "max_evidence_level");
-- Finds projections left behind by an older document builder, so a rollout can target them.
CREATE INDEX "solution_component_projections_stale_idx"
  ON "solution_component_projections" ("projection_version");

-- Grants. Retrieval reads as the app role. The projector is a worker, and unlike version history it
-- genuinely owns this table: rebuilding is DELETE + reinsert, which is the normal operation.
GRANT SELECT ON "solution_component_projections" TO "builderhunt_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "solution_component_projections" TO "builderhunt_worker";
GRANT SELECT, DELETE ON "solution_component_projections" TO "builderhunt_platform";

-- ── Lifecycle: how an ingested component becomes visible to retrieval ────────────────────────────
--
-- `solution_components.lifecycle_state` defaults to 'draft', and `findCandidateComponents` only reads
-- 'active'. Nothing ever promoted a component, so all eighteen components ingested from real sources
-- were invisible to retrieval and always would have been. Found by running the projector against them.
--
-- The rule now applied in `ingestComponentVersion`, recorded here because it is a policy decision and
-- not an implementation detail:
--
--   `official_api`, `feed`, `licensed_dataset`  → 'active'
--   `public_scrape`, `user_submission`          → 'draft'
--
-- The line is who asserted the component exists. When Hugging Face's own API says a model exists, that
-- is the publisher describing its own thing, and requiring a human to confirm each of thousands would
-- mean the catalog stays empty forever. When we inferred a component from a crawled page, we asserted
-- it, and that deserves review before it becomes advice.
--
-- This does not weaken any claim gate. A component being *listed* is not a claim about what it can do:
-- capability claims still enter at `claimed` and only a human raises them, and a compatibility edge from
-- similarity still cannot activate itself. Those are the gates that matter for advice.
UPDATE "solution_components" c
SET "lifecycle_state" = 'active', "updated_at" = now()
WHERE c."lifecycle_state" = 'draft'
  AND EXISTS (
    SELECT 1 FROM "solution_sources" s
    WHERE s."key" = c."source_key"
      AND s."kind" IN ('official_api', 'feed', 'licensed_dataset')
  );
