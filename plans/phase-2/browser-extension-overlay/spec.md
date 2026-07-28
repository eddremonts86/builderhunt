# Browser Extension Overlay (spec)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../phase-1/01-security-and-multitenancy/spec.md) (a new authenticated client outside the app's cookie/CSRF assumptions); [`ai-expansion`](../../phase-1/20-ai-expansion/spec.md) (Chrome built-in AI is the local-first tier this surface sits closest to); [`ai-sourcing-sprints`](../../phase-1/40-ai-sourcing-sprints/spec.md) (the "add to sprint" action target — already shipped). Binding: [`ai-policy`](../../_meta/ai-policy.md), [`security-policy`](../../_meta/security-policy.md).
> **Blocks**: nothing
> **Reality check** (re-verified against `master` HEAD, 2026-07-27): `requireTenantPrincipal` resolves tenant scope *only* from a better-auth cookie session's `activeOrganizationId` (`src/shared/lib/auth/tenant-principal.ts`), and now also refuses a principal whose `resolveEnforcementForUser()` stage is `'blocked'`. `isTrustedMutationOrigin` in `server/security.mjs` — the single gate `server.prod.mjs` imports (line 14) and applies before the app runs — hard-403s every cookie-bearing unsafe-method request whose `Origin` ≠ `APP_URL`, and that module deliberately emits no `Access-Control-Allow-*` header. **Two** non-session principals exist today, not one: `src/shared/lib/auth/cron.ts` (`Authorization: Bearer <CRON_SECRET>` → `PlatformAdminPrincipal`, the only *header-bearer* path) and the accountless scheduling capability (`src/lib/scheduling/capability.ts` + `capability-context.ts`, secret in a path-scoped HttpOnly cookie, resolved through the `scheduling_resolve_capability` SECURITY DEFINER function on the dedicated `builderhunt_capability` role, `drizzle/0077`–`0078`). §"The auth model" reconciles this plan's guard against both. `findOrganizationBuilderBySource()` exists in `src/shared/lib/repositories/organization-builders.ts:118` but its **only** caller is `/api/builders/track` — **no route exposes lookup by `(source, sourceId)`**; `/api/builders/$builderId` takes the internal identity id. `linkedin` is `status: 'blocked'` and inside `HARD_BLOCKED_CONNECTOR_IDS` in `src/lib/enrichment/policies.ts:28`. `builderhunt_app` has **SELECT-only** on `sprint_results` (`drizzle/0024_sourcing_sprints_grants.sql:31,56`) — see §8. `isSuppressed()` (`src/shared/lib/profile-suppression.ts`) is a mandatory filter on every identity-surfacing path and must be applied by this plan's read and write routes.

## Problem

Recruiters live on `github.com`. BuilderHunt's tracking, scoring, and sprint data live in another
tab, so every profile judged on GitHub is judged without the data BuilderHunt already holds, and
every builder worth keeping costs a context switch. The product has no distribution channel that
reaches the user where the work happens and no install-shaped acquisition loop.

## Goal

A Manifest V3 extension that, on a GitHub **user profile page**, injects a card with what
BuilderHunt already knows about that identity — last-observed recency, cross-source presence, this
organization's tracking state and score, and which of the org's sourcing sprints already surfaced
them — plus one-click **Track**, **Shortlist**, and **Add note** into the *correct* organization
(see §8 for why "add to sprint" is a read, not a write). Three hard properties shape everything
below:

1. **It never reads page content** — only `location.pathname`, on any host.
2. **It is never cookie-authenticated** — an org-scoped bearer token, so the app's single global
   CSRF gate is never touched.
3. **It is a dumb renderer** — every feature is gated by a field in a server response, because a
   store review takes days and an old client must keep working against a newer API.

## Non-goals

- **No LinkedIn** host permission at any version until a register decision says otherwise (§5);
  same for `x.com`, `facebook.com`, `instagram.com`. **No content extraction anywhere**, GitHub
  included — display fields come from the server.
- **No overlay on list pages** (search, followers, org members, contributors) — only
  `https://github.com/<login>` roots. A list page means ~30 lookups per pageview, the exact shape
  of a browsing-history harvest.
- **No AI** (§AI posture). No cookie/CORS model, no `externally_connectable`, no new
  `Access-Control-Allow-*` header, no relaxation of `server.prod.mjs`'s origin gate.
- No new billing tier, entitlement column, credit consumption, or queue system. No Safari build
  (needs an Apple developer account + Xcode).
- No shared org-wide builder *lists* — `shared-resources` is `blocked`; "add to list" maps to
  `organization_builders.status` (`tracked | shortlisted | archived`), which already exists.

## User stories

1. On `github.com/torvalds` I see "Tracked by Acme · shortlisted · last observed 3 days ago · also
   on GitLab".
2. On an unknown profile the card says "Not in BuilderHunt yet" with **Track**; clicking creates
   the identity and the tracking row in my organization.
3. Belonging to two organizations, the card header always names the bound one, and I cannot write
   to the other by accident.
4. As an owner I see every paired extension on `/settings/extension` with organization, last-used
   time, and **Revoke**; removing a member kills their extension at its next request.
5. On free tier the read overlay works fully and **Track** enforces the same 50-builder limit the
   web app enforces, returning the same 402 upgrade body.

## The auth model — RESOLVED

