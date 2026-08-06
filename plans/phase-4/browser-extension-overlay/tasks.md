# Browser Extension Overlay (tasks)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../phase-1/01-security-and-multitenancy/spec.md) (a new authenticated client outside the app's cookie/CSRF assumptions); [`ai-expansion`](../../phase-1/21-ai-expansion/spec.md) (Chrome built-in AI is the local-first tier this surface sits closest to); [`ai-sourcing-sprints`](../../phase-1/41-ai-sourcing-sprints/spec.md) (the "add to sprint" action target — already shipped). Binding: [`ai-policy`](../../_meta/ai-policy.md), [`security-policy`](../../_meta/security-policy.md).
> **Blocks**: nothing
> **Reality check** (re-verified against `master` HEAD, 2026-07-27): Extends `src/shared/lib/db/schema.ts`, `src/shared/lib/env.ts`, `src/shared/lib/legal.ts`, `src/routes/api/consent/index.ts`, `scripts/check-route-coverage.mjs`, `scripts/check-tenant-boundaries.mjs`, `scripts/db/verify-api-isolation-local.mjs`, `src/modules/dashboard/components/UserMenu.tsx`. New credential guard modelled on `src/shared/lib/auth/cron.ts` and reconciled against the second existing non-session principal, `src/lib/scheduling/capability-context.ts` (spec §"The auth model"); new RLS/grants migration modelled on `drizzle/0044_abuse_usage_integrity_rls_grants.sql`. No existing route is modified and no existing table gains, loses, or alters a column, a grant, or a policy — the only DDL against an existing table is the additive `builder_identities_lower_username_idx`. Writes stay inside tables `builderhunt_app` already has grants and policies for: `sprint_results` is SELECT-only for that role (`drizzle/0024_sourcing_sprints_grants.sql:31,56`), so the sprint relationship is read-only and the write action is `organization_builders.status` — spec §8.

Ordered so the app ships cleanly after every checkbox.

**Before Phase 3**, land [`match-evidence-panel`](../match-evidence-panel/spec.md): it refactors
`src/lib/score.ts` and grants `builder_source_snapshots` to `builderhunt_app`, which decides the
shape of `recency.ts` and the `activityBand` branch in Phase 6.

**Migration numbering.** No task below hardcodes a migration index. `drizzle/meta/_journal.json`
had 86 entries at the time of writing and moves every week. Every migration task mints its file with
`pnpm db:generate` or `pnpm exec drizzle-kit generate --custom --name <name>`, which allocates the
next index and writes the journal entry and snapshot together. A hand-created `.sql` is never
applied by `drizzle-kit migrate` and fails `pnpm test:migration-integrity`.

**Test layout.** `vitest.config.ts` includes **only** `tests/unit/**/*.{test,spec}.{ts,tsx}`. There
are zero co-located tests under `src/`. Every unit test below lives at the `tests/unit/**` path that
mirrors its subject; e2e specs live in `tests/e2e/`. `pnpm test -- <path>` filters, and the path
must be under `tests/`.

## Phase 0 — Host policy register + legal disclosure surface

- [ ] **Write the extension host register**
  - Files: `docs/operations/extension-host-register.md` (new)
  - Do: Mirror `docs/operations/public-enrichment-source-register.md` field for field. Entries:
    `github` = `enabled`, mode `url_only`, approved fields "username parsed from
    `location.pathname`; nothing else"; `linkedin`/`x`/`facebook`/`instagram` = `blocked` reusing
    the exact permission references `src/lib/enrichment/policies.ts` cites. Add the "Chrome Web
    Store review risk" paragraph from `spec.md` §5.
  - Verify: `grep -n "^## " docs/operations/extension-host-register.md` lists exactly five hosts
    (`github`, `linkedin`, `x`, `facebook`, `instagram`), matching
    `['linkedin','x','facebook','instagram']` at `src/lib/enrichment/policies.ts:28` plus the one
    enabled host; the `linkedin` entry has no approval date and no lawful basis (mirroring the
    existing `## linkedin` section of `docs/operations/public-enrichment-source-register.md`, which
    records "Lawful basis: none — blocked"). Phase 4's `assertHostAllowed` test re-checks this
    register against code; at this phase the check is the grep.

- [ ] **Add the `extension` consent document**
  - Files: `src/shared/lib/legal.ts`, `src/routes/api/consent/index.ts`
  - Do: Add `extension: 'v1.0'` to `CURRENT_VERSIONS` in **both** files. The constant really is
    duplicated *and already divergent* — `src/shared/lib/legal.ts:24` says `privacy: 'v1.1'` while
    `src/routes/api/consent/index.ts:9` still says `'v1.0'`. Add `extension` to both anyway and do
    **not** touch `privacy` in either (fixing that drift is `abuse-and-usage-integrity`'s
    loose end, not this plan's, and a major bump would force every existing user to re-accept via
    `isMaterialVersionChange`). Add `'extension'` to `ConsentBody`'s `z.enum` at
    `src/routes/api/consent/index.ts:14`.
  - Verify: `pnpm test -- tests/unit/shared/lib/legal.test.ts`; `curl localhost:3000/api/consent`
    lists `extension` under `required` and under `needsAcceptance` for a user who has not accepted.

- [ ] **Publish the `/legal/extension` disclosure page**
  - Files: `src/routes/_landing/legal/extension.tsx` (new)
  - Do: Follow `src/routes/_landing/legal/privacy.tsx`'s structure. State exactly: what is sent
    (source + username from the URL, the token, two version headers), that no page content is ever
    read on any site, that lookups persist nothing, that the username is not logged, that the token
    is org-scoped and revocable, and that GitHub is the only supported host.
  - Verify: `pnpm dev` and open `/legal/extension` — renders in light and dark theme and is linked
    from `/legal/privacy`; `pnpm type-check` (the route must appear in `src/routeTree.gen.ts`).

- [ ] **Classify the two new tables and the new guard**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: `extension_tokens` = `account-subject`, owner `user_id`, public fields none, retention
    "90-day TTL + revocation audit window"; `extension_pairings` = `system-operational`, retention
    "5-minute expiry + short sweep window". Both go in the existing `| Table | Class | Canonical
    owner | Public fields | Retention / transition |` table in
    `docs/architecture/data-classification.md`. Add a `requireExtensionPrincipal` entry to
    `docs/architecture/authorization-matrix.md`'s `## Principals` list — it currently names
    `anonymous`/`member`/`admin`/`owner`/`platform-admin`/`worker` and mentions neither the
    scheduling capability nor a bearer credential. Write it as: "`extension`: an organization member
    acting through a paired browser extension; authenticated by an org-bound bearer token, never by
    a session cookie; the organization comes from the token row and is never a request field; the
    role is re-read from `organization_members` on every request and the token self-revokes on
    membership loss. Resolves to the same `TenantPrincipal` as `member`/`admin`/`owner` and gains no
    authority beyond the role it re-reads."
  - Verify: `grep -n "extension_tokens\|extension_pairings" docs/architecture/data-classification.md`
    returns exactly two rows; `grep -n "requireExtensionPrincipal" docs/architecture/authorization-matrix.md`
    returns one; no mixed-class row introduced.

## Phase 1 — Credential schema, RLS/grants, and `requireExtensionPrincipal`

- [ ] **Add `extension_tokens` and `extension_pairings` to the schema**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Both tables exactly as in `spec.md` §Architecture 1. Use the array-returning table-extras
    form `(table) => [ ... ]` that `builderIdentities`/`organizationBuilders` already use
    (`schema.ts:158,193`), not the older object form. The partial unique index is
    `uniqueIndex('extension_tokens_active_user_org_unique').on(t.userId, t.organizationId).where(sql\`${t.revokedAt} is null\`)`
    — same shape as `builder_claims_active_identity_unique` (`schema.ts:283`). Include
    `extension_pairings_status_check`.
  - Verify: `pnpm type-check`; `pnpm db:audit-schema` reports no unclassified table.

