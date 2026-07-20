-- The worker may discover organization identifiers, but every product-table
-- operation remains scoped by a transaction-local organization setting.
CREATE POLICY organizations_worker_select ON organizations
  FOR SELECT TO builderhunt_worker USING (true);
--> statement-breakpoint

CREATE POLICY alerts_worker_select ON alerts
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY alerts_worker_update ON alerts
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY alert_triggers_worker_select ON alert_triggers
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY alert_triggers_worker_insert ON alert_triggers
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY builders_worker_select ON builders
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

GRANT SELECT (id) ON TABLE organizations TO builderhunt_worker;
GRANT SELECT, UPDATE (last_triggered_at) ON TABLE alerts TO builderhunt_worker;
GRANT SELECT, INSERT ON TABLE alert_triggers TO builderhunt_worker;
GRANT SELECT ON TABLE builders TO builderhunt_worker;
GRANT SELECT (id, email) ON TABLE auth_users TO builderhunt_worker;
