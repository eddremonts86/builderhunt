-- Custom SQL migration file, put your code below! --

-- Public Profile Enrichment (plan: stealth-scraping) — RLS + role grants.
-- Spec: plans/stealth-scraping/spec.md §14. Mirrors the 0008/0010/0011 pattern
-- (RLS as a hand-written follow-up migration after drizzle-kit's schema diff).

ALTER TABLE enrichment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE enrichment_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_evidence FORCE ROW LEVEL SECURITY;
ALTER TABLE builder_processing_restrictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder_processing_restrictions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- App role (user-facing routes): strictly organization-scoped. Members can
-- enqueue/read their own org's jobs and read/review their own org's evidence.
-- No INSERT/DELETE on evidence — only the worker persists candidates.
CREATE POLICY enrichment_jobs_app_select ON enrichment_jobs
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY enrichment_jobs_app_insert ON enrichment_jobs
  FOR INSERT TO builderhunt_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY enrichment_evidence_app_select ON enrichment_evidence
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY enrichment_evidence_app_update ON enrichment_evidence
  FOR UPDATE TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

-- Worker role: deliberately broader than other workers' per-org policies.
-- This worker's own semantics require cross-tenant operations no other
-- worker needs: (a) scanning due jobs across every organization before it
-- knows which org a row belongs to (FOR UPDATE SKIP LOCKED claim step), (b)
-- the subject-restriction cascade, which cancels/purges every organization's
-- jobs/evidence for one builder identity, and (c) the bounded retention pass,
-- which deletes expired rows across organizations. The role itself remains
-- least-privilege at the connection level: builderhunt_worker is reachable
-- only from src/lib/enrichment/worker.ts, invoked by the admin-authenticated
-- run-worker endpoint — never from a user request with caller-supplied
-- org/builder/connector input (spec §10, run-worker contract).
CREATE POLICY enrichment_jobs_worker_all ON enrichment_jobs
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);
CREATE POLICY enrichment_evidence_worker_all ON enrichment_evidence
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);
--> statement-breakpoint

-- Platform role: subject-restriction rows only. No direct app-table
-- mutation — the restriction cascade (cancel jobs / purge evidence) goes
-- through the worker role, not through builderhunt_platform.
CREATE POLICY builder_processing_restrictions_platform_all ON builder_processing_restrictions
  FOR ALL TO builderhunt_platform USING (true) WITH CHECK (true);
--> statement-breakpoint

REVOKE ALL ON TABLE enrichment_jobs, enrichment_evidence, builder_processing_restrictions FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE enrichment_jobs TO builderhunt_app;
GRANT SELECT, UPDATE ON TABLE enrichment_evidence TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE enrichment_jobs, enrichment_evidence TO builderhunt_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE builder_processing_restrictions TO builderhunt_platform;
--> statement-breakpoint

-- The app and worker roles never read builder_processing_restrictions rows
-- directly (spec §7.3: "the app role can read only the effective boolean
-- through a reviewed repository function"). SECURITY DEFINER lets this
-- function evaluate the restriction under the owning (migration) role's
-- privileges without granting either caller role raw table access.
CREATE OR REPLACE FUNCTION is_builder_processing_restricted(target_builder_identity_id text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM builder_processing_restrictions
    WHERE builder_identity_id = target_builder_identity_id AND status = 'active'
  );
$$;

GRANT EXECUTE ON FUNCTION is_builder_processing_restricted(text) TO builderhunt_app, builderhunt_worker;
