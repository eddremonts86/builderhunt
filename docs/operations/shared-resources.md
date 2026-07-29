# Shared resources — operational runbook

> Plan: `phase-1/28-shared-resources`. Audience: on-call engineer.

## What this feature is

A second axis of sharing on top of the existing personal / team
boundary. The principal can:

- mark a saved search as `private` (default) or `organization`
- create a builder shortlist (`private` | `organization`)
- share a saved search's public RSS feed via a **capability** — a
  revocable, rotatable, optional-expiry public handle that does
  not expose the underlying saved-query id

## Tenant boundary

Everything the principal can see is a function of
`(principal.organizationId, principal.role, principal.userId)`
plus the row's `visibility` and `createdByUserId`. The
principal-scoped repositories in
`src/shared/lib/repositories/saved-queries.ts`,
`builder-lists.ts`, `organization-alerts.ts`, and
`public-feeds.ts` are the only places this is enforced. Routes
delegate; the UI never supplies an `organizationId` to any of
them.

Anti-enumeration: every "I cannot see this row" path returns
`not_found` (HTTP 404), never `forbidden` (403). A probe by id
cannot tell "exists but private" from "does not exist" or
"belongs to a different org".

## What you do NOT do

- ❌ Add a route that takes a `queryId` or `listId` and resolves
  it to a saved query without going through the principal-scoped
  repository. The raw id is tenant-internal; only the principal
  can dereference it.
- ❌ Add an `organizationId` parameter to any client-supplied body
  or query string. The active organization's id is the principal's
  `organizationId`, always. `stripOrganizationAuthority` at the
  route boundary drops every common tenant-key variant before
  zod sees the body.
- ❌ Expose a queryId, capability id, or organizationId in any
  public feed response. The feed URL is `/api/feeds/<capability>?token=...`
  and the response carries only builder-side data.

## Public feed capabilities

| URL | `/api/feeds/:capabilityId?token=...` |
| --- | --- |
| Path param | capability id (random 17-byte base64url, NOT a queryId) |
| Query param | `token` (random 32-byte base64url, secret) |
| DB | only `capability_hash` (SHA-256) is stored, never the token |
| Lookup | O(1) via the `capability_hash` UNIQUE index |
| Revocation | `revoked_at` set; future resolves return null (HTTP 404) |
| Expiry | `expires_at` checked at resolve time |
| Org deletion | cascades → capability row goes with it |
| Query deletion | cascades → capability row goes with it |

Every error path returns the same 404 — `unknown id`, `wrong
token`, `revoked`, `expired`, `query gone` — so a probe by id or
token cannot tell what was wrong.

## Migrations

| Tag | Adds |
| --- | --- |
| `0104_shared_resources_saved_query_visibility` | `saved_queries.visibility` + CHECK + index |
| `0105_builder_lists` | `builder_lists`, `builder_list_items` + composite FK to `organization_builders` |
| `0106_feed_capabilities` | `feed_capabilities` + UNIQUE on `capability_hash` + CASCADE on query/org |

Run on the production DB before code deploy:

```bash
pnpm db:migrate
```

## Tests that gate the feature

| File | Asserts |
| --- | --- |
| `tests/unit/security/shared-query-api.test.ts` | `/api/queries/:id/visibility` boundary |
| `tests/unit/security/builder-list-api.test.ts` | `/api/lists/*` boundary |
| `tests/unit/security/shared-alerts.test.ts` | `/api/alerts` from a shared query |
| `tests/unit/security/shared-resources-characterization.test.ts` | contract allowlist |
| `tests/unit/security/shared-resource-isolation.test.ts` | cross-tenant matrix |
| `tests/unit/shared/lib/repositories/saved-queries.test.ts` | repository unit |
| `tests/unit/shared/lib/repositories/builder-lists.test.ts` | repository unit |
| `tests/unit/shared/lib/repositories/public-feeds.test.ts` | capability unit |
| `tests/unit/shared/lib/repositories/alerts.test.ts` | alerts-from-query unit |

The release gate runs `pnpm test:security && pnpm test:rls &&
pnpm test:migrations:local && pnpm lint && pnpm type-check &&
pnpm test && pnpm build`. A failure on any of these blocks
deploy.

## Operational dashboards to add (future)

- Count of capabilities per organization (anomaly: an org with
  hundreds of capabilities probably has a leak).
- Count of revoked capabilities per day (sanity: revocation
  should be a small fraction of total).
- Latency of `resolveFeedCapability` (p99; should be sub-ms).
