-- RLS is installed before the web credential cutover. Legacy owner-backed
-- application deployments continue to run until backfill and A/B gates pass.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_members FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_plan_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_plan_changes FORCE ROW LEVEL SECURITY;
ALTER TABLE organization_builders ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_builders FORCE ROW LEVEL SECURITY;
ALTER TABLE builders ENABLE ROW LEVEL SECURITY;
ALTER TABLE builders FORCE ROW LEVEL SECURITY;
ALTER TABLE saved_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_queries FORCE ROW LEVEL SECURITY;
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerts FORCE ROW LEVEL SECURITY;
ALTER TABLE alert_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE alert_triggers FORCE ROW LEVEL SECURITY;
ALTER TABLE builder_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder_notes FORCE ROW LEVEL SECURITY;
ALTER TABLE onboarding_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_progress FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Better Auth is an isolated broker with access only to its own organization
-- lifecycle tables. It cannot read any product resource table.
CREATE POLICY organizations_auth_broker_all ON organizations
  FOR ALL TO builderhunt_auth USING (true) WITH CHECK (true);
CREATE POLICY organization_members_auth_broker_all ON organization_members
  FOR ALL TO builderhunt_auth USING (true) WITH CHECK (true);
CREATE POLICY organization_invitations_auth_broker_all ON organization_invitations
  FOR ALL TO builderhunt_auth USING (true) WITH CHECK (true);
--> statement-breakpoint

CREATE POLICY organizations_app_select ON organizations
  FOR SELECT TO builderhunt_app
  USING (id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY organization_members_app_select ON organization_members
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY organization_entitlements_app_select ON organization_entitlements
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY organization_plan_changes_app_select ON organization_plan_changes
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY organization_plan_changes_app_insert ON organization_plan_changes
  FOR INSERT TO builderhunt_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

-- Product tables receive one explicit policy per SQL command. Missing or empty
-- transaction settings compare unequal and therefore default-deny.
DO $$
DECLARE
  target_table text;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'organization_builders',
    'builders',
    'saved_queries',
    'alerts',
    'alert_triggers',
    'builder_notes',
    'onboarding_progress'
  ]
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO builderhunt_app USING (organization_id = nullif(current_setting(''app.organization_id'', true), ''''))',
      target_table || '_app_select', target_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO builderhunt_app WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), ''''))',
      target_table || '_app_insert', target_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO builderhunt_app USING (organization_id = nullif(current_setting(''app.organization_id'', true), '''')) WITH CHECK (organization_id = nullif(current_setting(''app.organization_id'', true), ''''))',
      target_table || '_app_update', target_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE TO builderhunt_app USING (organization_id = nullif(current_setting(''app.organization_id'', true), ''''))',
      target_table || '_app_delete', target_table
    );
  END LOOP;
END
$$;
--> statement-breakpoint

REVOKE ALL ON TABLE
  organizations,
  organization_members,
  organization_invitations,
  organization_entitlements,
  organization_plan_changes,
  organization_builders,
  builders,
  saved_queries,
  alerts,
  alert_triggers,
  builder_notes,
  onboarding_progress
FROM PUBLIC;

GRANT SELECT ON TABLE organizations, organization_members, organization_entitlements TO builderhunt_app;
GRANT SELECT, INSERT ON TABLE organization_plan_changes TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  organization_builders,
  builders,
  saved_queries,
  alerts,
  alert_triggers,
  builder_notes,
  onboarding_progress
TO builderhunt_app;