- [ ] **Generate the table migration**
  - Files: `drizzle/<next>_extension_credentials.sql` (new, generated — drizzle-kit picks the index;
    **do not** hardcode one, read `drizzle/meta/_journal.json` if you need to know it),
    `drizzle/meta/<next>_snapshot.json`, `drizzle/meta/_journal.json`,
    `drizzle/migration-hashes.json`
  - Do: `pnpm db:generate`, which writes the SQL, appends the `_journal.json` entry, and emits the
    snapshot. Then regenerate the hash manifest (`node scripts/db/verify-migration-integrity.mjs
    --write`, the `--write` branch is at `verify-migration-integrity.mjs:28`) and commit all three —
    the checker hard-fails unless the SQL set exactly equals the journal tags and every tag has a
    snapshot. Do not hand-edit the generated DDL: RLS/grants go in a separate migration, this repo's
    established split (`0043` vs `0044`).
  - Verify: `pnpm exec drizzle-kit check`; `pnpm test:migration-integrity` prints `valid: true`.

- [ ] **Write the RLS + grants migration**
  - Files: `drizzle/<next>_extension_credentials_rls_grants.sql` (new), `drizzle/meta/*`,
    `drizzle/migration-hashes.json`
  - Do: Mint the file with `pnpm exec drizzle-kit generate --custom --name
    extension_credentials_rls_grants` so it lands in `_journal.json` with a matching snapshot — a
    hand-created `.sql` is never applied by `drizzle-kit migrate` and fails
    `verify-migration-integrity`. Then write the body: model on
    `drizzle/0044_abuse_usage_integrity_rls_grants.sql`, header comment naming the data classes,
    `ENABLE`/`FORCE ROW LEVEL SECURITY` on both tables, plus
    `CREATE POLICY extension_tokens_auth_all ON extension_tokens FOR ALL TO builderhunt_auth USING
    (true) WITH CHECK (true);` — the exact `organizations_auth_broker_all` shape at
    `drizzle/0008_tenant_rls.sql:31` — and the same for pairings. Then `REVOKE ALL ... FROM PUBLIC;`
    and `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE extension_tokens, extension_pairings TO
    builderhunt_auth;`. **No grant to any other role.** Name all four explicitly in the header
    comment so a later reader knows the omission was deliberate: `builderhunt_app`,
    `builderhunt_worker`, `builderhunt_platform`, and `builderhunt_capability` (the newest role,
    `drizzle/0078_capability_role.sql`, whose whole point is a minimal scheduling-only reach) get
    nothing — mirroring `auth_sessions` after `drizzle/0007_auth_broker.sql`. Regenerate
    `drizzle/migration-hashes.json` with `--write` and commit it.
  - Verify: `pnpm test:migration-integrity`; `pnpm test:migrations:local`; `pnpm test:rls:local`.

- [ ] **Prove the runtime roles cannot touch the credential tables**
  - Files: `scripts/db/verify-rls-local.mjs`
  - Do: Add negative checks in the existing style (the script asserts `error?.code === '42501'` — see
    `:284`, `:292` for the closest precedent, the app role denied on `session_signals`/`abuse_signals`):
    a direct `SELECT` on `extension_tokens` and on `extension_pairings` must fail with `42501` as
    `builderhunt_app`, as `builderhunt_worker`, **and as `builderhunt_capability`** (six negatives,
    not four — the capability role exists now and must be covered like the rest).
  - Verify: `pnpm test:rls:local` shows six new passing negatives.