| Candidate | Verdict |
| --- | --- |
| Cookie + CORS from an allowlisted `chrome-extension://` origin | **Rejected.** `server.prod.mjs` 403s cookie-bearing POST/PATCH/DELETE with a foreign `Origin` *before the app runs*; allowing an extension origin punches a hole in the one global CSRF gate, needs `Access-Control-Allow-Origin` + `Allow-Credentials: true` echoed per extension id, and needs `Cross-Origin-Resource-Policy: same-origin` relaxed. Extension ids differ between store and unpacked builds, so the allowlist is a moving target. `security-policy.md` §Review ownership forbids weakening the policy locally without an ADR. |
| Reuse the scheduling capability principal (`withCapabilityContext`, `builderhunt_capability`, `drizzle/0077`–`0078`) | **Rejected, but it sets the pattern.** That principal is deliberately *accountless*: it resolves one invitation, carries no `userId` and no organization role, sets `app.organization_role = 'capability'`, and runs on a role whose 41 grants cover scheduling tables only — no `organization_builders`, no `builder_notes`, no `organizations`. The extension is the opposite case: a real member acting with their real role on the ordinary tenant surface. Widening `builderhunt_capability` to reach tracking and notes would destroy the property `0078`'s header comment exists to state ("an SQL injection in a public scheduling handler reaches this role's grants and stops"). What this plan *does* borrow: hash-at-rest with the raw secret never stored, one failure code for malformed/unknown/revoked, and a guard registered in `check-route-coverage.mjs`'s `guardPatterns` rather than allowlisted as public. |
| Dedicated extension bearer token resolving to the **existing** `TenantPrincipal` | **Chosen.** Consequence worth stating: this plan adds **no new database role and no new database connection**. `requireExtensionPrincipal` reads `extension_tokens` through the existing `authDb` (the same chicken-and-egg `requireTenantPrincipal` already solves for `organization_members`) and then hands an ordinary `TenantPrincipal` to the ordinary `withTenantContext` on `builderhunt_app`. Every downstream grant, policy and `can()` check is the one the web app already proved. |
| OAuth-like device pairing | **Chosen for the handshake, not the credential.** better-auth here is email/password only; no OAuth provider exists. We borrow RFC 8628's device-code shape so a token reaches the extension without a password ever being typed into it. |

**CSRF, structurally.** The MV3 service worker fetches with `credentials: 'omit'` and
`Authorization: Bearer bhx_<id>.<secret>`. No `Cookie` header is present, so the edge gate's
`hasCookie && unsafeMethod` branch passes untouched and stays exactly as strict for the web app. A
bearer token is never ambiently attached by the browser to a cross-site request, so the
confused-deputy vector `security-policy.md` requires proving does not exist here.

**Zero CORS surface.** Chrome and Firefox exempt requests initiated by an extension **service
worker** from CORS for hosts in `host_permissions` (content scripts lost that exemption in Chrome
85). All traffic goes content script → `runtime.sendMessage` → service worker → `fetch`. The server
never learns to trust `chrome-extension://`, no preflight handler is added, and the token stays out
of the `github.com` page context where a hostile page or another extension could read it.

**Active organization — RESOLVED.** A mis-scoped Track writes to the wrong tenant. **The token is
bound to exactly one organization at mint time, server-side.** There is no `X-BH-Organization`
header to spoof; `security-policy.md` rule 1 is satisfied by there being no client-supplied
organization ID at all. Binding comes from the session's `principal.organizationId` at approval
time, so the user picks the org with the existing `OrganizationSwitcher` first. Deliberate
consequence: the extension does **not** follow the web app's active-organization changes —
switching is an explicit re-pair, because a session switch made for an unrelated reason in another
tab must never silently redirect the extension's writes. Every response carries
`organization: { id, name }`, rendered in the card header. At most **one active token per
`(userId, organizationId)`** (partial unique index) and 5 per user; re-pairing rotates.

**Revocation.** (1) Self-serve on `/settings/extension`, also listed on `/settings/security`.
(2) `requireExtensionPrincipal` re-verifies membership and re-reads the role from
`organization_members` on **every** request (the role is never stored on the token) — a removed
member 403s and the token auto-revokes with `revoked_reason = 'membership_lost'`, closing the
"stale session after membership removal" and "concurrent role change" cases. (3) `ON DELETE
cascade` from `auth_users` and `organizations`. (4) `EXTENSION_API_ENABLED=false` → all routes 503.
(5) Fixed 90-day expiry (`EXTENSION_TOKEN_TTL_DAYS`), not sliding; a 401 renders "Reconnect".

## Architecture

### 1. Schema — two new tables

```ts
// src/shared/lib/db/schema.ts
// ACCOUNT SUBJECT (owner `user_id`); `organization_id` is a server-set scope column, never a
// selector. Grants go to `builderhunt_auth` ONLY, like `auth_sessions` after 0007_auth_broker.sql:
// the token must resolve BEFORE tenant context exists — the same chicken-and-egg
// `requireTenantPrincipal` already solves by reading `organization_members` through `authDb`.
export const extensionTokens = pgTable('extension_tokens', {
  id: text('id').primaryKey(),                       // public lookup id, carried in the token
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  organizationId: text('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  secretHash: text('secret_hash').notNull(),         // sha256 hex; the raw secret is never stored
  label: text('label').notNull().default('Browser extension'),
  clientVersion: text('client_version'),             // last seen X-BH-Extension-Version
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),             // 'user'|'membership_lost'|'rotated'|'org_deleted'
}, (t) => [
  uniqueIndex('extension_tokens_active_user_org_unique')
    .on(t.userId, t.organizationId).where(sql`${t.revokedAt} is null`),
  index('extension_tokens_user_idx').on(t.userId, t.createdAt),
])

// SYSTEM OPERATIONAL: a pending pairing has no owner yet (created by an unauthenticated
// extension), so it cannot be account-subject. Auth-role grants only; rows are short-lived.
export const extensionPairings = pgTable('extension_pairings', {
  id: text('id').primaryKey(),
  codeHash: text('code_hash').notNull(),             // sha256 of the 8-char user-visible code
  pollTokenHash: text('poll_token_hash').notNull(),
  verifierHash: text('verifier_hash').notNull(),     // extension-generated; never leaves the client
  status: text('status').notNull().default('pending'),
  approvedUserId: text('approved_user_id').references(() => authUsers.id, { onDelete: 'cascade' }),
  approvedOrganizationId: text('approved_organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
  issuedTokenId: text('issued_token_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),  // +5 min
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('extension_pairings_code_hash_unique').on(t.codeHash),
  index('extension_pairings_expires_idx').on(t.expiresAt),
  check('extension_pairings_status_check', sql`${t.status} in ('pending','approved','claimed','expired','denied')`),
])
```

