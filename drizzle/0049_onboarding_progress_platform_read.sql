-- Custom SQL migration file, put your code below! --

-- onboarding-flow plan, "Add activation metrics to the admin metrics endpoint": the platform
-- admin metrics endpoint needs a real cross-organization aggregate (completed/skipped counts,
-- 7-day activation rate) over `onboarding_progress`. That table's RLS (0008_tenant_rls.sql) only
-- ever granted `builderhunt_app`, scoped per-organization by `app.organization_id` — there was no
-- `builderhunt_platform` policy at all, so a platform-role read returned zero rows regardless of
-- grants (RLS is FORCE'd on this table). This adds a read-only, unscoped SELECT policy for
-- `builderhunt_platform` — admin aggregate reporting, never a write path, matching the same
-- "platform reads across all tenants for metrics/investigation" precedent already used elsewhere
-- (e.g. account_risk's platform-scoped read, abuse_signals' platform SELECT grant).
GRANT SELECT ON TABLE onboarding_progress TO builderhunt_platform;

CREATE POLICY onboarding_progress_platform_select ON onboarding_progress
  FOR SELECT TO builderhunt_platform
  USING (true);