- [ ] **Pure token mint/parse/verify helpers**
  - Files: `src/shared/lib/auth/extension-token.ts` (new),
    `tests/unit/shared/lib/auth/extension-token.test.ts` (new)
  - Do: `mintExtensionToken()` → `{ id, secret, token, secretHash }` with
    `token = \`bhx_${id}.${base64url(randomBytes(32))}\``; `parseExtensionToken(header)` matching
    **exactly** `/^Bearer bhx_([A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{43})$/` (43 chars is base64url of
    32 bytes unpadded, the same length check `src/lib/scheduling/capability.ts`'s strict mode uses)
    or `null`; `extensionSecretMatches(secret, hash)` using `createHash('sha256')` +
    `timingSafeEqual`, exactly as `src/shared/lib/auth/cron.ts:34-38`'s `secretsMatch`;
    `mintPairingCode()` → 8 chars from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`.
  - Verify: `pnpm test -- tests/unit/shared/lib/auth/extension-token.test.ts` — malformed headers
    (`Bearer`, `bhx_`, no dot, two dots, wrong prefix), a wrong-length secret, **a raw `CRON_SECRET`-
    shaped bearer value returning `null`** (the two parsers read the same header on different routes
    and neither may accept the other's credential), and a mint→verify round trip.

- [ ] **Extension-token repository over `authDb`**
  - Files: `src/shared/lib/repositories/extension-tokens.ts` (new),
    `tests/unit/shared/lib/repositories/extension-tokens.test.ts` (new)
  - Do: `findExtensionTokenById`, `insertExtensionToken`, `touchExtensionToken` (only when
    `lastUsedAt` is null or > 5 min old), `revokeExtensionToken(id, reason)`,
    `listExtensionTokensForUser` (DTO: id, organizationId, label, clientVersion, createdAt,
    expiresAt, lastUsedAt — **never** `secretHash`), `countActiveExtensionTokens`, plus pairing CRUD
    (`insertPairing`, `findPairingByCodeHash`, `findPairingById`, `approvePairing`,
    `markPairingClaimed`, `deleteExpiredPairings`). Import `authDb` from `~/shared/lib/db/auth-db`,
    never the global `db` — and import it **statically**, so
    `check-tenant-boundaries.mjs`'s `/from\s+['"][^'"]*auth-db['"]/` test sees it and the
    allowlist entry below is doing real work rather than decorating a dynamic import it never
    matched.
  - Verify: `pnpm type-check`; `pnpm test -- tests/unit/shared/lib/repositories/extension-tokens.test.ts`;
    `pnpm security:boundaries` after the allowlist task below.

- [ ] **Implement `requireExtensionPrincipal`**
  - Files: `src/shared/lib/auth/extension-principal.ts` (new),
    `tests/unit/shared/lib/auth/extension-principal.test.ts` (new)
  - Do: Steps 1–8 of `spec.md` §Architecture 2, returning the `TenantPrincipal` type from
    `~/shared/lib/authorization/permissions` and throwing `TenantAuthorizationError` from
    `~/shared/lib/auth/tenant-principal`. Split into a pure `resolveExtensionPrincipal(request,
    dependencies)` with injected `{ findToken, findMembership, revoke, touch, getEnforcementStage,
    now }` — the same split `resolveTenantPrincipal`/`requireTenantPrincipal` already use
    (`tenant-principal.ts:12-27`), and `getEnforcementStage` is deliberately the same optional
    dependency name so the two guards stay comparable side by side. On membership loss call
    `emitSecurityAudit({ organizationId, actorUserId: userId, action: 'extension.membership_check',
    targetType: 'organization', targetId: organizationId, result: 'denied', requestId },
    consoleSecurityAuditSink)` — the two-argument form, matching `tenant-principal.ts:114-122` — and
    revoke with `'membership_lost'`. Do **not** call `checkCrossTenantDenialAndEmit`: that clusters
    session-borne cross-tenant probing, and a token that cannot name an organization at all cannot
    produce that signal.
  - Verify: `pnpm test -- tests/unit/shared/lib/auth/extension-principal.test.ts` — no header (401),
    malformed (401), unknown id (401), wrong secret (401), revoked (401), expired (401), membership
    removed (403 **and** `revoke` called with `'membership_lost'`), enforcement stage `'blocked'`
    (403 **and** `revoke` NOT called — a block is reversible), role changed since mint (principal
    carries the current role), `EXTENSION_API_ENABLED=false` (503).

- [ ] **Register the new guard and authDb consumers with the boundary scripts**
  - Files: `scripts/check-route-coverage.mjs`, `scripts/check-tenant-boundaries.mjs`
  - Do: Add `{ name: 'extension', pattern: /requireExtensionPrincipal/ }` to `guardPatterns`
    (`scripts/check-route-coverage.mjs:33-45`), directly under the existing `scheduling-capability`
    entry and with a comment in the same voice — these routes are authenticated, just not by a user
    session, so allowlisting them as public would be the wrong model. Add
    `src/shared/lib/auth/extension-principal.ts` and
    `src/shared/lib/repositories/extension-tokens.ts` to `authDbAllowlist`
    (`scripts/check-tenant-boundaries.mjs:8-24`) with the rationale "token/pairing resolution happens
    before tenant context exists — same exception shape as `tenant-principal.ts`'s membership read".
  - Verify: `pnpm security:boundaries && pnpm security:route-coverage`. Sanity check that the
    allowlist entries are load-bearing: temporarily remove one and confirm
    `pnpm security:boundaries` fails with "auth broker import is not allowlisted".

- [ ] **Add the four env vars**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: All four names are unclaimed at HEAD (`grep -n EXTENSION src/shared/lib/env.ts .env.example`
    is empty). `EXTENSION_API_ENABLED: z.enum(['true','false']).default('false')`,
    `EXTENSION_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(90)`,
    `EXTENSION_MIN_VERSION: z.string().default('0.0.0')`,
    `VITE_EXTENSION_STORE_URL: z.string().optional()`. Names only in `.env.example`, never values.
    Default-off, like `ENRICHMENT_ENABLED`.
  - Verify: `pnpm type-check`; `pnpm test -- tests/unit/shared/lib/env.security.test.ts`; the app
    boots with none set and `/api/extension/*` (Phase 2+) 503s.

## Phase 2 — Pairing flow + `/settings/extension`

- [ ] **`POST /api/extension/pair/start`**
  - Files: `src/routes/api/extension/pair/start.ts` (new), `scripts/check-route-coverage.mjs`
  - Do: Public. Body `{ verifierHash }` (64-hex). Rate limit `('extension-pair-start',
    getRateLimitId(request), 10, 600)`. Insert a `pending` pairing with `expiresAt: now + 5 min`, a
    fresh code and poll token (both stored hashed). Return
    `{ code, pollToken, expiresAt, pollIntervalMs: 5000 }` — no user or organization data. Add a
    `publicAllowlist` entry (it is a `Map` keyed by the repo-root-relative path, not a Set):
    `['src/routes/api/extension/pair/start.ts', 'creates only an unclaimed pairing row and returns
    no user data; the code+verifier pair is the credential, the same "gated by a capability token
    rather than a session" shape as src/routes/api/feeds/$searchId.ts']`.
  - Verify: `curl -X POST … -d '{"verifierHash":"<64hex>"}'` returns a code; the 11th call in 10
    minutes returns 429; `pnpm security:route-coverage` passes and its JSON output shows
    `publicAllowlisted` incremented by one.

- [ ] **`POST /api/extension/pair/approve`**
  - Files: `src/routes/api/extension/pair/approve.ts` (new)
  - Do: `requireTenantPrincipal`; rate limit `('extension-pair-approve', getAuthedRateLimitId(…), 10,
    3600)`. Body `{ code }` only — **no organizationId field**; the bound org is
    `principal.organizationId`. Require `extension` `v1.0` consent else
    `412 { error: 'consent_required', document: 'extension', version: 'v1.0' }`. Find the pairing by
    `sha256(code)`; reject non-`pending`/expired with a generic 400 (no existence distinction). Mint
    the token, revoke any active token for the same `(userId, organizationId)` as `'rotated'`,
    enforce the 5-token-per-user cap, insert, set the pairing `approved` with `issuedTokenId`. Return
    `{ organization: { id, name } }` — never the token.
  - Verify: `pnpm test:api-isolation:local` — approval binds to the approver's active organization
    only; no consent → 412; approving twice → 400.

- [ ] **`POST /api/extension/pair/claim`**
  - Files: `src/routes/api/extension/pair/claim.ts` (new), `scripts/check-route-coverage.mjs`
  - Do: Public + pairing-secret gated. Body `{ pollToken, verifier }`; rate limit
    `('extension-pair-claim', pairingId, 60, 300)`. Verify both hashes with `timingSafeEqual`.
    `pending` → `202 { status: 'pending' }`; expired → 410; `approved` → mark `claimed` **in the same
    transaction** and return the token string exactly once plus `{ organization, expiresAt }`;
    `claimed` → 409. Add a `publicAllowlist` `Map` entry for
    `src/routes/api/extension/pair/claim.ts` with the same reason as `start.ts`.
  - Verify: claim before approve → 202; claim twice → 409 with no token in the second body; a wrong
    `verifier` → 400 and both paths hash before comparing (no timing difference).

- [ ] **`GET|DELETE /api/extension/tokens`**
  - Files: `src/routes/api/extension/tokens.ts` (new)
  - Do: `requireTenantPrincipal`; rate limit `('extension-tokens', getAuthedRateLimitId({ userId,
    organizationId }), 30, 60)`. GET returns `listExtensionTokensForUser(principal.userId)`
    (account-subject data, scoped by `userId`). **Resolve the organization names with
    `listMyOrganizations(principal.userId)` from `~/shared/lib/auth/organization-lifecycle` (`:889`),
    not through `withTenantContext`.** A user may hold up to 5 tokens across different organizations,
    and `organizations_app_select` (`drizzle/0008_tenant_rls.sql:39-41`) scopes `builderhunt_app` to
    `current_setting('app.organization_id')` — so the app role would render every row but the active
    organization's as a blank name. `listMyOrganizations` reads through `authDb` under the
    unrestricted `organizations_auth_broker_all` policy and returns exactly this user's memberships,
    which is also a second, independent membership check on every listed token. DELETE `?id=` revokes
    with `'user'` after asserting `row.userId === principal.userId`; a foreign id → 404, never 403.
  - Verify: `pnpm test:api-isolation:local` — tenant B's user cannot revoke tenant A's user's token
    and gets 404 (no existence leak).

- [ ] **`/settings/extension` page**
  - Files: `src/routes/_dashboard/settings/extension.tsx` (new),
    `src/modules/dashboard/components/ExtensionSettingsPanel.tsx` (new)
  - Do: Follow `src/routes/_dashboard/settings/security.tsx`'s `beforeLoad` + component shape. Panel:
    install link (`VITE_EXTENSION_STORE_URL`, hidden when unset), a "Connecting to **{active
    organization}** — switch organizations first if that's wrong" notice, the `extension` consent
    checkbox posting to `/api/consent`, the 8-char code field posting to `pair/approve`, and the
    token list with per-row Revoke. Renders a "not enabled" empty state when the feature flag is off.
  - Verify: manual — pair a locally-loaded unpacked extension end to end; the list shows one row with
    the right organization; Revoke makes the extension's next request 401.

- [ ] **Surface extension tokens next to sessions**
  - Files: `src/routes/_dashboard/settings/security.tsx`,
    `src/modules/dashboard/components/UserMenu.tsx`
  - Do: Render `ExtensionSettingsPanel` read-only (list + revoke, no pairing field) below the
    existing `src/modules/dashboard/components/ActiveSessionsPanel.tsx`; add an "Extension" item to
    `UserMenu.tsx`'s settings group.
  - Verify: `/settings/security` shows both panels;
    `pnpm test -- tests/unit/modules/dashboard/components` passes — note there is **no** `UserMenu`
    test at HEAD (`tests/unit/modules/dashboard/components/` holds `ActiveSessionsPanel.test.tsx`
    and six others, none for the menu), so the menu entry is covered by
    `pnpm type-check` plus a manual click, not by an existing spec.

## Phase 3 — Read API

- [ ] **Pure profile-reference parser**
  - Files: `src/shared/lib/extension/profile-ref.ts` (new),
    `tests/unit/shared/lib/extension/profile-ref.test.ts` (new)
  - Do: `parseGitHubProfilePath(pathname)` → `{ source: 'github'; username } | null`, matching
    `^/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/?$` and rejecting GitHub's reserved paths (`settings`,
    `orgs`, `topics`, `marketplace`, `explore`, `notifications`, `pulls`, `issues`, `codespaces`,
    `sponsors`, `about`, `pricing`, `features`, `security`, `login`, `join`, `search`, `new`,
    `dashboard`, `apps`, `collections`, `trending`, `events`, `readme`). Export
    `GITHUB_RESERVED_PATHS` so extension and server share one list.
  - Verify: `pnpm test -- tests/unit/shared/lib/extension/profile-ref.test.ts` — `/torvalds` parses;
    `/torvalds/linux`, `/orgs/acme`, `/settings/profile`, `/` all return `null`.

- [ ] **Recency bands aligned with `score.ts`**
  - Files: `src/shared/lib/extension/recency.ts` (new),
    `tests/unit/shared/lib/extension/recency.test.ts` (new)
  - Do: `recencyBandOf(timestampMs | null, nowMs)` → `today|week|month|quarter|year|stale|unknown`
    using **exactly** `src/lib/score.ts:42-46`'s cutoffs (< 1, < 7, < 30, < 90, < 365 days; null →
    unknown), with a comment naming that line range so the two cannot drift. **If
    `match-evidence-panel` has already landed**, import its band helper out of `src/lib/score.ts`
    instead of restating the numbers — check `src/lib/score.ts` for an exported band function before
    writing a second copy, since duplicating score math is the exact defect that plan exists to
    remove (`getScoreBreakdown` in `src/components/ui/score-ring.tsx`).
  - Verify: `pnpm test -- tests/unit/shared/lib/extension/recency.test.ts` — boundaries at exactly
    1/7/30/90/365 days, plus a `fast-check` property that the band is monotonic in age.

- [ ] **Pin the API compatibility contract in code**
  - Files: `src/shared/lib/extension/api-version.ts` (new),
    `tests/unit/shared/lib/extension/api-version.test.ts` (new)
  - Do: Spec §6's five rules become constants, not prose: `export const EXTENSION_API_VERSION = 1`,
    `export const SUPPORTED_API_VERSIONS = [1] as const`,
    `export const API_VERSION_HEADER = 'x-bh-api-version'`,
    `export const EXTENSION_VERSION_HEADER = 'x-bh-extension-version'`, and
    `resolveApiVersion(request): { ok: true; version: number } | { ok: false; supported: number[] }`
    — a **missing** header resolves to `1` (pre-header builds exist in the wild forever), an
    unparseable or unsupported one is `ok: false` and the route answers
    `400 { error: 'api_version_unsupported', supported }`. Also
    `isBelowMinimumVersion(clientVersion, minVersion)` doing a numeric semver compare (not a string
    compare — `0.10.0` must beat `0.9.0`), returning `false` for an absent or unparseable client
    version so a malformed header never hard-blocks a working install.
  - Verify: `pnpm test -- tests/unit/shared/lib/extension/api-version.test.ts` — missing header → 1;
    `"2"` → `ok: false, supported: [1]`; `"abc"` → `ok: false`; `0.10.0` vs min `0.9.0` → not below;
    `0.9.0` vs min `0.10.0` → below; `undefined` vs min `9.9.9` → not below.

- [ ] **Profile and session DTO schemas**
  - Files: `src/shared/lib/extension/profile-dto.ts` (new),
    `tests/unit/shared/lib/extension/profile-dto.test.ts` (new)
  - Do: `extensionProfileDto` from `spec.md` §Architecture 4 verbatim (`.strict()`), plus
    `extensionSessionDto` = `{ apiVersion, organization, user: { id, name }, tier, features }`.
    Export the inferred types. Add a top-of-file comment stating rule 1 of the compatibility
    contract — fields are added, never removed, renamed, or narrowed within `apiVersion: 1` — and
    that `.strict()` applies to the server's own output only; the extension client must not
    strict-parse.
  - Verify: `pnpm test -- tests/unit/shared/lib/extension/profile-dto.test.ts` — a fixture containing
    `secretHash`, `privateMetadata`, or `creatorUserId` fails to parse, and a fixture with an
    unknown-but-harmless extra key also fails (proving `.strict()` is on).

- [ ] **Add the functional username index the cross-source lookup needs**
  - Files: `drizzle/<next>_builder_identities_lower_username_idx.sql` (new — drizzle-kit allocates
    the index; do not hardcode one), `drizzle/meta/*`, `drizzle/migration-hashes.json`
  - Do: Mint with `pnpm exec drizzle-kit generate --custom --name
    builder_identities_lower_username_idx` (a hand-created file is never journaled and never
    applied), body `CREATE INDEX IF NOT EXISTS builder_identities_lower_username_idx ON
    builder_identities (lower(username));`. Re-verified at HEAD: `builder_identities` has exactly two
    indexes, `builder_identities_source_source_id_unique` and
    `builder_identities_source_username_idx` on `(source, username)`
    (`drizzle/0005_builder_normalization.sql:77-78`, `schema.ts:159-160`), neither of which can serve
    `lower(username) = $1` with no `source` equality, and `grep -n "lower(" drizzle/*.sql` returns
    nothing — there is no functional index anywhere in this schema. Header comment must record the
    operator alternative: if `builder_identities` exceeds ~1M rows in production, run
    `CREATE INDEX CONCURRENTLY` out-of-band before deploying (a drizzle migration runs in a
    transaction, so `CONCURRENTLY` cannot go in the file) — same operator-step shape as
    [`semantic-search`](../../phase-1/22-semantic-search/spec.md)'s Coolify pgvector swap. Additive,
    index-only: no column, grant, or policy is added or altered.
  - Verify: `pnpm test:migration-integrity`; `pnpm test:migrations:local`; then, against a seeded
    local DB, `EXPLAIN ANALYZE SELECT id, source, username, profile_url FROM builder_identities
    WHERE lower(username) = lower('torvalds') AND source <> 'github' LIMIT 8;` reports an **Index
    Scan** on the new index, not a Seq Scan.

- [ ] **Identity lookup repository**
  - Files: `src/shared/lib/repositories/builder-identity-lookup.ts` (new),
    `tests/unit/shared/lib/repositories/builder-identity-lookup.test.ts` (new)
  - Do: `findIdentityBySourceUsername(source, username)` (equality on both columns, uses
    `builder_identities_source_username_idx`), `findIdentityBySourceId` (uses
    `builder_identities_source_source_id_unique`), `findCrossSourceUsernameMatches(username,
    excludeSource, limit = 8)` (`lower(username) = lower($1) AND source <> $2`, uses the new
    functional index), and `findSprintMatchesForIdentity(tx, organizationId, source, sourceId,
    limit = 3)`. **Write the sprint query exactly as spec §4 specifies** — lead with
    `sourcing_sprints` filtered by `organization_id` and join into `sprint_results`, so the planner
    nested-loops through `sprint_results_sprint_source_unique`. The obvious form
    (`WHERE sprint_results.organization_id = $1 AND source = $2 AND source_id = $3`) is a **sequential
    scan**: `sprint_results` has only `(sprint_id, source, source_id)` and `(sprint_id, created_at)`
    (`schema.ts:952`), and both lead with `sprint_id`. Run it under `withTenantContext` because
    `builderhunt_app`'s access is `SELECT` + the org-scoped `sprint_results_app_select` policy and
    nothing more (`drizzle/0024_sourcing_sprints_grants.sql:31,56`). `builder_identities` is
    `global-public` with a `builderhunt_app` grant (`drizzle/0011_builder_claim_policies.sql`), so
    the first three read through the runtime client like `src/shared/lib/repositories/public-builders.ts`;
    no function may return a tenant column except the org-scoped sprint join.
  - Verify: `pnpm test -- tests/unit/shared/lib/repositories/builder-identity-lookup.test.ts`;
    `pnpm security:boundaries` (if it flags a global-db import, add the file to `globalDbAllowlist`
    at `scripts/check-tenant-boundaries.mjs:28-36` with the "global-public read, allowlisted columns
    only" reason, the same reason `public-data.ts` carries); and
    `EXPLAIN ANALYZE` the sprint join against a seeded local DB — it must show an Index Scan on
    `sprint_results_sprint_source_unique`, not a Seq Scan on `sprint_results`. If the planner picks a
    Seq Scan anyway, add
    `CREATE INDEX sprint_results_org_source_idx ON sprint_results (organization_id, source, source_id);`
    to the migration above and re-run.

- [ ] **`GET /api/extension/session`**
  - Files: `src/routes/api/extension/session.ts` (new)
  - Do: `requireExtensionPrincipal`; rate limit `('extension-session', authedId, 60, 60)`. Read the
    organization name via `~/shared/lib/organizations/contracts` and the tier via
    `getOrganizationEntitlement` + `resolveLegacyPlanTier` under `withTenantContext`. Return
    `extensionSessionDto` with `features` = `{ track: true, status: true, note: true }` (all three
    are app-role-owned writes; the object exists so the server can disable any of them without a
    store release). Apply the version gate from `api-version.ts`: `resolveApiVersion` first (→ 400
    `api_version_unsupported`), then `isBelowMinimumVersion` (→
    `410 { error: 'extension_version_unsupported', minVersion }`). Factor both into one
    `withExtensionVersionGate(request, handler)` wrapper used by **every** `/api/extension/*` route
    that a paired client calls, so a new route cannot forget it.
  - Verify: `curl -H 'Authorization: Bearer <token>' -H 'X-BH-API-Version: 1' …/api/extension/session`
    returns the bound organization's name and tier; the same call with `X-BH-API-Version: 2` returns
    `400 api_version_unsupported`; the same call with the header omitted still returns 200 (missing
    means 1); setting `EXTENSION_MIN_VERSION=9.9.9` makes it 410.

- [ ] **`GET /api/extension/profile`**
  - Files: `src/routes/api/extension/profile.ts` (new)
  - Do: `requireExtensionPrincipal` + `withExtensionVersionGate`; rate limit
    `('extension-lookup', getAuthedRateLimitId({ userId, organizationId }), 120, 60)` — the
    `extension-*` scope prefix is unclaimed at HEAD. Query `?source=github&username=` or
    `&sourceId=`, `source` validated against `SOURCE_NAMES` from `~/lib/sources/types`. Resolve the
    identity, then **`isSuppressed(source, identity.sourceId)` from
    `~/shared/lib/profile-suppression` → return the `known: false` DTO**, byte-identical to the
    never-seen response. This filter is mandatory, not optional: `profile-suppression.ts`'s own
    header comment names every identity-surfacing endpoint as a required caller, and a 404 or a
    `restricted: true` here would let anyone confirm a removal request by asking the API about a
    login. Then under `withTenantContext` call `findOrganizationBuilderBySource(tx,
    principal.organizationId, source, sourceId)`, `listOrganizationBuilderNotes` for the count, and
    `findSprintMatchesForIdentity` for `sprintMatches` (SELECT-only, org-scoped; empty whenever
    `known` is false, since there is no `source_id` to key on).
    `findActiveBuilderProcessingRestriction(identityId)` from
    `~/shared/lib/repositories/enrichment-restrictions` (`:39`) → `restricted: true` with optional
    fields nulled. Respond through `extensionProfileDto.parse(...)` with `Cache-Control: private,
    max-age=300` and an ETag over the serialized DTO, honouring `If-None-Match` with 304. Log
    `{ requestId, organizationId, source, known }` only — **never the username**. Zero external calls.
  - Verify: an unknown login returns `known: false` with no outbound request (assert with
    `GITHUB_TOKEN` unset); an identical second call returns 304; a login for which
    `listActiveSuppressions()` returns a row is byte-identical to an unknown login; no username
    appears in the log.

- [ ] **Tenant A/B isolation cases for the read API**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Seed one `builder_identities` row tracked by tenant A only, plus one tenant-A
    `sourcing_sprints` + `sprint_results` row naming that identity, then call the real `profile.ts`
    handler with (a) A's extension token → `tracked` present and `sprintMatches` length 1, (b) B's
    token → same identity, `tracked: null`, no note count, **`sprintMatches: []`**, (c) no token →
    401, (d) A's token after deleting A's membership → 403 and the token row revoked with
    `revoked_reason = 'membership_lost'`, (e) a token whose organization was deleted → 401 (the FK
    cascade removed the row), (f) A's token against a `(source, sourceId)` with an active
    suppression row → a response byte-identical to an unknown login, and (g) A's token while that
    user's enforcement stage is `'blocked'` → 403 with the token row still active.
  - Verify: `pnpm test:api-isolation:local` — seven new checks pass against the real non-owner
    roles, including the `sprint_results` SELECT succeeding as `builderhunt_app` under tenant
    context. This is the run that would catch a missing grant, so read its output rather than
    trusting the checkbox.

- [ ] **Assert no CORS surface was introduced**
  - Files: `tests/unit/security/http-security.test.ts`, `server/security.mjs`
  - Do: The two guard cases this plan depends on already exist and were re-verified at HEAD:
    `it('adds no CORS surface')` at `:68` and `it('rejects an extension origin carrying a cookie')`
    at `:113`, which asserts `isTrustedMutationOrigin` is `false` for both `chrome-extension://` and
    `moz-extension://` origins. Re-run them and confirm they still hold after this plan's API work.
    Add one new case: a cookieless `POST` with an `Authorization` header and no `Origin` **passes**
    the gate — that is the branch the extension actually rides (`server/security.mjs:91-92`, "no
    cookie → return true"), and pinning it stops someone "hardening" the gate into rejecting
    Origin-less requests unconditionally and breaking every install with no test failure. Do NOT add
    an `Access-Control-Allow-*` header: the extension path works *without* cookies
    (`credentials: 'omit'` from the MV3 service worker), not by loosening the gate — see spec
    §"The auth model" for why cookie+CORS is structurally unavailable.
  - Verify: `pnpm test -- tests/unit/security/http-security.test.ts` — all cases pass. Then
    `grep -rn "access-control-allow" -i server/ src/` must return **exactly one** line, the
    explanatory comment at `server/security.mjs:35`; any second hit is a real header being emitted.

## Phase 4 — The MV3 extension package (read-only overlay)

- [ ] **Scaffold `extension/` as a non-workspace package**
  - Files: `extension/package.json` (new), `extension/tsconfig.json` (new),
    `extension/vite.config.ts` (new), `.dockerignore`, `eslint.config.js`
  - Do: Own `package.json` (private, own `vite` + `typescript`) and own lockfile — **do not** add a
    `packages:` key to `pnpm-workspace.yaml` (it has only `allowBuilds`, `overrides` and
    `onlyBuiltDependencies` today, and adding `packages:` changes root install behaviour). Because
    that file still marks the repo root as a workspace root, every `extension/` pnpm command needs
    **`--ignore-workspace`**. Vite multi-entry (`sw`, `content`, `popup`), `format: 'es'`,
    `target: 'es2022'`, no cross-entry chunking. Alias `@app` → `../src/shared/lib/extension`. Add
    `'extension'` to `.dockerignore` and to the `ignores` array at `eslint.config.js:7`. **Do not
    touch the root `tsconfig.json`** — its `include` is already `["src/**/*", "*.ts"]`, so
    `extension/` is outside the app's program already and an `exclude` entry would be a no-op that
    reads as load-bearing.
  - Verify: root `pnpm install --frozen-lockfile && pnpm type-check && pnpm lint && pnpm build` all
    pass and never touch `extension/`;
    `pnpm --dir extension --ignore-workspace install && pnpm --dir extension --ignore-workspace build`
    emits `dist/sw.js`, `dist/content.js`, `dist/popup.js`, and `grep -c eval extension/dist/*.js`
    reports 0 for each (MV3 forbids remote code and the default `script-src 'self'` CSP forbids
    `eval`).

- [ ] **Chrome manifest with the narrowest viable permissions**
  - Files: `extension/manifest.json` (new)
  - Do: `manifest_version: 3`, `version: "0.1.0"`, single-purpose description.
    `background: { service_worker: "sw.js", type: "module" }`;
    `content_scripts: [{ matches: ["https://github.com/*"], js: ["content.js"], run_at: "document_idle" }]`;
    `permissions: ["storage","alarms"]`; `host_permissions: ["https://github.com/*", "<APP_ORIGIN>/*"]`;
    `optional_host_permissions: []`; `action` with the popup. **No** `tabs`, `<all_urls>`,
    `webRequest`, `scripting`, or `externally_connectable`. Keep the default MV3 CSP.
  - Verify: load unpacked in Chrome — zero manifest warnings; `chrome://extensions` shows exactly two
    host permissions.

- [ ] **Firefox manifest variant + pack script**
  - Files: `extension/manifest.firefox.json` (new), `extension/scripts/pack.mjs` (new)
  - Do: Identical except `background: { scripts: ["sw.js"], type: "module" }` and
    `browser_specific_settings.gecko.id`. `pack.mjs` takes `--target=chrome|firefox`, copies the
    right manifest + icons into `dist/`, zips to `dist-<target>.zip`.
  - Verify: `pnpm --dir extension --ignore-workspace pack --target=firefox` produces a zip that
    `web-ext lint` accepts, or that loads via `about:debugging`.

- [ ] **Compile-time host policy module**
  - Files: `extension/src/shared/host-policies.ts` (new),
    `extension/src/shared/host-policies.test.ts` (new — this one lives inside `extension/` and runs
    under the extension's own vitest, not the app's; the app's `vitest.config.ts` only includes
    `tests/unit/**` so it will never see it)
  - Do: Mirror `src/lib/enrichment/policies.ts`'s shape — a frozen record of host policies,
    `HARD_BLOCKED_HOSTS = ['linkedin.com','x.com','facebook.com','instagram.com']` (the exact four
    ids in `HARD_BLOCKED_CONNECTOR_IDS` at `policies.ts:28`), and `assertHostAllowed(hostname)` which
    throws for anything not `enabled`. Import it at the top of `content.ts` so the overlay cannot run
    on a blocked host even if a future manifest edit added one.
  - Verify: `pnpm --dir extension --ignore-workspace test` — register entries and policies match both
    ways; `assertHostAllowed('www.linkedin.com')` throws.

- [ ] **Service worker: token store, cache, and all network I/O**
  - Files: `extension/src/sw.ts` (new), `extension/src/shared/api.ts` (new)
  - Do: `runtime.onMessage` handlers for `pair:start`, `pair:poll`, `profile:get`, `session:get`. All
    `fetch` calls use `credentials: 'omit'`, `Authorization: Bearer <token>`,
    `X-BH-Extension-Version` from `runtime.getManifest().version`, `X-BH-API-Version: 1`. Token in
    `storage.local`; LRU (200 entries, 5-min TTL, key `${source}:${username}:${orgId}`) in
    `storage.session` with an in-memory `Map` fallback. Implement spec §6's degradation table as one
    `switch` on `response.status` and nothing else, so every unhandled case falls to the "render
    nothing" default: 400 `api_version_unsupported` and 410 both set `needsUpdate` (410 additionally
    stops polling until the manifest version changes), 401 clears the token and sets
    `needsReconnect`, 402 is passed through to the caller, 429/503/network error render nothing and
    do not retry before the next navigation. Responses are read with `JSON.parse` and consumed
    field-by-field — **never** validated with a `.strict()` schema, so a server that adds a field
    cannot break an installed client. One shim:
    `const api = globalThis.browser ?? globalThis.chrome`.
  - Verify: manual — against `localhost:3000` the SW resolves a known profile and the Network panel
    shows no `Cookie` header and no preflight `OPTIONS`.

