-- RLS and runtime-role grants for the 14 billing/credit tables added in 0027
-- (plans/stripe-billing-platform/tasks.md §2, "Apply billing RLS and runtime-role
-- policy"). Deliberately a separate migration from 0027's CREATE TABLE statements,
-- matching this codebase's established split (see 0024_sourcing_sprints_grants.sql's
-- retroactive fix for a table that shipped without one).
--
-- Two classes:
--   1. Tenant-private (11 tables): organization-scoped RLS, identical
--      `organization_id = nullif(current_setting('app.organization_id', true), '')`
--      filter used everywhere else in this codebase (0008_tenant_rls.sql) — missing
--      or empty context compares unequal to any row, so it default-denies.
--   2. System operational (3 tables, no organization_id): billing_webhook_events,
--      billing_reconciliation_runs, billing_seller_profiles. No RLS needed or
--      possible; access is controlled entirely by GRANT to builderhunt_worker/platform.
--
-- Role split (spec.md §Data model, §API contract — "browser roles cannot mutate
-- financial state directly"):
--   - builderhunt_app (web runtime): SELECT on every tenant table. INSERT/UPDATE only
--     on the three tables that are direct, safe consequences of an owner-initiated
--     request that the route layer already permission-checks: billing_checkout_attempts
--     (create/advance a Checkout attempt), billing_auto_recharge_rules (owner
--     configures their own pack/threshold/cap), billing_terms_acceptances (append a
--     consent record). Every other tenant table — customers, subscriptions, credit
--     grants/reservations/allocations, the ledger, provider usage, refunds — is
--     SELECT-only for builderhunt_app; all mutations there are "financial state" and
--     go through builderhunt_worker even when triggered synchronously by a request
--     (mirrors this repo's existing worker-role pattern for sprints/alerts), never
--     through the browser-facing role.
--   - builderhunt_worker: SELECT/INSERT/UPDATE on every tenant table's financial-state
--     columns (webhook-driven subscription/grant activation, reservation/settlement,
--     provider usage, refund processing, auto-recharge failure handling). Never
--     DELETE anywhere — ledger entries in particular are append-only and never
--     updated by any role, matching billing_ledger_entries having no updatedAt column.
--   - builderhunt_platform: read access for admin dashboards plus the specific
--     platform-admin-owned mutations from spec.md's API contract — seller
--     configuration (billing_seller_profiles, versioned insert-only), webhook event
--     replay (billing_webhook_events), and refund review/decision
--     (billing_refunds, same org-scoped policy as app/worker — a cross-tenant admin
--     review queue's "which orgs have pending refunds" discovery step is deferred to
--     whichever task builds that route, same as the worker's own cross-org loop
--     pattern in src/lib/sprints/worker.ts).
--   - builderhunt_auth: no grants on any billing_* table — auth owns only Better
--     Auth adapter + organization lifecycle tables, never product/financial data.

-- ---------------------------------------------------------------------------
-- 1. Enable RLS on tenant-private tables
-- ---------------------------------------------------------------------------

ALTER TABLE billing_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_customers FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_checkout_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_checkout_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_credit_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_provider_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_provider_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_auto_recharge_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_auto_recharge_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_refunds FORCE ROW LEVEL SECURITY;
ALTER TABLE billing_terms_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_terms_acceptances FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. builderhunt_app policies (SELECT everywhere; INSERT/UPDATE only on the
--    three owner-initiated-request tables)
-- ---------------------------------------------------------------------------

CREATE POLICY billing_customers_app_select ON billing_customers
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_subscriptions_app_select ON billing_subscriptions
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_checkout_attempts_app_select ON billing_checkout_attempts
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_checkout_attempts_app_insert ON billing_checkout_attempts
  FOR INSERT TO builderhunt_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_checkout_attempts_app_update ON billing_checkout_attempts
  FOR UPDATE TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_credit_grants_app_select ON billing_credit_grants
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_credit_reservations_app_select ON billing_credit_reservations
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_credit_allocations_app_select ON billing_credit_allocations
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_ledger_entries_app_select ON billing_ledger_entries
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_provider_usage_app_select ON billing_provider_usage
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_auto_recharge_rules_app_select ON billing_auto_recharge_rules
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_auto_recharge_rules_app_insert ON billing_auto_recharge_rules
  FOR INSERT TO builderhunt_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_auto_recharge_rules_app_update ON billing_auto_recharge_rules
  FOR UPDATE TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_refunds_app_select ON billing_refunds
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
-- Owner submits a refund REQUEST row (never an outcome) — restricted to the
-- request's initial state so the app role cannot insert a pre-decided refund.
CREATE POLICY billing_refunds_app_insert ON billing_refunds
  FOR INSERT TO builderhunt_app
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND state = 'pending'
    AND stripe_refund_id IS NULL
  );

CREATE POLICY billing_terms_acceptances_app_select ON billing_terms_acceptances
  FOR SELECT TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_terms_acceptances_app_insert ON billing_terms_acceptances
  FOR INSERT TO builderhunt_app
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. builderhunt_worker policies (financial-state mutations — webhook-driven
--    and reservation/settlement writes, even when triggered synchronously by a
--    request; never DELETE, never touches the ledger's append-only rows after insert)
-- ---------------------------------------------------------------------------

CREATE POLICY billing_customers_worker_select ON billing_customers
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_customers_worker_insert ON billing_customers
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_customers_worker_update ON billing_customers
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_subscriptions_worker_select ON billing_subscriptions
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_subscriptions_worker_insert ON billing_subscriptions
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_subscriptions_worker_update ON billing_subscriptions
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_checkout_attempts_worker_select ON billing_checkout_attempts
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_checkout_attempts_worker_update ON billing_checkout_attempts
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_credit_grants_worker_select ON billing_credit_grants
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_credit_grants_worker_insert ON billing_credit_grants
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_credit_grants_worker_update ON billing_credit_grants
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_credit_reservations_worker_select ON billing_credit_reservations
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_credit_reservations_worker_insert ON billing_credit_reservations
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_credit_reservations_worker_update ON billing_credit_reservations
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_credit_allocations_worker_select ON billing_credit_allocations
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_credit_allocations_worker_insert ON billing_credit_allocations
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_credit_allocations_worker_update ON billing_credit_allocations
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

-- Append-only: SELECT + INSERT only, no UPDATE for any role, ever.
CREATE POLICY billing_ledger_entries_worker_select ON billing_ledger_entries
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_ledger_entries_worker_insert ON billing_ledger_entries
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_provider_usage_worker_select ON billing_provider_usage
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_provider_usage_worker_insert ON billing_provider_usage
  FOR INSERT TO builderhunt_worker
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_provider_usage_worker_update ON billing_provider_usage
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_auto_recharge_rules_worker_select ON billing_auto_recharge_rules
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_auto_recharge_rules_worker_update ON billing_auto_recharge_rules
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_refunds_worker_select ON billing_refunds
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_refunds_worker_update ON billing_refunds
  FOR UPDATE TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));