Token string: `bhx_<id>.<base64url(32 random bytes)>`. Verification reuses `cron.ts`'s exact shape
— sha256 both sides, then `timingSafeEqual`, so length never leaks through timing.

### 2. `requireExtensionPrincipal(request): Promise<TenantPrincipal>`

`src/shared/lib/auth/extension-principal.ts`, returning the **same** `TenantPrincipal` type so
`withTenantContext` and `can()` are unchanged downstream:

1. `EXTENSION_API_ENABLED !== 'true'` → 503.
2. Parse the bearer header; malformed/absent → 401. Strict regex `^Bearer bhx_([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$`
   — the prefix check matters because `cron.ts`'s `presentedToken()` reads the *same* header on the
   run-worker routes, and neither parser may accept the other's credential.
3. Row by `id` via `authDb`; missing / revoked / expired → 401.
4. `timingSafeEqual(sha256(secret), row.secretHash)` else 401.
5. Re-query `organization_members` via `authDb` (the identical query `requireTenantPrincipal` makes)
   — no row or unknown role → revoke `'membership_lost'`, then the same two-argument call
   `tenant-principal.ts` already makes, `emitSecurityAudit({ organizationId, actorUserId: userId,
   action: 'extension.membership_check', targetType: 'organization', targetId: organizationId,
   result: 'denied', requestId }, consoleSecurityAuditSink)`, and 403. (`extension.membership_check`
   is unclaimed: `tenant.membership_check` in `tenant-principal.ts:115` is the only audit action of
   this shape today.)
6. **`resolveEnforcementForUser(userId)` → stage `'blocked'` = 403.** This step did not exist when
   the plan was first written; `requireTenantPrincipal` gained it with `abuse-and-usage-integrity`
   Phase 5. Omitting it would make a 90-day bearer token the one credential in the app that survives
   an account block, which is precisely the hole the enforcement stage exists to close.
7. Throttled `lastUsedAt`/`clientVersion` write (skip if < 5 min old).
8. Return `{ userId, organizationId: row.organizationId, role, requestId }`.

`scripts/check-route-coverage.mjs` gains `{ name: 'extension', pattern: /requireExtensionPrincipal/ }`
alongside the existing `scheduling-capability` entry — the established way this repo records "authenticated,
just not by a user session". (`withTenantContext` already satisfies that checker on its own, so the
pattern is documentation of intent, not the only thing keeping the route off the public allowlist.)
`scripts/check-tenant-boundaries.mjs`'s `authDbAllowlist` gains the two new files.

### 3. API surface

All new routes under `src/routes/api/extension/`, so the guard boundary is one directory. Authed
ids use `getAuthedRateLimitId({ userId, organizationId })` — network-agnostic, so IP rotation
cannot reset a bucket.

| Route | Guard | `rateLimit(scope, id, limit, windowS)` |
| --- | --- | --- |
| `POST /pair/start` | public (allowlisted) | `extension-pair-start`, `getRateLimitId(request)`, 10, 600 |
| `POST /pair/approve` | `requireTenantPrincipal` | `extension-pair-approve`, authed, 10, 3600 |
| `POST /pair/claim` | pairing secret (allowlisted) | `extension-pair-claim`, pairingId, 60, 300 |
| `GET /session` | `requireExtensionPrincipal` | `extension-session`, authed, 60, 60 |
| `GET /profile` | `requireExtensionPrincipal` | `extension-lookup`, authed, 120, 60 |
| `POST /track` | `requireExtensionPrincipal` | `extension-track`, authed, 60, 3600 |
| `POST /status` | `requireExtensionPrincipal` | `extension-status`, authed, 60, 3600 |
| `POST /note` | `requireExtensionPrincipal` | `extension-note`, authed, 60, 3600 |
| `GET\|DELETE /api/extension/tokens` | `requireTenantPrincipal` | `extension-tokens`, authed, 30, 60 |

Every row guarded by `requireExtensionPrincipal` also passes through `withExtensionVersionGate`
(§6) before the handler body: `resolveApiVersion` → 400, then `isBelowMinimumVersion` → 410. All
`extension-*` rate-limit scopes are unclaimed at HEAD (the 24 scopes in use today are listed by
`grep -rho "rateLimit(\s*'[a-z0-9-]*'" src/`).

**Can `/api/builders/track` be reused as-is? No**, for three verified reasons: it resolves
`requireTenantPrincipal` only; its `TrackBody` requires `profileUrl` **and** `sourceId` (and
validates the URL against the declared source via `isAllowedBuilderProfileUrl`), which the extension
has no honest way to supply for a profile it may never have seen — every other display field is
`.nullable().optional()`, so sending them all as null would write an empty identity row; and it has
no rate limit at all today. `/api/extension/track` accepts `{ source, sourceId?, username }`,
resolves display fields server-side, then runs the **same sequence** `/api/builders/track` runs:
`isSuppressed(source, sourceId)` before the transaction (`track.ts:51-53`), then inside
`withTenantContext` the `Promise.all` of `getOrganizationEntitlement` + `countOrganizationBuilders`
+ `findOrganizationBuilderBySource`, the
`PLAN_LIMITS[resolveLegacyPlanTier(entitlement.tier)].savedBuilders` gate, and
`trackOrganizationBuilder` — then fires `upsertEmbeddingStubs` fire-and-forget outside the
transaction, exactly as it does. No existing route is modified.

`isSuppressed` is **not optional and was missing from the first draft of this plan**: its own header
comment names "`/api/builders/track`, public `GET /api/builders/$builderId`, recent/recommendation
endpoints, exports, feeds, and alert workers" as the surfaces that must filter through it, and a new
identity-surfacing read is exactly that class. `GET /api/extension/profile` therefore returns
`known: false` (never a 404 that distinguishes "suppressed" from "unknown") for a suppressed
`(source, sourceId)`, and `POST /api/extension/track` returns the same 404 the web route returns.

