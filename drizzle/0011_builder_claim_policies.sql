ALTER TABLE builder_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder_claims FORCE ROW LEVEL SECURITY;
ALTER TABLE published_builder_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_builder_profiles FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY builder_claims_app_select ON builder_claims
  FOR SELECT TO builderhunt_app
  USING (subject_user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY builder_claims_app_insert ON builder_claims
  FOR INSERT TO builderhunt_app
  WITH CHECK (subject_user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY builder_claims_app_update ON builder_claims
  FOR UPDATE TO builderhunt_app
  USING (subject_user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (subject_user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY published_builder_profiles_app_select ON published_builder_profiles
  FOR SELECT TO builderhunt_app USING (true);
CREATE POLICY published_builder_profiles_app_insert ON published_builder_profiles
  FOR INSERT TO builderhunt_app
  WITH CHECK (published_by_user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY published_builder_profiles_app_update ON published_builder_profiles
  FOR UPDATE TO builderhunt_app
  USING (published_by_user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (published_by_user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY published_builder_profiles_app_delete ON published_builder_profiles
  FOR DELETE TO builderhunt_app
  USING (published_by_user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON TABLE builder_identities TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE builder_claims TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE published_builder_profiles TO builderhunt_app;