- [ ] **Content script: URL-only detection + Shadow-DOM card**
  - Files: `extension/src/content.ts` (new), `extension/src/overlay.css` (new)
  - Do: On `document_idle` and on `pushState`/`popstate` (GitHub is a SPA) call
    `assertHostAllowed(location.hostname)` then `parseGitHubProfilePath(location.pathname)`; do
    nothing on `null`. `sendMessage('profile:get')`, render into
    `attachShadow({ mode: 'closed' })` inserted into `.Layout-sidebar` (fallback: fixed
    bottom-right). Header = `organization.name`; collapsed pill until hover; per-profile dismiss in
    `storage.session`. **Read nothing from the DOM** — no `innerText`, no `textContent` read, no
    `querySelector` against GitHub content.
  - Verify: `grep -nE 'innerText|textContent|innerHTML' extension/src/content.ts` matches only writes
    to the shadow root; `github.com/torvalds` shows the card and `github.com/torvalds/linux` issues no
    request at all.

- [ ] **Popup**
  - Files: `extension/popup.html` (new), `extension/src/popup.ts` (new)
  - Do: Connection state, bound organization from `session:get`, **Connect** (runs `pair:start`,
    shows the 8-char code with a link to `<APP_ORIGIN>/settings/extension`), **Reconnect**, **Open
    BuilderHunt**, and the `needsUpdate` state as "Update BuilderHunt Connect".
  - Verify: manual — Connect → code → approve in the app → the popup flips to the bound organization
    within one poll interval.

