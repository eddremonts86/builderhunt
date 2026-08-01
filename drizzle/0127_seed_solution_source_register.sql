-- Custom SQL migration file, put your code below! --
-- Seeds the solutions source register, and corrects `allowed_fields` to the keys the adapters actually
-- emit.
--
-- Two defects this fixes, both found by running the Jobindex adapter end-to-end and then asking why the
-- other two sources had never been exercised the same way:
--
-- 1. **The register had no rows in any migration.** The entries the Phase 4 work was developed against
--    were inserted ad hoc into one developer database and never committed. On a fresh database —
--    including CI and production — `solution_sources` was empty, so `runSolutionSourceAdapter` answered
--    `source_not_registered` for every adapter and the entire catalog was unreachable. Nothing failed
--    loudly: an unregistered source is a legitimate state, so this looked exactly like "no sources
--    configured yet".
--
-- 2. **`allowed_fields` did not match the adapters.** The register listed `pipeline_tag` (snake_case)
--    while the Hugging Face adapter emits `pipelineTag`, and `filterToAllowedFields` drops anything not
--    named. The result would have been a catalog of models storing nothing but a download count —
--    quietly, because at least one key did survive, so the runner's `emptyAfterFieldFilter` counter
--    stayed at zero and reported a clean run.
--
-- The field lists below are the adapters' own metadata keys. `assertAdapterFieldsAreRegistered` (see
-- src/lib/solutions/sources/runner.ts) now compares the two directly, so the next mismatch is a failing
-- test rather than a silently truncated catalog.
--
-- Every row ships `enabled = false`, unlike the search register in 0126. There is no status quo to
-- preserve here: nothing was ingesting, so starting each source is a deliberate operator act through
-- Admin → Sources.

INSERT INTO "solution_sources"
  ("key", "kind", "label", "homepage_url", "enabled", "allowed_fields", "geography",
   "rate_limit_per_hour", "refresh_interval_hours", "retention_days", "register_notes")
VALUES
  -- Keys from src/lib/solutions/sources/huggingface.ts. `likes` and `tags` are the model card's own
  -- declared fields; nothing about the model's author is read, which is why no owner field appears here.
  ('huggingface_models', 'official_api', 'Hugging Face model metadata', 'https://huggingface.co', false,
   '["pipelineTag","libraryName","downloads","likes","tags"]'::jsonb, 'global', 600, 24, 180,
   'Documented public HTTP API (huggingface.co/api/models). Model card fields only. pipeline_tag is mapped to our capability vocabulary by exact lookup; an unmapped tag yields no claim.'),

  -- Keys from src/lib/solutions/sources/npm.ts. The registry also publishes maintainer names and
  -- emails; they are deliberately absent from both the adapter and this list, because a catalog of
  -- tools is not where a person's contact details belong.
  ('npm_registry', 'official_api', 'npm registry metadata', 'https://registry.npmjs.org', false,
   '["description","version","keywords"]'::jsonb, 'global', 600, 24, 180,
   'Registry API, the same endpoint every package manager uses. Capabilities come from an exact keyword allowlist, never a fuzzy match.'),

  -- No adapter and no ingestion: these components are authored by us. Registered anyway so every
  -- component in the catalog has a source row explaining where it came from, including "we wrote it".
  ('generic_human_roles', 'user_submission', 'Authored specialist roles', 'https://builderhunt.eduardoinerarte.dk', false,
   '["name","description"]'::jsonb, 'global', NULL, NULL, NULL,
   'Authored in-house, not ingested. Provides the generic human_role components the composer pairs with agents when no specific person is required.'),

  -- Registered so the catalog can link out to a vendor''s LinkedIn presence without ingesting anything.
  -- `allowed_fields` is empty, and solution_sources_link_only_stores_nothing_check enforces that.
  ('linkedin_profiles', 'external_link_only', 'LinkedIn (link out only)', 'https://www.linkedin.com', false,
   '[]'::jsonb, 'global', NULL, NULL, NULL,
   'https://www.linkedin.com/legal/crawling-terms prohibits automated collection and no permission is on file. Outbound links only — nothing fetched from this host is stored.'),

  -- Planned, with no adapter yet. A registered source with no adapter simply never ingests, so this is
  -- an honest placeholder rather than a promise: the register describes intent, the adapter list
  -- (SOLUTION_ADAPTERS) describes capability, and the two are allowed to differ in this direction.
  ('mcp_servers_registry', 'feed', 'MCP server directory feed', 'https://modelcontextprotocol.io', false,
   '["name","description","capabilities"]'::jsonb, 'global', 60, 24, 180,
   'Published directory feed. No adapter implemented yet, so this source is registered but never ingests. Enabling it has no effect until one lands.')
ON CONFLICT ("key") DO UPDATE SET
  -- Corrects the developer-database rows in place. `enabled` is deliberately NOT reset: if an operator
  -- has already switched a source on, a migration that fixes a field list has no business switching it
  -- back off.
  "allowed_fields" = EXCLUDED."allowed_fields",
  "label" = EXCLUDED."label",
  "homepage_url" = EXCLUDED."homepage_url",
  "geography" = EXCLUDED."geography",
  "rate_limit_per_hour" = EXCLUDED."rate_limit_per_hour",
  "refresh_interval_hours" = EXCLUDED."refresh_interval_hours",
  "retention_days" = EXCLUDED."retention_days",
  "register_notes" = EXCLUDED."register_notes",
  "updated_at" = now();

-- A placeholder that leaked out of development: `homepage_url` was `https://example.test`, and it
-- contradicted the documentation crawl adapter, which states in its own header that no real source is
-- registered for it. Choosing a crawl target means reading a specific site's terms and robots policy, so
-- the target list is operator data added through Admin → Sources with a recorded review — not a row a
-- migration is entitled to invent.
--
-- Guarded on emptiness: if anything was ever ingested under this key, the row stays and the operator
-- decides. ON DELETE RESTRICT from solution_components would refuse the delete anyway; the WHERE clause
-- turns that from a failed migration into a no-op.
DELETE FROM "solution_sources"
WHERE "key" = 'vendor_docs_scrape'
  AND NOT EXISTS (SELECT 1 FROM "solution_components" WHERE "source_key" = 'vendor_docs_scrape');
