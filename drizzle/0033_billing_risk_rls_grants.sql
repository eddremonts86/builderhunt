-- RLS and runtime-role grants for the 2 fraud/risk tables added in 0032
-- (plans/stripe-billing-platform/tasks.md §8, "Add fraud and high-volume exception
-- controls"). Deliberately a separate migration from 0032's CREATE TABLE statements,
-- matching this codebase's established split (0027/0028, 0029/… precedent).
--
-- Both tables are tenant-private (organization-scoped RLS, identical
-- `organization_id = nullif(current_setting('app.organization_id', true), '')`
-- filter used everywhere else in this codebase).
--
-- Role split:
--   - builderhunt_app: SELECT + INSERT on billing_risk_events (a synchronous Checkout
--     decline recorded directly by the owner-initiated request, same reasoning as
--     billing_checkout_attempts' own app-insert policy in 0028) and SELECT-only on
--     billing_risk_exceptions (risk.ts's evaluateRiskBlock must be able to check for an
--     active exception when running under app context in packs.ts). No UPDATE, ever —
--     risk events are append-only like billing_ledger_entries.
--   - builderhunt_worker: same SELECT + INSERT on billing_risk_events (auto-recharge's
--     worker-triggered decline path) and SELECT-only on billing_risk_exceptions.
--   - builderhunt_platform: SELECT on billing_risk_events (review queue) and full
--     SELECT/INSERT/UPDATE on billing_risk_exceptions (issue/revoke — the only role that
--     ever writes an exception).

ALTER TABLE billing_risk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_risk_events FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_risk_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_risk_exceptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY billing_risk_events_app_select ON billing_risk_events
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_risk_events_app_insert ON billing_risk_events
  FOR INSERT TO builderhunt_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_risk_events_worker_select ON billing_risk_events
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_risk_events_worker_insert ON billing_risk_events
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_risk_events_platform_select ON billing_risk_events
  FOR SELECT TO builderhunt_platform
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

CREATE POLICY billing_risk_exceptions_app_select ON billing_risk_exceptions
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_risk_exceptions_worker_select ON billing_risk_exceptions
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_risk_exceptions_platform_select ON billing_risk_exceptions
  FOR SELECT TO builderhunt_platform
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_risk_exceptions_platform_insert ON billing_risk_exceptions
  FOR INSERT TO builderhunt_platform
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_risk_exceptions_platform_update ON billing_risk_exceptions
  FOR UPDATE TO builderhunt_platform
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

REVOKE ALL ON TABLE billing_risk_events, billing_risk_exceptions FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE billing_risk_events TO builderhunt_app;
GRANT SELECT ON TABLE billing_risk_exceptions TO builderhunt_app;

GRANT SELECT, INSERT ON TABLE billing_risk_events TO builderhunt_worker;
GRANT SELECT ON TABLE billing_risk_exceptions TO builderhunt_worker;

GRANT SELECT ON TABLE billing_risk_events TO builderhunt_platform;
GRANT SELECT, INSERT, UPDATE ON TABLE billing_risk_exceptions TO builderhunt_platform;
