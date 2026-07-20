# Database Roles

BuilderHunt uses separate credentials. Never inject more than the role required by a process.

| Process | Environment | Role | Access |
| --- | --- | --- | --- |
| Web/product repositories | `DATABASE_URL` | `builderhunt_app` | RLS-scoped product tables only |
| Better Auth adapter | `DATABASE_AUTH_URL` | `builderhunt_auth` | auth and organization lifecycle tables only |
| Migration/backfill job | `DATABASE_MIGRATION_URL` | deployment owner | DDL and approved backfills; never web runtime |
| Background worker | `DATABASE_WORKER_URL` | `builderhunt_worker` | command-specific policies added with each worker |
| Operational reporting | dedicated secret | `builderhunt_readonly` | reviewed views only, no tenant base tables |

All named runtime roles are `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION
NOBYPASSRLS`. Role migrations do not contain passwords. Provision and rotate credentials in the
deployment secret manager.

The auth broker exists because Better Auth must resolve sessions and memberships before a product
tenant transaction exists. It is intentionally unable to read `organization_builders`, notes,
queries, alerts, entitlements, AI artifacts, or any other product tenant data. Product code importing
`auth-db.ts` outside the two reviewed auth modules fails `pnpm security:boundaries`.

Before credential cutover, run the exact-role tests against a disposable database. Confirm
`current_user`, `rolsuper = false`, `rolbypassrls = false`, missing-context denial, tenant A/B rows,
cross-tenant insert/update denial, pool reuse, and auth-broker product denial. Never test RLS as the
owner and treat that as evidence.

