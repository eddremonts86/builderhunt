# Browser Extension Overlay (spec)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../security-and-multitenancy/spec.md) (a new authenticated client outside the app's cookie/CSRF assumptions); [`ai-expansion`](../../ai-expansion/spec.md) (Chrome built-in AI is the local-first tier this surface sits closest to); [`ai-sourcing-sprints`](../../ai-sourcing-sprints/spec.md) (the "add to sprint" action target — already shipped). Binding: [`ai-policy`](../../_meta/ai-policy.md), [`security-policy`](../../_meta/security-policy.md).
> **Blocks**: nothing
> **Reality check**: `requireTenantPrincipal` resolves tenant scope *only* from a better-auth cookie session's `activeOrganizationId` (`src/shared/lib/auth/tenant-principal.ts`); `isTrustedMutationOrigin` in `server/security.mjs` — the single gate `server.prod.mjs` imports and applies before the app runs — hard-403s every cookie-bearing unsafe-method request whose `Origin` ≠ `APP_URL`, and that module deliberately emits no `Access-Control-Allow-*` header. `src/shared/lib/auth/cron.ts` is the only existing bearer-token principal. `findOrganizationBuilderBySource()` exists in `src/shared/lib/repositories/organization-builders.ts` but **no route exposes lookup by `(source, sourceId)`** — `/api/builders/$builderId` takes the internal identity id. `linkedin` is already `status: 'blocked'` and inside `HARD_BLOCKED_CONNECTOR_IDS` in `src/lib/enrichment/policies.ts`. `builderhunt_app` has **SELECT-only** on `sprint_results` (`drizzle/0024_sourcing_sprints_grants.sql:31,56`) — see §8.

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
| Dedicated extension bearer token | **Chosen.** |
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
`withTenantContext` and `can()` are unchanged downstream: (1) `EXTENSION_API_ENABLED !== 'true'` →
503; (2) parse the bearer header, malformed/absent → 401; (3) row by `id` via `authDb`, missing /
revoked / expired → 401; (4) `timingSafeEqual(sha256(secret), row.secretHash)` else 401;
(5) re-query `organization_members` via `authDb` (identical query to `requireTenantPrincipal`) — no
row or unknown role → revoke `'membership_lost'`, then the same two-argument call
`tenant-principal.ts` already makes, `emitSecurityAudit({ organizationId, actorUserId: userId,
action: 'extension.membership_check', targetType: 'organization', targetId: organizationId, result:
'denied', requestId }, consoleSecurityAuditSink)`, and 403; (6) throttled
`lastUsedAt`/`clientVersion` write (skip if < 5 min old); (7) return `{ userId, organizationId:
row.organizationId, role, requestId }`.

`scripts/check-route-coverage.mjs` gains `{ name: 'extension', pattern: /requireExtensionPrincipal/ }`;
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

**Can `/api/builders/track` be reused as-is? No**, for three verified reasons: it resolves
`requireTenantPrincipal` only; its `TrackBody` requires `profileUrl` (and validates it against the
declared source via `isAllowedBuilderProfileUrl`), which the extension has no honest way to supply
for a profile it may never have seen — every other display field is `.nullable().optional()`, so
sending them all as null would write an empty identity row; and it has no rate limit at all today.
`/api/extension/track` accepts `{ source, sourceId?, username }`,
resolves display fields server-side, then runs the same `getOrganizationEntitlement` →
`PLAN_LIMITS[...].savedBuilders` → `trackOrganizationBuilder` sequence under `withTenantContext`
and fires `upsertEmbeddingStubs` fire-and-forget exactly as `/api/builders/track` does. No existing
route is modified.

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
(verified: nothing in `drizzle/*.sql` grants it). So `lastObservedBand` is always populated and
labelled "last seen by BuilderHunt", while `activityBand` returns `'unknown'` in v1 with a task to
either add a narrow grant or record the deferral — never a fabricated number. Band cutoffs live in
one pure function matching `src/lib/score.ts`'s recency bands (1/7/30/90/365 days) so the overlay
and search scores cannot drift.

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
lockfile, deliberately NOT a pnpm workspace package** (`pnpm-workspace.yaml` declares no `packages:`
key today; adding one would change root install behavior). `extension/` goes in `.dockerignore`,
`eslint.config.js` ignores, and `tsconfig.json` excludes, so the app's install, `pnpm build`, and
Docker image are unaffected. One repo means the API change and the client change are reviewable in
one diff; separate build graphs mean the extension can never break the app deploy.