CREATE POLICY billing_terms_acceptances_worker_select ON billing_terms_acceptances
  FOR SELECT TO builderhunt_worker
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. builderhunt_platform policies (admin-owned mutations only — seller
--    configuration is granted separately below since it has no organization_id;
--    refund review/webhook replay reuse the same org-scoped filter)
-- ---------------------------------------------------------------------------

CREATE POLICY billing_refunds_platform_select ON billing_refunds
  FOR SELECT TO builderhunt_platform
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''));
CREATE POLICY billing_refunds_platform_update ON billing_refunds
  FOR UPDATE TO builderhunt_platform
  USING (organization_id = nullif(current_setting('app.organization_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), ''));
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 5. Grants for tenant-private tables (RLS above narrows rows; these grants
--    narrow verbs — deny-by-default for any verb/role pair not listed)
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE
  billing_customers, billing_subscriptions, billing_checkout_attempts,
  billing_credit_grants, billing_credit_reservations, billing_credit_allocations,
  billing_ledger_entries, billing_provider_usage, billing_auto_recharge_rules,
  billing_refunds, billing_terms_acceptances
FROM PUBLIC;

GRANT SELECT ON TABLE
  billing_customers, billing_subscriptions,
  billing_credit_grants, billing_credit_reservations, billing_credit_allocations,
  billing_ledger_entries, billing_provider_usage,
  billing_refunds, billing_terms_acceptances
TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE ON TABLE billing_checkout_attempts, billing_auto_recharge_rules TO builderhunt_app;
GRANT INSERT ON TABLE billing_refunds, billing_terms_acceptances TO builderhunt_app;

GRANT SELECT, INSERT, UPDATE ON TABLE
  billing_customers, billing_subscriptions, billing_checkout_attempts,
  billing_credit_grants, billing_credit_reservations, billing_credit_allocations,
  billing_provider_usage, billing_auto_recharge_rules, billing_refunds
TO builderhunt_worker;
GRANT SELECT, INSERT ON TABLE billing_ledger_entries TO builderhunt_worker;
GRANT SELECT ON TABLE billing_terms_acceptances TO builderhunt_worker;

GRANT SELECT, UPDATE ON TABLE billing_refunds TO builderhunt_platform;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 6. System-operational tables — no organization_id, no RLS possible or
--    needed; access controlled entirely by GRANT. builderhunt_app gets nothing.
-- ---------------------------------------------------------------------------

REVOKE ALL ON TABLE billing_webhook_events, billing_reconciliation_runs, billing_seller_profiles FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON TABLE billing_webhook_events TO builderhunt_worker;
GRANT SELECT, UPDATE ON TABLE billing_webhook_events TO builderhunt_platform;

GRANT SELECT, INSERT ON TABLE billing_reconciliation_runs TO builderhunt_worker;
GRANT SELECT ON TABLE billing_reconciliation_runs TO builderhunt_platform;

GRANT SELECT, INSERT ON TABLE billing_seller_profiles TO builderhunt_platform;
