# Local development: authenticated browser sessions

How to reach an authenticated (and, where needed, platform-admin) page in a
real local browser — for manual verification, screenshots, or debugging a UI
issue — without granting the runtime app role any privilege it does not have
in production.

## Seed the local admin user

```bash
pnpm db:seed:admin
```

Reads `DEFAULT_ADMIN_EMAIL` / `DEFAULT_ADMIN_PASSWORD` from `.env` (falls back
to `edd_admin@local.com` / `Passw0rd!234`). Safe to re-run.

`auth_users` and `auth_accounts` are auth-broker-only tables — the runtime
`DATABASE_URL` (role `builderhunt_app`) has no grant on them by design, the
same boundary product code respects via `authDb`. `seed-admin.ts` therefore
connects through `DATABASE_AUTH_URL` (role `builderhunt_auth`), never through
the app role. This never widens what `builderhunt_app` can do.

## Make that user a platform admin (optional)

Platform admin is an env-allowlisted principal, not a database role or an
organization membership (see `src/shared/lib/auth/platform-admin.ts`). To let
the seeded admin reach `/admin/*` routes locally, add its `auth_users.id` to
`ADMIN_USER_IDS` in `.env`:

```bash
psql "$DATABASE_AUTH_URL" -tAc \
  "select id from auth_users where email = '${DEFAULT_ADMIN_EMAIL:-edd_admin@local.com}';"
# then in .env:
ADMIN_USER_IDS=<the id printed above>
```

Restart the dev server after changing `ADMIN_USER_IDS` — the allowlist is
read from `process.env` at request time by the running server process.

## Open an authenticated session

1. `pnpm dev` (or `pnpm dev:all` to also bring up Postgres/migrations/seed).
2. In a browser, visit `/auth/sign-in` and sign in with the seeded
   credentials.
3. `/dashboard` and (if allowlisted) `/admin/metrics` are reachable and the
   session survives a reload, same as any signed-in user.

Never print `DATABASE_URL`, `DATABASE_AUTH_URL`, or any seeded password to
logs, CI output, or a shared terminal — treat them the same as production
secrets even though they only ever point at the local Docker Postgres.

## Automated E2E platform-admin fixture

For test code (not manual browsing), use
`tests/e2e/harness/fixtures/platform-admin.ts`, which mints a disposable
platform-admin principal end to end — reserved id, `ADMIN_USER_IDS`
registration, real credential-account insert via the harness's privileged
connection, and a real sign-in through the app's own API. It never touches
the app role's own grants either.

## Dashboard baseline — 2026-08-07

Recorded by `scripts/audit/dashboard-baseline.ts` against the
platform-admin fixture on http://localhost:3010/dashboard.

| viewport | status | TTFB (ms) | DCL (ms) | load (ms) | CLS | requests | bytes | axe violations |
|---|---|---|---|---|---|---|---|---|


Screenshots: `docs/ui-audit/evidence/dashboard-baseline/<viewport>/*.png`.
JSON: `docs/ui-audit/evidence/dashboard-baseline/metrics-2026-08-07.json`.



## Dashboard baseline — 2026-08-07

Recorded by `scripts/audit/dashboard-baseline.ts` against the
platform-admin fixture on http://localhost:3010/dashboard.

| viewport | status | TTFB (ms) | DCL (ms) | load (ms) | CLS | requests | bytes | axe violations |
|---|---|---|---|---|---|---|---|---|
| desktop-1440 | 200 | 444 | 533 | 538 | 0.0000 | 708 | 27876638 | 2 |
| mobile-320 | 200 | 11 | 57 | 60 | 0.0000 | 639 | 16660310 | 0 |
| desktop-1440-zoom400 | 200 | 11 | 56 | 58 | 0.0000 | 640 | 16660310 | 0 |
| desktop-1440-reduce-motion | 200 | 11 | 57 | 59 | 0.0000 | 640 | 16660310 | 0 |
| desktop-1440-forced-colors | 200 | 11 | 58 | 60 | 0.0000 | 640 | 16660310 | 0 |

Screenshots: `docs/ui-audit/evidence/dashboard-baseline/<viewport>/*.png`.
JSON: `docs/ui-audit/evidence/dashboard-baseline/metrics-2026-08-07.json`.

**Budgets (provisional; tighten once Wave 2 lands the action queue).**

| metric | desktop | mobile | fail above |
|---|---|---|---|
| TTFB (cold) | < 200 ms | < 200 ms | > 400 ms |
| DCL | < 600 ms | < 600 ms | > 1000 ms |
| load | < 800 ms | < 800 ms | > 1500 ms |
| CLS | < 0.05 | < 0.05 | > 0.1 |
| requests | < 100 | < 100 | > 200 |
| bytes | < 5 MB | < 3 MB | > 10 MB |
| axe violations | 0 | 0 | any |

The current numbers are far over budget on `desktop-1440` because the dev
server does not warm its React/TanStack-Start module cache between cold
requests. `mobile-320` and the synthetic viewports hit the warm path
(11 ms TTFB) and pass everything except the byte budget, which is a
separate concern: the dashboard ships roughly 16 MB of JS + JSON on
every visit. Wave 4 charts (already shipped) and Wave 5 widgets
(make the figure worse) will need a code-split + bundle-size pass
before the byte budget is realistic.


