-- RLS and runtime-role grants for billing_contacts, added in 0037
-- (plans/stripe-billing-platform/tasks.md §9, "Add verified billing contact management").
-- Deliberately a separate migration from 0037's CREATE TABLE, matching this codebase's established
-- split (0027/0028, 0032/0033, 0035/0036, ...).
--
-- Tenant-private, organization-scoped RLS (identical filter used everywhere else in this codebase).
--
-- Role split:
--   - builderhunt_app: SELECT/INSERT/UPDATE — owner-initiated self-service, matching
--     billing_auto_recharge_rules' exact shape (a single per-organization row the app role writes
--     directly via a TenantTransaction, never through the worker).
--   - builderhunt_worker: SELECT only — invoice/receipt/renewal/payment-failure notification sending
--     (webhook-handlers.ts) needs to look up the current verified contact; it never creates or
--     changes one.
--   - builderhunt_platform: SELECT only — for future support/operator tooling; no operator mutation
--     exists (only the owner sets/changes their own contact).

ALTER TABLE billing_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_contacts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY billing_contacts_app_select ON billing_contacts
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_contacts_app_insert ON billing_contacts
  FOR INSERT TO builderhunt_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_contacts_app_update ON billing_contacts
  FOR UPDATE TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_contacts_worker_select ON billing_contacts
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_contacts_platform_select ON billing_contacts
  FOR SELECT TO builderhunt_platform
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

REVOKE ALL ON TABLE billing_contacts FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON TABLE billing_contacts TO builderhunt_app;
GRANT SELECT ON TABLE billing_contacts TO builderhunt_worker;
GRANT SELECT ON TABLE billing_contacts TO builderhunt_platform;
