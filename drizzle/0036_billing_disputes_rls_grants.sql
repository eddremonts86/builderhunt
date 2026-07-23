-- RLS and runtime-role grants for billing_disputes, added in 0035
-- (plans/stripe-billing-platform/tasks.md §8, "Implement dispute freeze, outcome, and alerts").
-- Deliberately a separate migration from 0035's CREATE TABLE, matching this codebase's established
-- split (0027/0028, 0032/0033, ...).
--
-- Tenant-private, organization-scoped RLS (identical filter used everywhere else in this codebase).
--
-- Role split:
--   - builderhunt_app: SELECT only — a dispute is never created or decided by the app role; it is
--     entirely webhook-driven (worker) and operator-reviewed (platform). App-role read access exists
--     so a future billing-summary DTO (spec.md's `GET /api/billing/summary`, §9 task 1) can surface
--     "your organization has an open dispute" without a second query path.
--   - builderhunt_worker: SELECT/INSERT/UPDATE — `charge.dispute.created/updated/closed/
--     funds_reinstated` are the only writers (webhook-handlers.ts).
--   - builderhunt_platform: SELECT only — the admin `DisputeQueue.tsx` review surface is read-only;
--     there is no operator "decide" mutation for disputes the way there is for refunds (Stripe's own
--     dispute-evidence submission happens in the Stripe Dashboard, out of this app's scope).

ALTER TABLE billing_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_disputes FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY billing_disputes_app_select ON billing_disputes
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_disputes_worker_select ON billing_disputes
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_disputes_worker_insert ON billing_disputes
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_disputes_worker_update ON billing_disputes
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_disputes_platform_select ON billing_disputes
  FOR SELECT TO builderhunt_platform
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

REVOKE ALL ON TABLE billing_disputes FROM PUBLIC;

GRANT SELECT ON TABLE billing_disputes TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE billing_disputes TO builderhunt_worker;
GRANT SELECT ON TABLE billing_disputes TO builderhunt_platform;
