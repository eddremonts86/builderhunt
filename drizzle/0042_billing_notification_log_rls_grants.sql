-- RLS and runtime-role grants for billing_notification_log, added in 0041
-- (plans/stripe-billing-platform/tasks.md §10, "Add financial notifications, metrics, and alerts").
-- Deliberately a separate migration from 0041's CREATE TABLE, matching this codebase's established
-- split (0027/0028, 0035/0036, 0037/0038, 0039/0040, ...).
--
-- organization_id has no FK (see schema.ts's comment on this table) so the policy filter below just
-- compares the literal column value, same as organization_deletion_financial_records' policies.
--
-- Role split:
--   - builderhunt_worker: SELECT, INSERT — notifications.ts's sweep runs worker-scoped and is the
--     only writer (an ON CONFLICT DO NOTHING dedup insert), matching billing_disputes'
--     worker-writes/platform-reads shape.
--   - builderhunt_platform: SELECT only — for operator visibility into what was already sent.
--   - builderhunt_app: no access — this table is never read or written by tenant-owner-initiated
--     requests.

ALTER TABLE billing_notification_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_notification_log FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY billing_notification_log_worker_select ON billing_notification_log
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), '') OR organization_id = 'platform');
CREATE POLICY billing_notification_log_worker_insert ON billing_notification_log
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '') OR organization_id = 'platform');

CREATE POLICY billing_notification_log_platform_select ON billing_notification_log
  FOR SELECT TO builderhunt_platform
  USING (true);
--> statement-breakpoint

REVOKE ALL ON TABLE billing_notification_log FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE billing_notification_log TO builderhunt_worker;
GRANT SELECT ON TABLE billing_notification_log TO builderhunt_platform;