## Phase 5 — Write actions

- [ ] **Server-side GitHub profile resolution (write path only)**
  - Files: `src/lib/extension/github-profile.ts` (new),
    `tests/unit/lib/extension/github-profile.test.ts` (new)
  - Do: `resolveGitHubProfile(login)` calling `GET https://api.github.com/users/{login}` with
    `env.GITHUB_TOKEN` when present, mapped to the shape `src/lib/sources/github.ts` produces
    (`sourceId: String(user.id)`, `profileUrl: user.html_url`, …). Assert the request host against
    the `github` policy's `allowedHosts` — `['github.com', 'api.github.com']` at
    `src/lib/enrichment/policies.ts:38` — and rate limit `('extension-github-resolve', 'global', 20,
    60)` to that policy's declared `maxRequestsPerMinute: 20` (`:41`). Return `null` on
    404/403/rate-limit — never throw into the route. Do not present anything this returns as measured
    evidence: `app-reality.md` constraint 8 lists the `RawBuilder` fields the source adapters
    synthesize, and the extension card shows only `displayName`/`avatarUrl`/`followersCount`, never
    `bio` or `topics`.
  - Verify: `pnpm test -- tests/unit/lib/extension/github-profile.test.ts` with a mocked fetch —
    404 → null; a non-`api.github.com` host throws before any fetch; the mapped `sourceId` is the
    numeric id as a string.

