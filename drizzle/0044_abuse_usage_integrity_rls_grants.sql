-- RLS and runtime-role grants for the 5 abuse-and-usage-integrity tables added in
-- 0043 (plans/abuse-and-usage-integrity/tasks.md, Phase 0 "Create abuse-integrity
-- tables migration" + "Data classification + role grants"). Deliberately a
-- separate migration from 0043's CREATE TABLE statements, matching this
-- codebase's established split (0027/0028 for billing).
--
-- Data classes (plans/_meta/security-policy.md "Data classes" table):
--   - Account subject (`user_id`): user_devices, account_risk. RLS filters on
--     `app.user_id`, the exact convention 0011_builder_claim_policies.sql
--     established for builder_claims/published_builder_profiles.
--   - Tenant private (`organization_id`): seat_usage_daily. RLS filters on
--     `app.organization_id`, this codebase's standard tenant-isolation shape
--     (0008_tenant_rls.sql, 0028_billing_rls_grants.sql).
--   - System operational (no owning subject): session_signals, abuse_signals.
--     No RLS possible or needed; access controlled entirely by GRANT, matching
--     billing_webhook_events/billing_reconciliation_runs in 0028.
--
-- Role split (task: "grant builderhunt_app only tenant-scoped access to
-- seat_usage_daily/user_devices, builderhunt_worker/builderhunt_platform access
-- to signal tables"):
--   - builderhunt_app: SELECT/INSERT/UPDATE on seat_usage_daily (own-org counter
--     increments, a synchronous request-path action) and user_devices (own
--     first-party device-cookie upsert, also request-path). No access at all to
--     account_risk, session_signals, or abuse_signals — an account's risk stage
--     and the signals that feed it are written exclusively by trusted
--     worker/platform paths, so a compromised or buggy app-role query can never
--     fabricate a signal or downgrade its own risk stage.
--   - builderhunt_worker: SELECT/INSERT/UPDATE on account_risk (background
--     scoring), SELECT/INSERT on session_signals/abuse_signals (signal
--     ingestion). account_risk stays user_id-scoped even for worker — per
--     security-policy.md ("workers acquire scope from persisted server-side
--     records and execute each tenant batch in its own transaction/context"),
--     a background scoring sweep processes one user's row per transaction,
--     the same per-subject-batch discipline sprints/worker.ts already applies
--     per-organization. Never DELETE anywhere.
--   - builderhunt_platform: SELECT/UPDATE on account_risk (admin manual
--     override of a stage, e.g. unblock), same user_id-scoped policy —
--     a "list all flagged accounts across users" admin view is deferred to
--     whichever task builds that route, same deferral 0028 documents for the
--     cross-org refund review queue. SELECT on session_signals/abuse_signals
--     for investigation/dashboards.
--   - builderhunt_auth: no grants on any of these tables.
--
-- No PUBLIC, TRUNCATE, or REFERENCES privileges anywhere.

-- ---------------------------------------------------------------------------
-- 1. Enable RLS on the account-subject and tenant-private tables
-- ---------------------------------------------------------------------------

ALTER TABLE user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_devices FORCE ROW LEVEL SECURITY;
ALTER TABLE account_risk ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_risk FORCE ROW LEVEL SECURITY;
ALTER TABLE seat_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE seat_usage_daily FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. builderhunt_app policies (own-subject/own-org, request-path writes only)
-- ---------------------------------------------------------------------------

CREATE POLICY user_devices_app_select ON user_devices
  FOR SELECT TO builderhunt_app
  USING (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY user_devices_app_insert ON user_devices
  FOR INSERT TO builderhunt_app
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY user_devices_app_update ON user_devices
  FOR UPDATE TO builderhunt_app
  USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));

CREATE POLICY seat_usage_daily_app_select ON seat_usage_daily
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY seat_usage_daily_app_insert ON seat_usage_daily
  FOR INSERT TO builderhunt_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY seat_usage_daily_app_update ON seat_usage_daily
  FOR UPDATE TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. builderhunt_worker policies (background scoring + signal ingestion;
--    also processes seat_usage_daily rollups/enforcement checks per-org)
-- ---------------------------------------------------------------------------

CREATE POLICY account_risk_worker_select ON account_risk
  FOR SELECT TO builderhunt_worker
  USING (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY account_risk_worker_insert ON account_risk
  FOR INSERT TO builderhunt_worker
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY account_risk_worker_update ON account_risk
  FOR UPDATE TO builderhunt_worker
  USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));

CREATE POLICY seat_usage_daily_worker_select ON seat_usage_daily
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY seat_usage_daily_worker_insert ON seat_usage_daily
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY seat_usage_daily_worker_update ON seat_usage_daily
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. builderhunt_platform policies (admin manual override only; same
--    user-scoped shape as worker — cross-user "list all flagged" views are a
--    separate, deferred task, same precedent as 0028's refund review queue)
-- ---------------------------------------------------------------------------

CREATE POLICY account_risk_platform_select ON account_risk
  FOR SELECT TO builderhunt_platform
  USING (user_id = nullif(current_setting('app.user_id', true), ''));
CREATE POLICY account_risk_platform_update ON account_risk
  FOR UPDATE TO builderhunt_platform
  USING (user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Grants for RLS-protected tables (RLS above narrows rows; these grants
--    narrow verbs — deny-by-default for any verb/role pair not listed)
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE user_devices, account_risk, seat_usage_daily FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON TABLE user_devices TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE seat_usage_daily TO builderhunt_app;

GRANT SELECT, INSERT, UPDATE ON TABLE account_risk TO builderhunt_worker;
GRANT SELECT, INSERT, UPDATE ON TABLE seat_usage_daily TO builderhunt_worker;

GRANT SELECT, UPDATE ON TABLE account_risk TO builderhunt_platform;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. System-operational tables — no owning subject, no RLS possible or
--    needed; access controlled entirely by GRANT. builderhunt_app gets nothing.
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE session_signals, abuse_signals FROM PUBLIC;

GRANT SELECT, INSERT ON TABLE session_signals TO builderhunt_worker;
GRANT SELECT ON TABLE session_signals TO builderhunt_platform;

GRANT SELECT, INSERT ON TABLE abuse_signals TO builderhunt_worker;
GRANT SELECT ON TABLE abuse_signals TO builderhunt_platform;
