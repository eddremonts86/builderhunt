# Database Roles

BuilderHunt uses separate credentials. Never inject more than the role required by a process.

| Process | Environment | Role | Access |
| --- | --- | --- | --- |
| Web/product repositories | `DATABASE_URL` | `builderhunt_app` | RLS-scoped product tables only |
| Better Auth adapter | `DATABASE_AUTH_URL` | `builderhunt_auth` | auth and organization lifecycle tables only |
| Migration/backfill job | `DATABASE_MIGRATION_URL` | deployment owner | DDL and approved backfills; never web runtime |
| Background worker | `DATABASE_WORKER_URL` | `builderhunt_worker` | command-specific policies added with each worker |
| Platform administration | `DATABASE_PLATFORM_URL` | `builderhunt_platform` | editorial, account directory, and billing administration only |
| Operational reporting | dedicated secret | `builderhunt_readonly` | reviewed views only, no tenant base tables |

All named runtime roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
NOBYPASSRLS`. Role migrations do not contain passwords. Provision and rotate credentials in the
deployment secret manager.

The auth broker exists because Better Auth must resolve sessions and memberships before a product
tenant transaction exists. It is intentionally unable to read `organization_builders`, notes,
queries, alerts, entitlements, AI artifacts, or any other product tenant data. Product code importing
`auth-db.ts` outside the two reviewed auth modules fails `pnpm security:boundaries`.

## Billing tables (stripe-billing-platform)

The 14 `billing_*` tables (`drizzle/0027_overconfident_angel.sql`, RLS/grants in
`drizzle/0028_billing_rls_grants.sql`) split further than the general rule above: **the browser-facing
`builderhunt_app` role never gets INSERT or UPDATE on financial state**, even inside its own tenant —
only `builderhunt_worker` can create or transition a Stripe customer, subscription, credit grant,
reservation, allocation, ledger entry, provider-usage record, or refund outcome, whether that write was
triggered by a webhook or synchronously by a user's own request. `builderhunt_app` gets:

- **SELECT only**: `billing_customers`, `billing_subscriptions`, `billing_credit_grants`,
  `billing_credit_reservations`, `billing_credit_allocations`, `billing_ledger_entries`,
  `billing_provider_usage`.
- **SELECT + INSERT + UPDATE**: `billing_checkout_attempts`, `billing_auto_recharge_rules` — both are
  owner-initiated requests/preferences the route layer already permission-checks, not financial
  outcomes.
- **SELECT + INSERT only**: `billing_refunds` (a `WITH CHECK` further restricts the insert to
  `state = 'pending' AND stripe_refund_id IS NULL` — the app role can submit a refund request, never a
  pre-decided outcome), `billing_terms_acceptances` (append-only consent record).
- **Nothing at all** on the three system-operational tables with no `organization_id`:
  `billing_webhook_events`, `billing_reconciliation_runs`, `billing_seller_profiles` — those are
  `builderhunt_worker`/`builderhunt_platform` only, matching the general rule that platform/webhook/
  reconciliation/configuration rows are never customer-visible.

`billing_ledger_entries` additionally never receives an UPDATE grant for ANY role — it is append-only;
compensating entries are inserted, never mutations of an existing row.

`test/security/billing-tenant-isolation.test.ts` statically asserts these invariants against the
migration file text (safe to run in every `pnpm vitest run`, no live database needed).
`scripts/db/verify-rls-local.mjs` (under `pnpm test:rls:local`) additionally proves the live-role
behavior: tenant A/B isolation, cross-tenant insert/update denial, a spoofed-organization checkout
attempt rejection, and platform-role denial of tenant billing data.

Before credential cutover, run the exact-role tests against a disposable database. Confirm
`current_user`, `rolsuper = false`, `rolbypassrls = false`, missing-context denial, tenant A/B rows,
cross-tenant insert/update denial, pool reuse, and auth-broker product denial. Never test RLS as the
owner and treat that as evidence.
