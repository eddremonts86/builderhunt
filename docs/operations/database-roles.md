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

## These roles are cluster-level, which breaks naive restores

Roles are **not** part of a `pg_dump` of a single database — they live in `pg_dumpall`. Because
every RLS policy in this project is bound `TO builderhunt_app` / `_auth` / `_worker` /
`_platform`, restoring a database dump into a cluster that lacks these roles fails every
`CREATE POLICY` statement in it while the `ENABLE ROW LEVEL SECURITY` flags restore fine —
leaving RLS forced on every tenant table with **zero policies**. That is fail-closed (a tenant
role sees no rows at all, verified), so it is an unusable database rather than a leak, but the
tempting incident-time "fix" of disabling RLS or granting `BYPASSRLS` would make it one.

`scripts/db/roles.sql` recreates these roles without passwords for exactly this case, and
`tests/unit/security/restore-roles-bootstrap.test.ts` fails if it drifts from the migrations above.
Procedure and drills: [`database-restore.md`](./database-restore.md).

The auth broker exists because Better Auth must resolve sessions and memberships before a product
tenant transaction exists. It is intentionally unable to read `organization_builders`, notes,
queries, alerts, entitlements, AI artifacts, or any other product tenant data. Product code importing
`auth-db.ts` outside the two reviewed auth modules fails `pnpm security:boundaries`.

## Role settings are not inherited through membership

`drizzle/0168_role_timeouts.sql` gives each role a `statement_timeout` and an
`idle_in_transaction_session_timeout` — 5s/10s for `app`, `auth` and `capability`, 30s/30s for `worker`,
15s/10s for `platform`. `builderhunt_readonly` is deliberately absent: it is the restore and inspection
identity, driven by a human at a psql prompt, and a bound there turns a legitimate long analytical query
into a mystery cancellation.

**`ALTER ROLE … SET` does not apply through role membership.** Table privileges and RLS policies do,
which is what makes the opposite assumption so plausible. PostgreSQL writes a `pg_db_role_setting` row
keyed on the role that *authenticates*, and it never consults that role's grantors.

This is not a footnote. Both test harnesses create per-database login roles that are members of the base
roles, and every one of them started with `statement_timeout = 0` while the migration and the verifier
both passed — so the E2E suite, the only place the application actually serves requests, served all of
them on unbounded connections. `create-disposable-test-database.ts` and `prepare-rls-fixture.mjs` now
copy the base role's catalog rows onto the member role, replayed from `pg_db_role_setting` rather than
restated, so the numbers stay in the migration.

Evidence: `pnpm run test:db-role-timeouts` connects as each real role and cancels a query one second past
its budget (SQLSTATE 57014); `tests/e2e/api/database-role-timeouts.spec.ts` does the same through the
harness's own URLs. A timeout that is set but not enforced looks identical to a correct one until
something hangs.

The settings survive a transaction pooler, which is not obvious either — PgBouncer may hand out a backend
opened earlier for a different client. `tests/e2e/api/pgbouncer-compatibility.spec.ts` asserts all five
through port 6432.

## Pooled connections and the tenant boundary

Under transaction pooling the tenant boundary rests on one boolean. `withTenantContext` sets its GUC with
`set_config(…, true)` — transaction-*local*. Were it session-scoped, the value would stay on the backend
after the transaction ended and the next client handed that backend would inherit another tenant's
context: a cross-tenant read that no application code is wrong about. That property is asserted directly
in `tests/e2e/api/pgbouncer-compatibility.spec.ts`.

Related: PgBouncer authenticates against a `userlist.txt` built from the five *base* roles, so the
per-database member roles the harnesses create cannot authenticate through it at all. A pooled test has
to use the base roles.

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

`tests/unit/security/billing-tenant-isolation.test.ts` statically asserts these invariants against the
migration file text (safe to run in every `pnpm vitest run`, no live database needed).
`scripts/db/verify-rls-local.mjs` (under `pnpm test:rls:local`) additionally proves the live-role
behavior: tenant A/B isolation, cross-tenant insert/update denial, a spoofed-organization checkout
attempt rejection, and platform-role denial of tenant billing data.

