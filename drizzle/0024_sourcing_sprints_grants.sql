-- `sourcing_sprints`/`sprint_results` (drizzle/0015_loud_nitro.sql, plan:
-- ai-sourcing-sprints) were created after the tenant-RLS/grants migration
-- (0008) and the worker-role migration (0010) and were never added to
-- either — RLS was never enabled and `builderhunt_app`/`builderhunt_worker`
-- had no grant at all on these two tables. Every sprint route
-- (list/create/detail/results) and the sprints background worker
-- (src/lib/sprints/worker.ts) have been completely broken against the real
-- least-privilege runtime roles since the feature shipped; this was only
-- ever exercised against the owner role in dev/tests. Found by extending
-- scripts/db/verify-api-isolation-local.mjs to cover sprints (task 15).
ALTER TABLE sourcing_sprints ENABLE ROW LEVEL SECURITY;
ALTER TABLE sourcing_sprints FORCE ROW LEVEL SECURITY;
ALTER TABLE sprint_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE sprint_results FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY sourcing_sprints_app_select ON sourcing_sprints
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY sourcing_sprints_app_insert ON sourcing_sprints
  FOR INSERT TO builderhunt_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY sourcing_sprints_app_update ON sourcing_sprints
  FOR UPDATE TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY sourcing_sprints_app_delete ON sourcing_sprints
  FOR DELETE TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY sprint_results_app_select ON sprint_results
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

-- Worker mirrors the alerts-worker split (drizzle/0010_worker_alert_policies.sql):
-- read/advance the one sprint it's currently processing, insert new result rows.
CREATE POLICY sourcing_sprints_worker_select ON sourcing_sprints
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY sourcing_sprints_worker_update ON sourcing_sprints
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY sprint_results_worker_select ON sprint_results
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY sprint_results_worker_insert ON sprint_results
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

REVOKE ALL ON TABLE sourcing_sprints, sprint_results FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE sourcing_sprints TO builderhunt_app;
GRANT SELECT ON TABLE sprint_results TO builderhunt_app;
GRANT SELECT, UPDATE ON TABLE sourcing_sprints TO builderhunt_worker;
GRANT SELECT, INSERT ON TABLE sprint_results TO builderhunt_worker;