- [ ] **`POST /api/extension/track`**
  - Files: `src/routes/api/extension/track.ts` (new)
  - Do: `requireExtensionPrincipal` + `withExtensionVersionGate`; rate limit
    `('extension-track', getAuthedRateLimitId({ userId, organizationId }), 60, 3600)`. Body
    `{ source, username }` (or `sourceId`). Resolve display fields from `builder_identities` when
    known, else `resolveGitHubProfile`; 404 if unresolvable. **Then `isSuppressed(source, sourceId)`
    → 404**, exactly as `src/routes/api/builders/track.ts:51-53` does before anything else — this
    call was missing from the first draft of this plan and is the difference between honouring a
    verified removal request and re-creating the identity row it deleted. Then replicate the rest of
    that route's sequence under `withTenantContext` (`track.ts:55-73`): `getOrganizationEntitlement`
    + `countOrganizationBuilders` + `findOrganizationBuilderBySource` in one `Promise.all` →
    `PLAN_LIMITS[resolveLegacyPlanTier(entitlement.tier)].savedBuilders` gate, returning the
    identical 402 body `{ error, current, limit, plan, upgradeUrl: '/pricing' }` →
    `trackOrganizationBuilder({ …, metadata: { origin: 'extension' } })`, then fire
    `upsertEmbeddingStubs([...]).catch(...)` outside the transaction. Return the fresh
    `extensionProfileDto`. Do **not** modify `/api/builders/track`. Note for the reader:
    `trackOrganizationBuilder` rewrites `privateMetadata` wholesale on conflict
    (`organization-builders.ts:346-350`), so `origin` is a first-touch marker a later web-UI
    re-track will drop — that is accepted, not a bug to fix here.
  - Verify: `pnpm test:api-isolation:local` — tracking with A's token creates a row only in A; a
    free-tier org at 50 builders gets 402 with the same body shape `/api/builders/track` returns;
    `privateMetadata.origin === 'extension'`; a suppressed `(source, sourceId)` gets 404 and creates
    no `builder_identities` row.