### 4. Lookup contract and DTO

GitHub URLs expose the **login**, not the numeric id (`sources/github.ts` sets `sourceId:
String(user.id)`), so username is the primary key; `sourceId` is accepted for sources whose URLs
carry it.

```ts
// src/shared/lib/extension/profile-dto.ts — .strict(), explicit allowlist, no ORM rows
export const extensionProfileDto = z.object({
  apiVersion: z.literal(1),
  organization: z.object({ id: z.string(), name: z.string() }),
  known: z.boolean(),                 // a builder_identities row exists
  identityId: z.string().nullable(),  // sha256(`${source}\0${sourceId}`) — deterministic
  source: z.enum(SOURCE_NAMES),
  username: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  profileUrl: z.string(),
  followersCount: z.number().int().nullable(),
  lastObservedBand: z.enum(['today','week','month','quarter','year','stale','unknown']),
  activityBand: z.enum(['today','week','month','quarter','year','stale','unknown']),
  crossSource: z.array(z.object({
    source: z.enum(SOURCE_NAMES), username: z.string(), profileUrl: z.string(),
    confidence: z.literal('username-match'),
  })).max(8),
  tracked: z.object({
    status: z.enum(['tracked','shortlisted','archived']),
    score: z.number().int().nullable(),   // organization_builders.privateMetadata.score
    trackedAt: z.string(), noteCount: z.number().int(),
  }).nullable(),
  // Read-only: sprints in THIS organization whose worker already surfaced this profile.
  // builderhunt_app has SELECT + `sprint_results_app_select` on sprint_results, and nothing more.
  // Only ever populated when `known` is true — see "Sprint matches" below.
  sprintMatches: z.array(z.object({ sprintId: z.string(), name: z.string() })).max(3),
  claimed: z.boolean(),
  restricted: z.boolean(),               // builder_processing_restrictions → notice only
  features: z.object({ track: z.boolean(), status: z.boolean(), note: z.boolean() }),
}).strict()
```

**Never a cross-tenant signal**: no "N other organizations track this person", no aggregate that
varies with another tenant's data. `tracked` reflects only the bound organization; everything else
comes from `builder_identities`, `global-public` in `docs/architecture/data-classification.md`.

**Honest recency.** `builder_identities.lastSeenAt` is when *BuilderHunt* last observed the
identity, not when the person last shipped. The real activity timestamp lives in
`builder_source_snapshots.payload.lastSeen`, and that table has **no grant to any runtime role**
(re-verified at HEAD: `grep -n builder_source_snapshots drizzle/*.sql | grep -i grant` is empty, and
it still has no runtime writer). So `lastObservedBand` is always populated and labelled "last seen by
BuilderHunt", while `activityBand` returns `'unknown'` in v1 — never a fabricated number.

**Cross-plan dependency, both directions.** [`match-evidence-panel`](../match-evidence-panel/spec.md)
sits earlier in the build order and touches both halves of this: it adds `explainScore()` inside
`src/lib/score.ts` and reimplements `scoreBuilders` on top of it, and its Phase-4 task
"Grant `builder_source_snapshots` to the runtime role" adds
`GRANT SELECT, INSERT, DELETE ON TABLE builder_source_snapshots TO builderhunt_app` plus a real
writer. **Consequence for this plan: land `match-evidence-panel` first.** If it has landed,
`recency.ts` imports the band cutoffs from wherever that refactor left them rather than restating
them, and `activityBand` becomes implementable from `payload->>'lastSeen'` — Phase 6's "decide
`activityBand`" task then chooses branch (b) instead of branch (a). If it has not landed, this plan
still ships: `recency.ts` restates the 1/7/30/90/365 cutoffs with a comment pointing at
`src/lib/score.ts:42-46`, and `activityBand` stays `'unknown'`. Either way the decision is made
against the tree, not assumed.

