-- Custom SQL migration file, put your code below! --

-- work-sample plan: `work_sample_analyses` is the recruiter's own artifact,
-- keyed by `user_id` (not `organization_id`) — same non-tenant pattern as
-- `builder_claims` (0011_builder_claim_policies.sql), so RLS filters on
-- `app.user_id` instead of `app.organization_id`.
ALTER TABLE work_sample_analyses ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_sample_analyses FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY work_sample_analyses_app_select ON work_sample_analyses
  FOR SELECT TO builderhunt_app
  USING (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY work_sample_analyses_app_insert ON work_sample_analyses
  FOR INSERT TO builderhunt_app
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY work_sample_analyses_app_update ON work_sample_analyses
  FOR UPDATE TO builderhunt_app
  USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY work_sample_analyses_app_delete ON work_sample_analyses
  FOR DELETE TO builderhunt_app
  USING (user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE work_sample_analyses TO builderhunt_app;