Before credential cutover, run the exact-role tests against a disposable database. Confirm
`current_user`, `rolsuper = false`, `rolbypassrls = false`, missing-context denial, tenant A/B rows,
cross-tenant insert/update denial, pool reuse, and auth-broker product denial. Never test RLS as the
owner and treat that as evidence.

## Abuse-and-usage-integrity tables (abuse-and-usage-integrity)

The 5 tables added for account/session/seat risk signals (`drizzle/0043_abuse_usage_integrity_tables.sql`,
RLS/grants in `drizzle/0044_abuse_usage_integrity_rls_grants.sql`) split access by who is trusted to
write the signal, not just by tenant:

- `user_devices` (account-subject, `user_id`) and `seat_usage_daily` (tenant-private,
  `organization_id`): `builderhunt_app` gets SELECT + INSERT + UPDATE — both are synchronous,
  request-path writes (a first-party device-cookie upsert, an own-org usage-counter increment),
  the same "owner-initiated request" category as `billing_checkout_attempts`.
  `builderhunt_worker` additionally gets SELECT + INSERT + UPDATE on `seat_usage_daily` for
  background rollups/enforcement checks, scoped by the same `organization_id` policy.
- `account_risk` (account-subject, `user_id`): `builderhunt_app` gets **no grant at all** — an
  account's risk score/enforcement stage is written exclusively by `builderhunt_worker`
  (background scoring) and read/overridden by `builderhunt_platform` (admin action), so a
  compromised or buggy app-role query can never fabricate a signal or downgrade its own risk stage.
  Both worker and platform stay `user_id`-scoped even for cross-user background sweeps — the same
  per-subject-batch discipline `sprints/worker.ts` applies per-organization.
- `session_signals`/`abuse_signals` (system-operational, no owning subject, no RLS possible):
  `builderhunt_app` gets nothing; `builderhunt_worker` gets SELECT + INSERT (signal ingestion);
  `builderhunt_platform` gets SELECT (investigation/dashboards). `abuse_signals` never receives an
  UPDATE grant for any role — it is append-only, matching `billing_ledger_entries`.

`scripts/db/verify-rls-local.mjs` proves the live-role behavior for all 5 tables: account-subject
and tenant-private isolation, cross-subject/cross-tenant insert/update denial, the app role's total
lack of access to `account_risk`/`session_signals`/`abuse_signals`, and worker/platform read-write
against the system-operational tables.

`scripts/db/verify-api-isolation-local.mjs` (`pnpm test:api-isolation:local`) additionally exercises
the abuse-console **route handlers** (`/api/admin/abuse`, `/api/admin/abuse/clusters`) and
`/api/me/sessions` under real tenant-A/tenant-B sessions: non-admin rejection, and confirming a
platform admin's manual action lands on the *targeted* user's `account_risk` row, never the admin's
own — this is the intentional cross-user shape of that feature, not a leak, so the assertions check
"lands on the right target" rather than "never touches another user."

`src/shared/lib/abuse/enforcement-kill-switch.test.ts` is the release-gate kill-switch smoke
(runs as part of the ordinary `pnpm test` step, no separate CI job needed): it seeds a real
`account_risk` row at `stage: 'blocked'` in a disposable database, mocks
`env.ABUSE_ENFORCEMENT_MODE` to `'observe'` with no `mode` override passed to
`resolveEnforcementForUser` (the exact way every real caller — `requireTenantPrincipal`'s
`getEnforcementStage` wiring — actually calls it), and confirms the decision is still `observe` for
that real, already-flagged account, and that the account-risk read never even happens (mirroring
`enforcement.test.ts`'s existing short-circuit assertion, but end-to-end against a real DB row
instead of a mocked function). A final sanity check flips the same mock back to `'enforce'` and
confirms the same row resolves to `blocked`, proving the fixture is real rather than a tautology.