**Cross-source presence** is `builder_identities WHERE lower(username) = lower($1) AND source <> $2`,
labelled `confidence: 'username-match'` and rendered "same username elsewhere — not
identity-verified". This reuses the exact username-equality convention `src/lib/dedup.ts` already
applies; real identity linking is `code-fingerprinting`'s job. **The existing
`builder_identities_source_username_idx` cannot serve this query** — it is `on (source, username)`,
so a predicate with no `source` equality and a `lower()` wrapper gets a sequential scan, and no
functional index exists anywhere in `drizzle/` (`grep -rn "lower(" drizzle/*.sql` is empty). This
plan therefore adds one single-column functional index,
`CREATE INDEX builder_identities_lower_username_idx ON builder_identities (lower(username));`, as
its own `--custom` migration. Usernames are near-unique, so that is one index scan returning a
handful of rows which the `source <> $2` filter then trims — which is what keeps the per-pageview
cost claim below honest. Because `builder_identities` may be large in production, the migration task
also records the operator alternative (`CREATE INDEX CONCURRENTLY` run out-of-band before deploy,
the same shape as `semantic-search`'s Coolify pgvector step) and requires `EXPLAIN ANALYZE` evidence
of an index scan before Phase 3 is considered done.

**Sprint matches — the query shape is load-bearing.** `sprint_results` has exactly two indexes
(`schema.ts:874-877`): `sprint_results_sprint_source_unique` on `(sprint_id, source, source_id)` and
`sprint_results_sprint_created_idx` on `(sprint_id, created_at)`. **Neither can serve a predicate
whose leading column is `organization_id` or `source`**, so the naive
`WHERE organization_id = $1 AND source = $2 AND source_id = $3` is a sequential scan on the largest
tenant table in the sprints feature — on every profile pageview, which would silently void the
per-pageview cost claim above. The query is therefore written as a join that leads with the
organization's sprints, so the planner can nested-loop into the existing unique index:

```sql
SELECT sr.sprint_id, s.name
FROM sourcing_sprints s
JOIN sprint_results sr
  ON sr.sprint_id = s.id AND sr.organization_id = s.organization_id
WHERE s.organization_id = $1 AND sr.source = $2 AND sr.source_id = $3
ORDER BY sr.created_at DESC
LIMIT 3
```

`sourcing_sprints_org_status_last_run_idx` narrows the outer side to this organization's sprints
(≤ 10 at every tier — `SOURCING_SPRINT_LIMITS.team` is 10), and each inner probe is an equality hit
on `sprint_results_sprint_source_unique`. That is ≤ 10 index lookups and **needs no new index**,
which is why the "only one additive index" claim in §8 survives. Phase 3 requires `EXPLAIN ANALYZE`
evidence of an Index Scan here, and if the planner picks a Seq Scan anyway the fallback is
`CREATE INDEX sprint_results_org_source_idx ON sprint_results (organization_id, source, source_id);`
in the same `--custom` migration — decide it with the plan output, not in advance.

Honest limitation, stated because the card copy depends on it: `sprint_results` keys on
`(source, source_id)` and the sprints worker (`src/lib/sprints/worker.ts`) writes **no
`builder_identities` row**, so a profile a sprint surfaced but nobody tracked has no numeric
`source_id` this plan can resolve from a GitHub login. `sprintMatches` is therefore populated only
when `known` is true. Resolving it for an unknown profile would need a functional index on
`sprint_results.profile->>'username'` — a second index on an existing table, deliberately deferred
rather than smuggled in.

**Unknown profile**: `known: false`, `tracked: null`, `crossSource: []`, `sprintMatches: []`, both
bands `'unknown'`, `features.track: true`. **No external call happens on lookup** — one indexed Postgres read, which is
what makes per-pageview cost acceptable. The only outbound call in this plan is a single
`GET https://api.github.com/users/{login}` on an explicit **Track**, host-checked against the
already-approved `github` policy in `src/lib/enrichment/policies.ts` and capped at its declared 20
req/min.

**Caching**: `Cache-Control: private, max-age=300` + an ETag over the DTO hash. The service worker
keeps an LRU in `storage.session` (in-memory, cleared on browser restart, so browsing history never
hits disk) keyed `${source}:${username}:${orgId}`, TTL 5 min, 200 entries. No batching in v1 — one
profile page, one lookup.

### 5. LinkedIn — RESOLVED: `blocked`

`src/lib/enrichment/policies.ts` already lists `linkedin` as `blocked` and inside
`HARD_BLOCKED_CONNECTOR_IDS`, citing <https://www.linkedin.com/legal/crawling-terms>. **A content
script reading a LinkedIn profile page is the same act by another transport**, and the register
exists precisely to stop that policy arbitrage. hiQ v. LinkedIn narrowed CFAA exposure, not
contract/ToS exposure, which is where the liability actually sits.

Decision: **v1 declares `host_permissions: ["https://github.com/*", "<APP_ORIGIN>/*"]` and nothing
else.** LinkedIn is recorded `blocked` in a new `docs/operations/extension-host-register.md`
following the enrichment register field for field (acquisition mode, status, permission reference,
lawful basis, approved fields, allowed hosts, review date, expiry, kill-switch owner), enforced
compile-time by `extension/src/shared/host-policies.ts` with
`HARD_BLOCKED_HOSTS = ['linkedin.com','x.com','facebook.com','instagram.com']` — the same four ids
`policies.ts` blocks. Because the extension reads no page content on *any* host, the strictest
fallback position ("URL only, no extraction") is already the universal rule, so unblocking LinkedIn
later would be a manifest + register change, not an architecture change.

**Chrome Web Store review risk**: a `https://*.linkedin.com/*` host permission triggers the
broad-host-permission justification requirement plus limited-use/prominent-disclosure obligations,
and LinkedIn-overlay extensions are an active enforcement and reporting target. Including it risks
rejection or takedown of the whole listing — taking the working GitHub feature with it. One named
`github.com` host with the single-purpose description "show BuilderHunt data about the GitHub
profile you are viewing" is the version a reviewer accepts. Future hosts go through
`optional_host_permissions` (a runtime user grant), never a new mandatory listing permission.
`activeTab` was rejected: it grants access only after a click on the extension action, so the
overlay would never appear automatically — that is the entire product.

### 6. Packaging, versioning, compatibility

**Location**: a new top-level `extension/` directory in this repo with **its own `package.json` and
lockfile, deliberately NOT a pnpm workspace package** (`pnpm-workspace.yaml` exists but declares no
`packages:` key — only `allowBuilds`, `overrides` and `onlyBuiltDependencies`; adding `packages:`
would change root install behavior). Because that file still marks the repo root as a workspace root,
every `extension/`-scoped pnpm command must pass **`--ignore-workspace`**
(`pnpm --dir extension --ignore-workspace install`), or pnpm resolves against the root store instead
of `extension/pnpm-lock.yaml`. `extension` goes in `.dockerignore` and `eslint.config.js`'s `ignores`
array. **No `tsconfig.json` change is needed** — its `include` is already `["src/**/*", "*.ts"]`, so
`extension/` is outside the app's program by construction; adding an `exclude` entry would be a no-op
that later readers mistake for load-bearing. One repo means the API change and the client change are
reviewable in one diff; separate build graphs mean the extension can never break the app deploy.

**MV3**: `background: { service_worker: 'sw.js', type: 'module' }`; `content_scripts` on
`https://github.com/*` at `document_idle`; `permissions: ['storage','alarms']`; no `tabs`,
`<all_urls>`, `webRequest`, or `scripting`. **No remote code** (MV3 forbids it) — everything is
bundled and the default MV3 CSP (`script-src 'self'`) is kept, so the build must emit no `eval`.

**Build**: `extension/vite.config.ts`, multi-entry (`sw`, `content`, `popup`), `format: 'es'`, no
cross-entry chunking. `pnpm --dir extension --ignore-workspace build && pnpm --dir extension --ignore-workspace pack`
→ `dist-<target>.zip`.
The URL parser is not duplicated: it lives in `src/shared/lib/extension/profile-ref.ts` (covered by
`pnpm test`) and the extension imports it through an `@app/*` alias, so client and server validate
the same shape.

**Release**: `extension/manifest.json`'s `version` is the extension's only version, independent of
the app's. `.github/workflows/extension-release.yml` on `ext-v*` tags builds, packs, and attaches
both zips to a GitHub release; store upload stays manual in v1 (the Chrome Web Store API needs
OAuth client credentials nobody has — named as a gap, not invented).

**Compatibility contract.** This is the part of the plan that matters most, because it is the only
one a later deploy can break unilaterally: a store review takes days, an install lives for months,
and an extension in the wild outlives every server deploy it will ever talk to. The contract is
therefore written as rules the server must obey, not as advice to the client.

*Wire shape.* Every request carries exactly two version headers:

```
X-BH-API-Version: 1                  # integer, the DTO contract the client speaks
X-BH-Extension-Version: 0.1.0        # semver, from runtime.getManifest().version
```

`X-BH-API-Version` is the negotiated contract; `X-BH-Extension-Version` is telemetry plus the
`EXTENSION_MIN_VERSION` kill switch input. They are separate on purpose — an extension release that
changes only UI must not look like a contract change.

*The five rules.* Pinned in `src/shared/lib/extension/api-version.ts` as constants with a unit test,
not left as prose:

1. **Additive-only within a major.** A field present in a shipped `apiVersion: 1` DTO is never
   removed, renamed, or narrowed (no enum member deleted, no `nullable` made non-nullable, no `max()`
   lowered). New fields are added optional. `extensionProfileDto` is `.strict()` on the *server's*
   output only; the **client must not** `.strict()`-parse, so an unknown field is ignored, never an
   error.
2. **`SUPPORTED_API_VERSIONS = [1]` and it never shrinks by less than 180 days.** When `2` ships, `1`
   stays served for ≥ 180 days from the day `2` reaches the store, and the removal date is written
   into `docs/operations/extension-host-register.md` on the day `2` ships — not decided later. An
   unsupported `X-BH-API-Version` gets `400 { error: 'api_version_unsupported', supported: [...] }`.
   A **missing** header is treated as `1` forever, because pre-header builds may exist.
3. **Capability is a server field, never a client version check.** The client renders a button iff
   `features.<name>` is true in the response it just received. The server can therefore disable
   `status` for every installed copy in one deploy, and can enable a *new* action for old clients
   only by shipping the client first — old clients simply ignore a `features` key they do not know.
4. **`EXTENSION_MIN_VERSION` is the emergency stop, not the routine one.** Default `0.0.0` (nothing
   blocked). When set, any request whose `X-BH-Extension-Version` sorts below it gets
   `410 { error: 'extension_version_unsupported', minVersion }`. It exists for a security fix in a
   shipped client; using it for a routine contract change is a bug, because rule 2 already covers
   that case without breaking anyone.
5. **A stale extension degrades to silence, never to noise, on someone else's website.** Defined
   behaviour per status, and this is the whole reason the overlay can be trusted to sit on
   `github.com`:

   | Server says | Extension does |
   | --- | --- |
   | `200` with unknown extra fields | renders what it understands, ignores the rest |
   | `400 api_version_unsupported` | renders nothing on the page; popup says "Update BuilderHunt Connect" |
   | `410 extension_version_unsupported` | same as above, plus stops polling until the version changes |
   | `401` | clears the token, renders nothing; popup says "Reconnect" |
   | `402` | card keeps rendering; the failed action opens `<APP_ORIGIN>/pricing` |
   | `429` / `503` / network error / timeout | renders nothing, retries no sooner than the next navigation |
   | `200` with a field the client requires but the server dropped | **cannot happen** — rule 1 |

   "Renders nothing" means no card, no banner, no console noise. A broken BuilderHunt must be
   invisible on a third party's page.

The one thing the server is genuinely allowed to do unilaterally is turn features off: `features`
(rule 3) and `EXTENSION_API_ENABLED` (which 503s everything) are the two levers that need no store
release. Everything else waits out review.

### 7. Cross-browser posture

`ai-policy.md` forbids Chrome-only *features* — its subject is an app feature degrading when Chrome
built-in AI is absent, not the distribution channel a client ships through. This plan satisfies it
on its own terms: **the app gains no Chrome-only behavior at all** (every server surface is
browser-agnostic) and the extension uses **zero Chrome built-in AI**. The code targets the
WebExtensions surface via `const api = globalThis.browser ?? globalThis.chrome` and avoids the three
real Chromium lock-ins: `externally_connectable` (replaced by the pairing-code flow),
`declarativeNetRequest` (unused), and hard dependence on `storage.session` (in-memory `Map` fallback
for Firefox < 115). `extension/manifest.firefox.json` differs only in `background.scripts` vs
`service_worker` and `browser_specific_settings.gecko.id`, and CI builds it from Phase 4 onward.
**v1 submits to the Chrome Web Store only; AMO submission is Phase 6** — sequencing, not a
capability gap.

### 8. "Add to sprint" — RESOLVED: a read, not a write

The obvious implementation — insert a `sprint_results` row with `matchedVariant: 'manual:extension'`
— **cannot work and should not be made to work.** `withTenantContext` runs on `runtimeDb` =
`builderhunt_app` (`src/shared/lib/db/tenant-context.ts`), and
`drizzle/0024_sourcing_sprints_grants.sql` grants that role only `SELECT` on `sprint_results` (line
56) with `sprint_results_app_select` as its only policy (line 31); `INSERT` belongs to
`builderhunt_worker` (line 58). This is exactly the failure class `app-reality.md` constraint 7
describes — and `0024`'s own header comment records that this table's grants were fixed *because*
the sprints feature had been silently broken against the real roles.

Three options were considered:

1. **Grant `builderhunt_app` INSERT + a `sprint_results_app_insert` policy.** Rejected on two
   grounds. It deliberately inverts `0024`'s split, where the app role can read what the worker
   found but can never fabricate a result — a property worth more than this convenience. And it
   would be semantically wrong regardless: `sourcing_sprints.quota` drives `clipToQuota` and the
   `quotaHit → completed` transition in `src/lib/sprints/worker.ts`, so manual rows would push a
   sprint to `completed` on a count that never came from its query variants. That is a behavioral
   bug, not just a permission one.
2. **Drop the action entirely.** Rejected: it discards the one place the extension can show a
   recruiter that their own sprint already found this person.
3. **Chosen: make the sprint relationship read-only and give the card a write action the app role
   already owns.** The DTO gains `sprintMatches` (up to 3, from a `SELECT` on `sprint_results`
   joined to `sourcing_sprints.name`, both org-scoped and both grant-legal today), and the write
   button becomes **Shortlist** — `organization_builders.status = 'shortlisted'`, whose value is
   already constrained by `organization_builders_status_check` and whose app-role
   SELECT/INSERT/UPDATE/DELETE policies and grants already exist from `drizzle/0008_tenant_rls.sql`.
   This is also the mapping the Non-goals section already committed to for "add to list", so the
   product surface is unchanged in substance.

Re-verified at HEAD 2026-07-27: `drizzle/0024_sourcing_sprints_grants.sql` still reads
`CREATE POLICY sprint_results_app_select` at line 31, `GRANT SELECT ON TABLE sprint_results TO
builderhunt_app;` at line 56 and `GRANT SELECT, INSERT ... TO builderhunt_worker;` at line 58; the
only two migrations mentioning `sprint_results` are `0015` (create) and `0024` (grants), so nothing
has widened them in the 61 migrations since. `clipToQuota` and the `quotaHit || exhausted →
completed` transition are still at `src/lib/sprints/worker.ts:86,101-103`. The chosen resolution
stands unchanged.

Consequence for the header assertion: **no existing table, migration, or route is modified** — the
only new DDL in this plan is two new tables plus one additive index on `builder_identities` (§4).
The `sprintMatches` read needs **no** new index because of the join shape in §4.
`organization_builders.status` is constrained by `organization_builders_status_check`
(`drizzle/0005_builder_normalization.sql:53`, `schema.ts:196`) to exactly
`('tracked','shortlisted','archived')`, and `builderhunt_app` holds
`organization_builders_app_update` plus `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
organization_builders` from `drizzle/0008_tenant_rls.sql` (policy loop at :55-88, grant at :111) —
both re-verified. The new `setOrganizationBuilderStatus()` helper is an additive function in an
existing repository file; no existing caller changes.

One inherited constraint the Note action rides on, recorded so nobody rediscovers it: `builder_notes`
is grant-legal for `builderhunt_app` (`0008_tenant_rls.sql:111`), but `builder_notes.builder_id`
still FKs to the **legacy `builders`** table via the composite
`builder_notes_organization_builder_fk`, and `organizationBuilders.id == builders.id` only because
`trackOrganizationBuilder` generates them together and dual-writes. `findOrganizationBuilderBySource`
returns exactly that shared id, so the note write is correct — but it is correct by inheritance from
the dual-write, not independently, and it will need revisiting with the rest of the app when
`security-and-multitenancy`'s legacy-schema contraction lands.

### AI posture

**No AI task is registered.** The idea's "fits the local-first AI policy" argument is about
*placement* — an extension is where on-device AI naturally lives — not a new model call. The overlay
renders deterministic data BuilderHunt already stores. Calling `LanguageModel` from a content script
would consume `github.com`'s origin quota and create exactly the Chromium-only dependency the policy
warns about; the MV3 service worker has no `LanguageModel` at all. If a summary is ever wanted, the
extension calls the existing `/api/ai/complete` with its bearer token and inherits `ai-expansion`'s
budgets untouched — a Phase 6 idea, not built. **Cost model: no AI spend, no embedding spend.**

## UX integration

- **Overlay** (`extension/src/content.ts`): a card injected into `.Layout-sidebar` (body-appended
  fallback) inside a closed Shadow DOM so GitHub's CSS cannot leak either way. Header = organization
  name; body = tracked status + score chip, last-observed band, cross-source chips, and
  "Found by sprint *{name}*" for each `sprintMatches` entry; footer = Track / Shortlist / Note.
  Collapsed to a pill until hovered, dismissible per-profile, replaced by "This builder has
  restricted processing" when `restricted: true`.
- **Popup**: bound organization, connection state, re-pair, link to `/settings/extension`.
- **App**: new `/settings/extension` (`src/routes/_dashboard/settings/extension.tsx`) with install
  link, pairing-code field, consent checkbox, and revocable token list; a `UserMenu.tsx` entry; the
  same token list on `/settings/security` beside `ActiveSessionsPanel`.

## Privacy

**Sent**: `source`, the username parsed from `location.pathname`, the bearer token, the two version
headers. Nothing else — never page HTML, DOM text, referrer, tab list, or the URL of a non-matching
page. **Logged**: `log.info('extension_lookup', { requestId, organizationId, source, known,
cacheHit })` — the username/`sourceId` is **not logged**, because that datum *is* the browsing
history and `security-policy.md` limits logs to redacted organization/request correlation;
rate-limit keys are `userId:organizationId`, never the profile. **Persisted by a lookup**: nothing —
only an explicit Track / Note / Sprint-add writes, and those write rows the web app already writes.
**Stored in the browser**: the token in `storage.local` (must survive restarts), the LRU in
`storage.session` (memory only). Honest limitation: `storage.local` is readable by anyone with
filesystem access to the browser profile — which is why the token is org-scoped, 90-day-expiring,
individually revocable, and membership-checked on every request rather than a session-cookie
equivalent.

**Disclosure**: a new consent document `extension` at `v1.0`, added to `CURRENT_VERSIONS` in **both**
`src/shared/lib/legal.ts` and `src/routes/api/consent/index.ts` (they duplicate the constant today)
plus the `ConsentBody` enum, backed by a new `/legal/extension` page. **The pairing approve endpoint
412s without that consent** — an enforceable disclosure point that avoids a major `privacy` version
bump, which `isMaterialVersionChange` would turn into forced re-acceptance for every existing user.
Store single-purpose and limited-use text lives in `extension/STORE_LISTING.md` and must match
`/legal/extension`.

## Tier/billing gating

The **read overlay is available on every tier including free** — gating the read kills the
acquisition loop that justifies the feature. Writes inherit the existing gates with no new
constants: **Track** hits `PLAN_LIMITS[tier].savedBuilders` (free 50) and returns the same 402 body
`/api/builders/track` returns; **Shortlist** and **Note** operate on an already-tracked builder, so
that same limit is the only gate they need. `sprintMatches` is naturally empty on free tier because
`SOURCING_SPRINT_LIMITS.free` is 0, so no separate gate is required for it either. Tier comes from
`getOrganizationEntitlement`
+ `resolveLegacyPlanTier`, so **nothing here depends on Stripe**: with `STRIPE_BILLING_ENABLED=false`
the feature works exactly as specified against the existing manual/legacy entitlement system.
`PLAN_PRICING.free.features` gains one bullet ("Browser extension — GitHub overlay") whose
enforceable gate is the existing `savedBuilders` limit.

## Success metrics (no browsing history)

1. **Pair conversion**: daily `extension_pairings` counts by status (`started`→`approved`→`claimed`).
   Install counts come from the store dashboard, which is not our data.
2. **Activation**: an organization is extension-active if any `extension_tokens.lastUsedAt` is within
   7 days — one timestamp per token, no profile identifiers.
3. **Value** — **written, but deliberately not aggregated on `/api/admin/metrics` in v1.**
   `POST /api/extension/track` stamps `privateMetadata.origin = 'extension'` (the key **this plan
   owns**; `privateMetadata.aiEnrichment` belongs to `ai-profile-enrichment`; note
   `trackOrganizationBuilder` rewrites `privateMetadata` wholesale on conflict, so a later web-UI
   re-track drops `origin` — acceptable for a first-touch metric). Reading it back platform-wide is
   what does not work: `organization_builders` has RLS **forced** with policies only for
   `builderhunt_app` (`0008_tenant_rls.sql`) and a worker SELECT (`0018_enrichment_worker_target_access.sql:6,11`).
   `builderhunt_platform` has **no grant and no policy** on that table, so a `platformDb` count
   returns `permission denied` — and if it were granted without a policy it would silently return
   zero rows, which is worse. The codebase already says this out loud:
   `src/routes/api/admin/metrics/index.ts` hardcodes `totalSavedQueries: null, totalBuilders: null,
   totalNotes: null` for exactly this reason. Granting the platform role a cross-tenant read of
   tenant tracking data for a growth metric is a security-policy §10 widening that needs an ADR, not
   a metrics task. So v1 ships metrics 1, 2 and 4 (all auth-role or in-process) and records this one
   as deferred with the target — ≥ 25% of new tracks from the extension within 60 days — measured
   by hand against the database until a legitimate platform read path exists.
4. **Cost**: lookups per active user per day (target p95 ≤ 60) and 0 external calls per lookup.

## Resolved edge cases

- **Profile never seen** → `known: false`, no external fetch, "Not in BuilderHunt yet · Track".
  Track is what creates `builder_identities`.
- **Org / repo / list URL** → the parser returns `null`, no request. Only `^/[A-Za-z0-9-]+/?$` minus
  GitHub's reserved paths triggers a lookup.
- **User renamed on GitHub** → username lookup misses (`known: false`); the numeric `sourceId` path
  still resolves and the next Track refreshes `username` via `trackOrganizationBuilder`'s existing
  `onConflictDoUpdate`.
- **Token used after leaving the organization** → 403 + auto-revoke at first request. **After the
  organization was deleted** → FK cascade already removed the row → 401.
- **Wrong organization bound** → the header names it on every render; the write cannot be mis-scoped
  because the org is not a request parameter.
- **Pairing code brute force** → 8 chars from a 32-symbol alphabet (~40 bits), 5-minute expiry,
  single use, hashed at rest, per-IP start limit, per-pairing claim limit, and claiming also requires
  the extension-held `verifier`.
- **Restricted subject** (`builder_processing_restrictions`, via `findActiveBuilderProcessingRestriction`)
  → `restricted: true`, every optional field nulled, all write buttons hidden.
- **Globally suppressed subject** (`isSuppressed(source, sourceId)` — a verified profile-removal
  request) → indistinguishable from never-seen: `known: false`, and Track 404s. Deliberately *not*
  the `restricted` path, which announces itself; a removal request must not be leakable by asking
  the API about a login.
- **Sprint surfaced them but nobody tracked them** → `sprintMatches: []`, because the worker writes
  no `builder_identities` row and the numeric `source_id` a `sprint_results` lookup needs cannot be
  derived from a GitHub login (§4). The card is silent about sprints rather than wrong about them.
- **User account blocked by `abuse-and-usage-integrity` enforcement** → 403 at
  `requireExtensionPrincipal` step 6; the token is left intact (a block is reversible, unlike losing
  membership), and the popup shows the generic "Reconnect" state.
- **Shortlist on an untracked builder** → 404. `Shortlist` only transitions an existing
  `organization_builders` row; the card shows Track first, and Track→Shortlist is two taps by design
  rather than a hidden implicit insert.
- **Profile found by a sprint the user cannot see** → impossible: the `sprint_results` read is
  org-scoped by `sprint_results_app_select`, so `sprintMatches` can only ever name sprints in the
  bound organization.
- **API disabled or server unreachable** → the overlay renders nothing at all (no error banner on
  someone else's website); the popup explains the state.
- **Breaking API change while an old extension is live** → prevented by the five rules in
  §6 "Compatibility contract"; the per-status degradation table there is the normative answer for
  what a stale client does in every case.