**MV3**: `background: { service_worker: 'sw.js', type: 'module' }`; `content_scripts` on
`https://github.com/*` at `document_idle`; `permissions: ['storage','alarms']`; no `tabs`,
`<all_urls>`, `webRequest`, or `scripting`. **No remote code** (MV3 forbids it) — everything is
bundled and the default MV3 CSP (`script-src 'self'`) is kept, so the build must emit no `eval`.

**Build**: `extension/vite.config.ts`, multi-entry (`sw`, `content`, `popup`), `format: 'es'`, no
cross-entry chunking. `pnpm --dir extension build && pnpm --dir extension pack` → `dist-<target>.zip`.
The URL parser is not duplicated: it lives in `src/shared/lib/extension/profile-ref.ts` (covered by
`pnpm test`) and the extension imports it through an `@app/*` alias, so client and server validate
the same shape.

**Release**: `extension/manifest.json`'s `version` is the extension's only version, independent of
the app's. `.github/workflows/extension-release.yml` on `ext-v*` tags builds, packs, and attaches
both zips to a GitHub release; store upload stays manual in v1 (the Chrome Web Store API needs
OAuth client credentials nobody has — named as a gap, not invented).

**Compatibility contract** (review latency is days): every request sends `X-BH-Extension-Version`
and `X-BH-API-Version: 1`; the server supports `N` and `N-1` for at least 180 days; **a v1 DTO field
is never removed or renamed, only added**, and the client ignores unknown fields; features are gated
by the response's `features` object rather than by client version, so the server can disable
`status` for everyone without a store release; `EXTENSION_MIN_VERSION` (default `0.0.0`) lets the
server return `410 { error: 'extension_version_unsupported', minVersion }`, rendered as "Update
BuilderHunt Connect".

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

Consequence for the header assertion: **no existing table, migration, or route is modified** — the
only new DDL in this plan is two new tables plus one additive index on `builder_identities` (§4).
The new `setOrganizationBuilderStatus()` helper is an additive function in an existing repository
file; no existing caller changes.

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
3. **Value**: `organization_builders` rows with `privateMetadata.origin === 'extension'` per day, one
   aggregate on `/api/admin/metrics`. Target ≥ 25% of new tracks from the extension within 60 days.
   (`privateMetadata.origin` is the key **this plan owns**; `privateMetadata.aiEnrichment` belongs to
   `ai-profile-enrichment`. `trackOrganizationBuilder` rewrites `privateMetadata` wholesale on
   conflict, so a later web-UI re-track drops `origin` — acceptable for a first-touch metric.)
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
- **Restricted subject** → `restricted: true`, every optional field nulled, all write buttons hidden.
- **Shortlist on an untracked builder** → 404. `Shortlist` only transitions an existing
  `organization_builders` row; the card shows Track first, and Track→Shortlist is two taps by design
  rather than a hidden implicit insert.
- **Profile found by a sprint the user cannot see** → impossible: the `sprint_results` read is
  org-scoped by `sprint_results_app_select`, so `sprintMatches` can only ever name sprints in the
  bound organization.
- **API disabled or server unreachable** → the overlay renders nothing at all (no error banner on
  someone else's website); the popup explains the state.
- **Breaking API change while an old extension is live** → prevented by the additive-only DTO rule
  and server-side `features` gating; `EXTENSION_MIN_VERSION` is the emergency stop.