- [ ] **`POST /api/extension/note`**
  - Files: `src/routes/api/extension/note.ts` (new)
  - Do: `requireExtensionPrincipal` + `withExtensionVersionGate`; rate limit
    `('extension-note', getAuthedRateLimitId({ userId, organizationId }), 60, 3600)`. Body
    `{ source, username, body: z.string().min(1).max(2000) }`. Resolve the tracking row via
    `findOrganizationBuilderBySource`; 404 when not tracked (notes require tracking, as in the web
    UI). `createOrganizationBuilderNote(tx, { id, organizationId, userId, builderId, content })`
    under `withTenantContext`; return `{ noteCount }`. Grant check: `builder_notes` carries
    `builder_notes_app_insert` and `GRANT SELECT, INSERT, UPDATE, DELETE ... TO builderhunt_app` from
    `drizzle/0008_tenant_rls.sql` (policy loop `:55-88`, grant `:108-118`) — legal. Inherited
    constraint worth knowing before you debug an FK error: `builder_notes.builder_id` still FKs to
    the **legacy `builders`** table through `builder_notes_organization_builder_fk`, and the id
    `findOrganizationBuilderBySource` returns is valid there only because `trackOrganizationBuilder`
    generates `organization_builders.id` and `builders.id` together and dual-writes both
    (`organization-builders.ts:310-340`). Pass that id straight through; do not invent a second
    lookup.
  - Verify: `pnpm test:api-isolation:local` — tenant B cannot note against tenant A's tracking row
    (404, not 403), and the insert succeeds as the real `builderhunt_app` role.

- [ ] **`POST /api/extension/status` (the "add to list" action)**
  - Files: `src/routes/api/extension/status.ts` (new),
    `src/shared/lib/repositories/organization-builders.ts`
  - Do: **Do not write `sprint_results`** — `withTenantContext` runs as `builderhunt_app`
    (`src/shared/lib/db/tenant-context.ts`) and `drizzle/0024_sourcing_sprints_grants.sql` grants that
    role only `SELECT` on that table (line 56, policy `sprint_results_app_select` at line 31); INSERT
    belongs to `builderhunt_worker` (line 58), and manual rows would also corrupt
    `sourcing_sprints.quota` / the `quotaHit → completed` transition at
    `src/lib/sprints/worker.ts:86,101-103`. All four line references re-verified at HEAD, and `0015`
    and `0024` are still the only two migrations that mention `sprint_results`. See spec §8. Instead:
    add an additive `setOrganizationBuilderStatus(tx, organizationId, id, status)` to the existing
    repository — no existing caller changes; `organization_builders_status_check` already constrains
    the value to `('tracked','shortlisted','archived')`
    (`drizzle/0005_builder_normalization.sql:53`, `schema.ts:196`) and `drizzle/0008_tenant_rls.sql`
    already gives `builderhunt_app` both `organization_builders_app_update` (policy loop `:55-88`)
    and the table grant (`:108-118`). Route: `requireExtensionPrincipal` +
    `withExtensionVersionGate`; rate limit
    `('extension-status', getAuthedRateLimitId({ userId, organizationId }), 60, 3600)`; body
    `{ source, username, status: z.enum(['tracked','shortlisted','archived']) }`; resolve via
    `findOrganizationBuilderBySource` and 404 when not tracked; return the fresh
    `extensionProfileDto`.
  - Verify: `pnpm test:api-isolation:local` — A's token shortlists A's row; B's token against the same
    identity gets 404; the status change is visible in `/dashboard`. Crucially, the check runs as the
    real `builderhunt_app` role, so a missing grant would fail loudly here.

- [ ] **Wire the write buttons behind the server's `features` object**
  - Files: `extension/src/content.ts`, `extension/src/sw.ts`
  - Do: Render Track / Shortlist / Note only when the matching `features` flag is true; render each
    `sprintMatches` entry as read-only "Found by sprint *{name}*" text with no action. Optimistically
    update the card, then reconcile with the response DTO. On 402 open `<APP_ORIGIN>/pricing` in a new
    tab; on 404 (untracked) collapse to just the Track button. Never surface a raw server error string
    on `github.com`.
  - Verify: manual — Track flips the card to "Tracked by {org}", Shortlist flips the status chip, and
    both rows are visible in `/dashboard`; a profile surfaced by a sprint shows the sprint name with
    no clickable affordance.

## Phase 6 — Gating, metrics, release pipeline, Firefox target

- [ ] **Name the extension in the plan copy**
  - Files: `src/shared/lib/billing-shared.ts`
  - Do: Add `'Browser extension (GitHub overlay)'` to `PLAN_PRICING.free.features`
    (`src/shared/lib/billing-shared.ts:87-98`, a plain `string[]` — `compactFeatures(...)` is only
    used by the pro/team entries and is not needed here) with a comment naming the one enforceable
    gate: `PLAN_LIMITS.free.savedBuilders` = 50 on Track (Shortlist and Note only mutate an
    already-tracked row, so they need no separate gate). No new limit constant, and no
    `SOURCING_SPRINT_LIMITS` change — free is already 0, which is why `sprintMatches` is naturally
    empty on that tier.
  - Verify: `pnpm test -- tests/unit/shared/lib/billing.test.ts`; `/pricing` lists the bullet under
    Free.

