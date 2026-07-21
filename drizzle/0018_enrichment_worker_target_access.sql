-- Custom SQL migration file, put your code below! --

-- The enrichment worker (src/lib/enrichment/worker.ts) needs to load a
-- tracked builder's identity fields to build an EnrichmentTarget. Neither
-- grant existed before this feature — no prior worker touched these tables.
CREATE POLICY organization_builders_worker_select ON organization_builders
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

GRANT SELECT ON TABLE organization_builders TO builderhunt_worker;
GRANT SELECT ON TABLE builder_identities TO builderhunt_worker;
