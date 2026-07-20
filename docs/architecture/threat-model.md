# Threat Model

## Scope and assets

The scope is BuilderHunt authentication, organization membership, tracked builders, notes, saved
queries, alerts, onboarding, entitlements, claims, exports/deletion, planned AI artifacts, and the
PostgreSQL deployment. Critical assets are tenant-private content, account credentials and tokens,
invitation/reset/claim secrets, billing entitlements, verified public claims, audit integrity, and
database owner credentials.

## Trust boundaries and entry points

Traffic crosses the browser/API boundary through TanStack Start routes and Better Auth endpoints.
Application code crosses the database boundary through a pooled non-owner role. Background jobs and
platform administration are separate identities. Provider APIs, email delivery, deployment secrets,
and future AI providers are external boundaries. Entry points include all API methods, cookies,
organization switches and invitations, imports/exports, provider URLs, workers, migrations, logs,
and support tooling.

## Attacker capabilities

- Anonymous callers can modify headers, bodies, IDs, origins, redirects, and request timing.
- A valid member can enumerate identifiers and race membership, invite, seat, export, and deletion
  operations, including while a session becomes stale.
- A compromised worker or application credential can issue arbitrary SQL allowed to its database
  role.
- External providers can return hostile text, URLs, HTML, oversized payloads, or misleading identity
  data.
- Operators can accidentally run migrations with runtime credentials, expose secrets in logs, or
  deploy schema and application versions in the wrong order.

## Primary threats and controls

| Threat | Control and evidence |
| --- | --- |
| IDOR/cross-tenant reads or writes | Server-derived tenant principal, repository boundary, composite tenant FKs, forced RLS, direct SQL and A/B API tests |
| Spoofed organization or role | Ignore client scope; re-read membership for every tenant entry |
| Pool context leakage | `set_config(..., true)` inside one transaction; commit, rollback, reuse, and concurrency tests |
| Privilege escalation | Central permission matrix; static roles; single owner; platform admin and worker separation |
| Invitation theft/enumeration/race | Verified matching email, expiry/revocation, generic responses, hashed/opaque IDs, rate limits, locked final-seat allocation |
| Public/private builder data mixing | Global identity, tenant association, verified claim, and published profile stored separately; allowlisted DTOs |
| Runtime schema takeover | Non-owner app/worker roles without superuser or `BYPASSRLS`; revoked public defaults; separate migration URL |
| Migration corruption or data loss | Immutable forward migrations, expand/backfill/contract, reconciliation, restore rehearsal, explicit approval for destructive phases |
| Secret/PII leakage | Typed environment, production secret checks, structured redaction, no invite/reset URLs or payloads in logs |
| CSRF/XSS/SSRF/open redirect | Origin validation, security headers, output escaping, URL allowlists, private-network denial |
| AI cache or budget collision | Organization key on cache/budget/artifacts; public-source-only global embeddings |
| Abuse/resource exhaustion | Distributed IP+user+organization+action rate limits, request limits, timeouts, quotas |

## Security invariants

- No private database operation executes without a validated active membership and transaction-local
  organization context.
- An absent tenant setting denies access; the web role never owns tables or bypasses RLS.
- Every tenant child relation preserves `organization_id` in its foreign key.
- Authorization attributes are normalized columns/relations, never mutable JSON.
- Public responses use explicit DTO allowlists.
- Production role changes, RLS activation, data conflict disposition, and destructive contract
  migrations require environment-owner approval and a verified restore point.

## Residual risk and review triggers

The legacy schema remains user-scoped until backfill and cutover, so compatibility code must be
treated as temporary high risk. Re-review this model when adding a new principal, provider, public
field, tenant table, worker command, export/deletion path, dynamic role, payment flow, or AI storage
surface, and after any authentication or PostgreSQL major-version change.