- [ ] **Aggregate metrics, no browsing history — two of three, and say why**
  - Files: `src/routes/api/admin/metrics/index.ts`,
    `src/shared/lib/repositories/platform-extension-metrics.ts` (new),
    `scripts/check-tenant-boundaries.mjs`
  - Do: New repository beside `src/shared/lib/repositories/platform-billing.ts` (whose
    `getPlatformAccountMetrics` the metrics route already calls at `index.ts:23`), reading
    `extension_tokens`/`extension_pairings` through `authDb` — **that is the only connection it
    needs**. Add the file to `check-tenant-boundaries.mjs`'s `authDbAllowlist`. Ship exactly two
    aggregates: pairing counts by status over 30 days, and a single count of `extension_tokens` with
    `last_used_at > now() - interval '7 days'`. No per-profile, per-username, or per-URL data
    anywhere.
    **Do NOT add the `organization_builders` / `private_metadata->>'origin' = 'extension'` count,
    and do not reach for `platformDb` to get it.** `builderhunt_platform` has no grant *and* no
    policy on `organization_builders`: the only grants are `builderhunt_app`'s from
    `drizzle/0008_tenant_rls.sql:108-118` and a worker SELECT from
    `drizzle/0018_enrichment_worker_target_access.sql:6,11`, and the table is `FORCE ROW LEVEL
    SECURITY`, so even a bare grant would return zero rows rather than an error. The metrics route
    documented this outcome by hardcoding `totalSavedQueries: null, totalBuilders: null,
    totalNotes: null`. Those keys were removed on 2026-08-06 and the reasoning moved into a comment on
    the same route; the constraint is unchanged, only the evidence's location.
    Adding a cross-tenant platform read of tenant tracking data
    for a growth number is a `security-policy.md` §10 widening that needs an ADR, not a metrics task.
    Instead, add a comment beside the two shipped aggregates naming the deferred third and this
    reason, so the next reader does not re-derive it.
  - Verify: `curl` `/api/admin/metrics` as a platform admin shows both new fields; a non-admin gets
    403; `pnpm security:boundaries` passes with the new allowlist entry; `pnpm test:api-isolation:local`
    still passes. Confirm the deferral is real rather than assumed:
    `grep -n "organization_builders" drizzle/*.sql | grep -i "grant\|platform"` returns only the
    `builderhunt_worker` line.

- [ ] **Sweep expired pairings on the existing worker**
  - Files: `src/routes/api/admin/legal/run-worker.ts`,
    `src/shared/lib/repositories/extension-tokens.ts`
  - Do: Add a `deleteExpiredPairings()` pass (`expires_at < now() - interval '1 day'`) to the existing
    legal run-worker's response as `{ pairingsSwept }`. That route is already dual-gated by
    `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`
    (`run-worker.ts:22`), so no auth change is needed. The delete runs as `builderhunt_auth`, which
    the Phase 1 migration granted `DELETE` on `extension_pairings`. Idempotent; no new endpoint, no
    new cron entry, no new `CRON_SECRET`-style env var.
  - Verify: `curl -H "X-Cron-Secret: $CRON_SECRET" -X POST …/api/admin/legal/run-worker` returns
    `pairingsSwept`; a second run returns 0.

- [ ] **Extension release workflow**
  - Files: `.github/workflows/extension-release.yml` (new)
  - Do: Trigger on `push: tags: ['ext-v*']`. Mirror `.github/workflows/quality.yml`'s
    `pnpm/action-setup@v6` (`:55`) + `actions/setup-node@v7` with `node-version: 22` (`:58-60`), then
    `pnpm --dir extension --ignore-workspace install --frozen-lockfile`, build + pack both targets,
    attach `dist-chrome.zip` and `dist-firefox.zip` to the release. Header comment states that store
    upload is manual (the Chrome Web Store API needs OAuth client credentials that do not exist yet).
  - Verify: pushing `ext-v0.1.0-rc.1` on a branch produces both zips; `quality.yml` and `deploy.yml`
    are unaffected (neither has a `tags:` trigger, so confirm by reading their `on:` blocks rather
    than by waiting for a run that never starts).

- [ ] **Store listing and compatibility contract docs**
  - Files: `extension/STORE_LISTING.md` (new), `docs/operations/extension-host-register.md`
  - Do: Write the single-purpose description, a justification per host permission, the
    limited-use/prominent-disclosure statement (matching `/legal/extension`), and the
    privacy-practices answers. Append a **"Compatibility contract"** section to the register
    reproducing spec §6's five rules and its per-status degradation table, plus one line that must be
    filled in the day a v2 DTO ships: "`apiVersion: 1` served until **&lt;date&gt;** (≥ 180 days after
    v2 reached the store)". The register is where an operator looks before turning something off, so
    the removal date lives here rather than in a code comment.
  - Verify: every store privacy-practices question has a written answer; `STORE_LISTING.md` and
    `/legal/extension` say the same thing; the register's contract section and
    `src/shared/lib/extension/api-version.ts`'s constants agree (`SUPPORTED_API_VERSIONS` matches the
    versions the register says are served).

- [ ] **Decide `activityBand` and close the grant question**
  - Files: `scripts/db/verify-api-isolation-local.mjs`, `docs/architecture/data-classification.md`
  - Do: Run `grep -n "builder_source_snapshots" drizzle/*.sql | grep -i grant` first. **If it is
    still empty** (it was at 2026-07-27), leave `activityBand: 'unknown'` and record the deferral —
    branch (a). **If it returns a row**, [`match-evidence-panel`](../match-evidence-panel/spec.md)
    has landed its "Grant `builder_source_snapshots` to the runtime role" task
    (`GRANT SELECT, INSERT, DELETE ... TO builderhunt_app`) along with a real writer, so take branch
    (b): populate the band from `payload->>'lastSeen'`, prove the read as the real `builderhunt_app`
    role, and delete the "no runtime-role grant" sentence from spec §4. **Do not add the grant from
    this plan** — it belongs to the plan that also supplies the writer, and a grant without a writer
    buys an empty table plus a widened role.
  - Verify: `pnpm test:api-isolation:local` — either the negative permission check passes (a) or the
    positive read passes as `builderhunt_app` (b). Whichever branch is taken, the corresponding
    sentence in `spec.md` §4 and the row in `docs/architecture/data-classification.md` say the same
    thing afterwards.

- [ ] **Flip the flag in staging and run the full gate**
  - Files: `.env.example`
  - Do: Set `EXTENSION_API_ENABLED=true` in staging only; pair a store-signed build; run one Track,
    one Note and one **Shortlist** (there is no "sprint add" — the sprint relationship is read-only,
    spec §8); confirm the logs contain no username and no token
    (`src/shared/lib/log.ts:45` already redacts `Bearer …`, but the username is only absent because
    the route never logs it, so check).
  - Verify: `pnpm ci:local` (the single gate that mirrors the CI workflow's env verbatim), then
    `pnpm test:rls:local && pnpm test:api-isolation:local && pnpm test:migrations:local` against a
    disposable Postgres, plus a staging smoke of spec §"Resolved edge cases" — specifically the
    suppressed subject, the restricted subject, the removed member, the blocked account, and the
    `EXTENSION_MIN_VERSION` 410.
