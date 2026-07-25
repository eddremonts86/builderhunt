# Browser Extension Overlay (tasks)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../security-and-multitenancy/spec.md) (a new authenticated client outside the app's cookie/CSRF assumptions); [`ai-expansion`](../../ai-expansion/spec.md) (Chrome built-in AI is the local-first tier this surface sits closest to); [`ai-sourcing-sprints`](../../ai-sourcing-sprints/spec.md) (the "add to sprint" action target — already shipped). Binding: [`ai-policy`](../../_meta/ai-policy.md), [`security-policy`](../../_meta/security-policy.md).
> **Blocks**: nothing
> **Reality check**: Extends `src/shared/lib/db/schema.ts`, `src/shared/lib/env.ts`, `src/shared/lib/legal.ts`, `src/routes/api/consent/index.ts`, `scripts/check-route-coverage.mjs`, `scripts/check-tenant-boundaries.mjs`, `scripts/db/verify-api-isolation-local.mjs`, `src/modules/dashboard/components/UserMenu.tsx`. New credential guard modelled on `src/shared/lib/auth/cron.ts`; new RLS/grants migration modelled on `drizzle/0044_abuse_usage_integrity_rls_grants.sql`. No existing route is modified and no existing table gains, loses, or alters a column — the only DDL against an existing table is the additive `builder_identities_lower_username_idx`. Writes stay inside tables `builderhunt_app` already has grants and policies for: `sprint_results` is SELECT-only for that role (`drizzle/0024_sourcing_sprints_grants.sql:31,56`), so the sprint relationship is read-only and the write action is `organization_builders.status` — spec §8.

Ordered so the app ships cleanly after every checkbox.

## Phase 0 — Host policy register + legal disclosure surface

- [ ] **Write the extension host register**
  - Files: `docs/operations/extension-host-register.md` (new)
  - Do: Mirror `docs/operations/public-enrichment-source-register.md` field for field. Entries:
    `github` = `enabled`, mode `url_only`, approved fields "username parsed from
    `location.pathname`; nothing else"; `linkedin`/`x`/`facebook`/`instagram` = `blocked` reusing
    the exact permission references `src/lib/enrichment/policies.ts` cites. Add the "Chrome Web
    Store review risk" paragraph from `spec.md` §5.
  - Verify: every host in `extension/src/shared/host-policies.ts` (Phase 4) has exactly one entry;
    `linkedin` has no approval date and no lawful basis.

- [ ] **Add the `extension` consent document**
  - Files: `src/shared/lib/legal.ts`, `src/routes/api/consent/index.ts`
  - Do: Add `extension: 'v1.0'` to `CURRENT_VERSIONS` in **both** files (the constant is duplicated
    today) and `'extension'` to `ConsentBody`'s `z.enum`. Do **not** bump `privacy` — a major bump
    forces every existing user to re-accept (`isMaterialVersionChange`).
  - Verify: `pnpm test`; `curl localhost:3000/api/consent` lists `extension` under `required` and
    under `needsAcceptance` for a user who has not accepted.

- [ ] **Publish the `/legal/extension` disclosure page**
  - Files: `src/routes/_landing/legal/extension.tsx` (new)
  - Do: Follow `src/routes/_landing/legal/privacy.tsx`'s structure. State exactly: what is sent
    (source + username from the URL, the token, two version headers), that no page content is ever
    read on any site, that lookups persist nothing, that the username is not logged, that the token
    is org-scoped and revocable, and that GitHub is the only supported host.
  - Verify: renders in light and dark theme; linked from `/legal/privacy`.

- [ ] **Classify the two new tables and the new guard**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: `extension_tokens` = `account-subject`, owner `user_id`, public fields none, retention
    "90-day TTL + revocation audit window"; `extension_pairings` = `system-operational`, retention
    "5-minute expiry + short sweep window". Add the `requireExtensionPrincipal` row to the matrix:
    bearer credential, organization from the token row, role re-read per request.
  - Verify: both tables present; no mixed-class row introduced.

## Phase 1 — Credential schema, RLS/grants, and `requireExtensionPrincipal`

- [ ] **Add `extension_tokens` and `extension_pairings` to the schema**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Both tables exactly as in `spec.md` §Architecture 1, including the partial unique index
    `... .where(sql\`${t.revokedAt} is null\`)` (same shape `builder_claims_active_identity_unique`
    already uses) and the `extension_pairings_status_check` constraint.
  - Verify: `pnpm type-check`; `pnpm db:audit-schema` reports no unclassified table.

- [ ] **Generate the table migration**
  - Files: `drizzle/00NN_extension_credentials.sql` (new, generated), `drizzle/meta/*`,
    `drizzle/migration-hashes.json`
  - Do: `pnpm db:generate`, which writes the SQL, appends the `_journal.json` entry, and emits
    `drizzle/meta/NNNN_snapshot.json`. Then regenerate the hash manifest
    (`node scripts/db/verify-migration-integrity.mjs --write`) and commit all three — the checker
    hard-fails unless the SQL set exactly equals the journal tags and every tag has a snapshot. Do
    not hand-edit the generated DDL: RLS/grants go in a separate migration, this repo's established
    split (`0043` vs `0044`).
  - Verify: `pnpm exec drizzle-kit check`; `pnpm test:migration-integrity` prints `valid: true`.

- [ ] **Hand-write the RLS + grants migration**
  - Files: `drizzle/00NN+1_extension_credentials_rls_grants.sql` (new), `drizzle/meta/*`,
    `drizzle/migration-hashes.json`
  - Do: Mint the file with `pnpm exec drizzle-kit generate --custom --name
    extension_credentials_rls_grants` so it lands in `_journal.json` with a matching snapshot — a
    hand-created `.sql` is never applied by `drizzle-kit migrate` and fails
    `verify-migration-integrity`. Then write the body: model on
    `drizzle/0044_abuse_usage_integrity_rls_grants.sql`, header comment naming the data classes,
    `ENABLE`/`FORCE ROW LEVEL SECURITY` on both tables, plus
    `CREATE POLICY extension_tokens_auth_all ON extension_tokens FOR ALL TO builderhunt_auth USING
    (true) WITH CHECK (true);` (the `0008_tenant_rls.sql` auth-broker shape) and the same for
    pairings. Then `REVOKE ALL ... FROM PUBLIC;` and
    `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE extension_tokens, extension_pairings TO
    builderhunt_auth;` — **no grant to `builderhunt_app`/`_worker`/`_platform`**, mirroring
    `auth_sessions` after `drizzle/0007_auth_broker.sql`. Regenerate
    `drizzle/migration-hashes.json` with `--write` and commit it.
  - Verify: `pnpm test:migration-integrity`; `pnpm test:migrations:local`; `pnpm test:rls:local`.

- [ ] **Prove the runtime roles cannot touch the credential tables**
  - Files: `scripts/db/verify-rls-local.mjs`
  - Do: Add negative checks — a direct `SELECT` on `extension_tokens` and on `extension_pairings` as
    `builderhunt_app` and as `builderhunt_worker` must fail with `42501`.
  - Verify: `pnpm test:rls:local` shows four new passing negatives.

- [ ] **Pure token mint/parse/verify helpers**
  - Files: `src/shared/lib/auth/extension-token.ts` (new), `…/extension-token.test.ts` (new)
  - Do: `mintExtensionToken()` → `{ id, secret, token, secretHash }` with
    `token = \`bhx_${id}.${base64url(randomBytes(32))}\``; `parseExtensionToken(header)` → strict
    regex or `null`; `extensionSecretMatches(secret, hash)` using `createHash('sha256')` +
    `timingSafeEqual`, exactly as `src/shared/lib/auth/cron.ts`'s `secretsMatch`; `mintPairingCode()`
    → 8 chars from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`.
  - Verify: `pnpm test extension-token` — malformed headers (`Bearer`, `bhx_`, no dot, two dots,
    wrong prefix), wrong-length secrets, and a mint→verify round trip.

- [ ] **Extension-token repository over `authDb`**
  - Files: `src/shared/lib/repositories/extension-tokens.ts` (new)
  - Do: `findExtensionTokenById`, `insertExtensionToken`, `touchExtensionToken` (only when
    `lastUsedAt` is null or > 5 min old), `revokeExtensionToken(id, reason)`,
    `listExtensionTokensForUser` (DTO: id, organizationId, label, clientVersion, createdAt,
    expiresAt, lastUsedAt — **never** `secretHash`), `countActiveExtensionTokens`, plus pairing CRUD
    (`insertPairing`, `findPairingByCodeHash`, `findPairingById`, `approvePairing`,
    `markPairingClaimed`, `deleteExpiredPairings`). Import `authDb`, never the global `db`.
  - Verify: `pnpm type-check`; `pnpm security:boundaries` after the allowlist task below.

- [ ] **Implement `requireExtensionPrincipal`**
  - Files: `src/shared/lib/auth/extension-principal.ts` (new), `…/extension-principal.test.ts` (new)
  - Do: Steps 1–7 of `spec.md` §Architecture 2, returning the `TenantPrincipal` type from
    `~/shared/lib/authorization/permissions` and throwing `TenantAuthorizationError` from
    `~/shared/lib/auth/tenant-principal`. Split into a pure `resolveExtensionPrincipal(request,
    dependencies)` with injected `{ findToken, findMembership, revoke, touch, now }` — the same split
    `resolveTenantPrincipal`/`requireTenantPrincipal` already use. On membership loss call
    `emitSecurityAudit({ action: 'extension.membership_check', result: 'denied', … },
    consoleSecurityAuditSink)` and revoke with `'membership_lost'`.
  - Verify: `pnpm test extension-principal` — no header (401), malformed (401), unknown id (401),
    wrong secret (401), revoked (401), expired (401), membership removed (403 **and** `revoke` called
    with `'membership_lost'`), role changed since mint (principal carries the current role),
    `EXTENSION_API_ENABLED=false` (503).

- [ ] **Register the new guard and authDb consumers with the boundary scripts**
  - Files: `scripts/check-route-coverage.mjs`, `scripts/check-tenant-boundaries.mjs`
  - Do: Add `{ name: 'extension', pattern: /requireExtensionPrincipal/ }` to `guardPatterns`; add
    `src/shared/lib/auth/extension-principal.ts` and
    `src/shared/lib/repositories/extension-tokens.ts` to `authDbAllowlist` with the rationale
    "token/pairing resolution happens before tenant context exists — same exception shape as
    `tenant-principal.ts`'s membership read".
  - Verify: `pnpm security:boundaries && pnpm security:route-coverage`.

- [ ] **Add the four env vars**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: `EXTENSION_API_ENABLED: z.enum(['true','false']).default('false')`,
    `EXTENSION_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(90)`,
    `EXTENSION_MIN_VERSION: z.string().default('0.0.0')`,
    `VITE_EXTENSION_STORE_URL: z.string().optional()`. Names only in `.env.example`, never values.
    Default-off, like `ENRICHMENT_ENABLED`.
  - Verify: `pnpm type-check`; the app boots with none set and `/api/extension/*` (Phase 2+) 503s.

## Phase 2 — Pairing flow + `/settings/extension`

- [ ] **`POST /api/extension/pair/start`**
  - Files: `src/routes/api/extension/pair/start.ts` (new), `scripts/check-route-coverage.mjs`
  - Do: Public. Body `{ verifierHash }` (64-hex). Rate limit `('extension-pair-start',
    getRateLimitId(request), 10, 600)`. Insert a `pending` pairing with `expiresAt: now + 5 min`, a
    fresh code and poll token (both stored hashed). Return
    `{ code, pollToken, expiresAt, pollIntervalMs: 5000 }` — no user or organization data. Add to
    `publicAllowlist` with the reason "creates only an unclaimed pairing row and returns no user
    data; the code+verifier pair is the credential, same shape as the feeds capability token".
  - Verify: `curl -X POST … -d '{"verifierHash":"<64hex>"}'` returns a code; the 11th call in 10
    minutes returns 429; `pnpm security:route-coverage` passes.

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
    `claimed` → 409. Add to `publicAllowlist` with the same reason as `start.ts`.
  - Verify: claim before approve → 202; claim twice → 409 with no token in the second body; a wrong
    `verifier` → 400 and both paths hash before comparing (no timing difference).

- [ ] **`GET|DELETE /api/extension/tokens`**
  - Files: `src/routes/api/extension/tokens.ts` (new)
  - Do: `requireTenantPrincipal`; rate limit `('extension-tokens', authedId, 30, 60)`. GET returns
    `listExtensionTokensForUser(principal.userId)` (account-subject data, scoped by `userId`, org
    names resolved through `~/shared/lib/organizations/contracts`). DELETE `?id=` revokes with
    `'user'` after asserting `row.userId === principal.userId`; a foreign id → 404, never 403.
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
  - Do: Render `ExtensionSettingsPanel` read-only (list + revoke, no pairing field) below
    `ActiveSessionsPanel`; add an "Extension" item to the user menu's settings group.
  - Verify: `/settings/security` shows both panels; `pnpm test` (UserMenu tests pass).

## Phase 3 — Read API

- [ ] **Pure profile-reference parser**
  - Files: `src/shared/lib/extension/profile-ref.ts` (new), `…/profile-ref.test.ts` (new)
  - Do: `parseGitHubProfilePath(pathname)` → `{ source: 'github'; username } | null`, matching
    `^/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))/?$` and rejecting GitHub's reserved paths (`settings`,
    `orgs`, `topics`, `marketplace`, `explore`, `notifications`, `pulls`, `issues`, `codespaces`,
    `sponsors`, `about`, `pricing`, `features`, `security`, `login`, `join`, `search`, `new`,
    `dashboard`, `apps`, `collections`, `trending`, `events`, `readme`). Export
    `GITHUB_RESERVED_PATHS` so extension and server share one list.
  - Verify: `pnpm test profile-ref` — `/torvalds` parses; `/torvalds/linux`, `/orgs/acme`,
    `/settings/profile`, `/` all return `null`.

- [ ] **Recency bands aligned with `score.ts`**
  - Files: `src/shared/lib/extension/recency.ts` (new), `…/recency.test.ts` (new)
  - Do: `recencyBandOf(timestampMs | null, nowMs)` → `today|week|month|quarter|year|stale|unknown`
    using **exactly** `src/lib/score.ts`'s cutoffs (< 1, < 7, < 30, < 90, < 365 days; null →
    unknown), with a comment pointing at `score.ts` so the two cannot drift.
  - Verify: `pnpm test recency` — boundaries at exactly 1/7/30/90/365 days, plus a `fast-check`
    property that the band is monotonic in age.

- [ ] **Profile and session DTO schemas**
  - Files: `src/shared/lib/extension/profile-dto.ts` (new), `…/profile-dto.test.ts` (new)
  - Do: `extensionProfileDto` from `spec.md` §Architecture 4 verbatim (`.strict()`), plus
    `extensionSessionDto` = `{ apiVersion, organization, user: { id, name }, tier, features }`.
    Export the inferred types.
  - Verify: `pnpm test profile-dto` — a fixture containing `secretHash`, `privateMetadata`, or
    `creatorUserId` fails to parse.

- [ ] **Add the functional username index the cross-source lookup needs**
  - Files: `drizzle/00NN+2_builder_identities_lower_username_idx.sql` (new), `drizzle/meta/*`,
    `drizzle/migration-hashes.json`
  - Do: Mint with `pnpm exec drizzle-kit generate --custom --name
    builder_identities_lower_username_idx` (a hand-created file is never journaled and never
    applied), body `CREATE INDEX IF NOT EXISTS builder_identities_lower_username_idx ON
    builder_identities (lower(username));`. The existing `builder_identities_source_username_idx` is
    `on (source, username)` and cannot serve `lower(username) = $1` with no `source` equality, and no
    functional index exists anywhere (`grep -rn "lower(" drizzle/*.sql` is empty). Header comment must
    record the operator alternative: if `builder_identities` exceeds ~1M rows in production, run
    `CREATE INDEX CONCURRENTLY` out-of-band before deploying (a drizzle migration runs in a
    transaction, so `CONCURRENTLY` cannot go in the file) — same operator-step shape as
    `semantic-search`'s Coolify pgvector swap. Additive, index-only: no column is added or altered.
  - Verify: `pnpm test:migration-integrity`; `pnpm test:migrations:local`; then
    `EXPLAIN ANALYZE SELECT … WHERE lower(username) = lower('torvalds') AND source <> 'github'`
    against a seeded local DB reports an **Index Scan** on the new index, not a Seq Scan.

- [ ] **Identity lookup repository**
  - Files: `src/shared/lib/repositories/builder-identity-lookup.ts` (new), `…test.ts` (new)
  - Do: `findIdentityBySourceUsername(source, username)` (equality on both columns, uses
    `builder_identities_source_username_idx`), `findIdentityBySourceId` (uses
    `builder_identities_source_source_id_unique`), `findCrossSourceUsernameMatches(username,
    excludeSource, limit = 8)` (`lower(username) = lower($1) AND source <> $2`, uses the new
    functional index), and `findSprintMatchesForIdentity(tx, organizationId, source, sourceId,
    limit = 3)` — a `sprint_results` → `sourcing_sprints` join returning `{ sprintId, name }`, run
    under `withTenantContext` because `builderhunt_app`'s access is `SELECT` + the org-scoped
    `sprint_results_app_select` policy and nothing more. `builder_identities` is `global-public` with
    `GRANT SELECT, INSERT, UPDATE … TO builderhunt_app` (`drizzle/0011_builder_claim_policies.sql`),
    so the first three read through the runtime client like `public-builders.ts`; no function may
    return a tenant column except the org-scoped sprint join.
  - Verify: `pnpm test builder-identity-lookup`; `pnpm security:boundaries` (add to
    `globalDbAllowlist` with the "global-public read, allowlisted columns only" reason if flagged).

- [ ] **`GET /api/extension/session`**
  - Files: `src/routes/api/extension/session.ts` (new)
  - Do: `requireExtensionPrincipal`; rate limit `('extension-session', authedId, 60, 60)`. Read the
    organization name via `~/shared/lib/organizations/contracts` and the tier via
    `getOrganizationEntitlement` + `resolveLegacyPlanTier` under `withTenantContext`. Return
    `extensionSessionDto` with `features` = `{ track: true, status: true, note: true }` (all three
    are app-role-owned writes; the object exists so the server can disable any of them without a
    store release). If `X-BH-Extension-Version` < `EXTENSION_MIN_VERSION` return
    `410 { error: 'extension_version_unsupported', minVersion }`.
  - Verify: `curl -H 'Authorization: Bearer <token>' …/api/extension/session` returns the bound
    organization's name and tier; setting `EXTENSION_MIN_VERSION=9.9.9` makes it 410.

- [ ] **`GET /api/extension/profile`**
  - Files: `src/routes/api/extension/profile.ts` (new)
  - Do: `requireExtensionPrincipal`; rate limit `('extension-lookup', authedId, 120, 60)`. Query
    `?source=github&username=` or `&sourceId=`, `source` validated against `SOURCE_NAMES`. Resolve
    the identity, then under `withTenantContext` call `findOrganizationBuilderBySource(tx,
    principal.organizationId, source, sourceId)`, `listOrganizationBuilderNotes` for the count, and
    `findSprintMatchesForIdentity` for `sprintMatches` (SELECT-only, org-scoped).
    `findActiveBuilderProcessingRestriction(identityId)` → `restricted: true` with optional fields
    nulled. Respond through `extensionProfileDto.parse(...)` with `Cache-Control: private,
    max-age=300` and an ETag over the serialized DTO, honouring `If-None-Match` with 304. Log
    `{ requestId, organizationId, source, known }` only — **never the username**. Zero external calls.
  - Verify: an unknown login returns `known: false` with no outbound request (assert with
    `GITHUB_TOKEN` unset); an identical second call returns 304; no username appears in the log.

- [ ] **Tenant A/B isolation cases for the read API**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Seed one `builder_identities` row tracked by tenant A only, plus one tenant-A
    `sourcing_sprints` + `sprint_results` row naming that identity, then call the real `profile.ts`
    handler with (a) A's extension token → `tracked` present and `sprintMatches` length 1, (b) B's
    token → same identity, `tracked: null`, no note count, **`sprintMatches: []`**, (c) no token →
    401, (d) A's token after deleting A's membership → 403 and the token row revoked, (e) a token
    whose organization was deleted → 401.
  - Verify: `pnpm test:api-isolation:local` — six new checks pass against the real non-owner roles,
    including the `sprint_results` SELECT succeeding as `builderhunt_app` under tenant context.

- [ ] **Assert no CORS surface was introduced**
  - Files: `test/security/http-security.test.ts`, `server/security.mjs`
  - Do: The two guard cases this plan depends on already exist ("adds no CORS surface" and
    "rejects an extension origin carrying a cookie") — added 2026-07-24 when the duplicated
    security helpers in `src/shared/lib/security/headers.ts` were collapsed into
    `server/security.mjs`, the module `server.prod.mjs` actually imports. Re-run them and confirm
    they still hold after this plan's API work; add a case for any new route that accepts a
    bearer token. Do NOT add an `Access-Control-Allow-*` header: the extension path works
    *without* cookies (`credentials: 'omit'` from the MV3 service worker), not by loosening the
    gate — see this plan's spec for why cookie+CORS is structurally unavailable.
  - Verify: `pnpm vitest run test/security/http-security.test.ts` — all cases pass, and
    `grep -ri "access-control-allow" server/ src/` returns nothing.

## Phase 4 — The MV3 extension package (read-only overlay)

- [ ] **Scaffold `extension/` as a non-workspace package**
  - Files: `extension/package.json` (new), `extension/tsconfig.json` (new),
    `extension/vite.config.ts` (new), `.dockerignore`, `eslint.config.js`, `tsconfig.json`
  - Do: Own `package.json` (private, own `vite` + `typescript`) and own lockfile — **do not** add a
    `packages:` key to `pnpm-workspace.yaml`. Vite multi-entry (`sw`, `content`, `popup`),
    `format: 'es'`, `target: 'es2022'`, no cross-entry chunking. Alias `@app` →
    `../src/shared/lib/extension`. Add `extension` to `.dockerignore`, `eslint.config.js` ignores,
    and root `tsconfig.json` excludes.
  - Verify: root `pnpm install --frozen-lockfile && pnpm type-check && pnpm lint && pnpm build` all
    pass and never touch `extension/`; `pnpm --dir extension build` emits `dist/sw.js`,
    `dist/content.js`, `dist/popup.js` with `grep -c eval dist/*.js` = 0.

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
  - Verify: `pnpm --dir extension pack --target=firefox` produces a zip that `web-ext lint` accepts,
    or that loads via `about:debugging`.

- [ ] **Compile-time host policy module**
  - Files: `extension/src/shared/host-policies.ts` (new), `…/host-policies.test.ts` (new)
  - Do: Mirror `src/lib/enrichment/policies.ts`'s shape — a frozen record of host policies,
    `HARD_BLOCKED_HOSTS = ['linkedin.com','x.com','facebook.com','instagram.com']`, and
    `assertHostAllowed(hostname)` which throws for anything not `enabled`. Import it at the top of
    `content.ts` so the overlay cannot run on a blocked host even if a future manifest edit added one.
  - Verify: `pnpm --dir extension test` — register entries and policies match both ways;
    `assertHostAllowed('www.linkedin.com')` throws.

- [ ] **Service worker: token store, cache, and all network I/O**
  - Files: `extension/src/sw.ts` (new), `extension/src/shared/api.ts` (new)
  - Do: `runtime.onMessage` handlers for `pair:start`, `pair:poll`, `profile:get`, `session:get`. All
    `fetch` calls use `credentials: 'omit'`, `Authorization: Bearer <token>`,
    `X-BH-Extension-Version` from `runtime.getManifest().version`, `X-BH-API-Version: 1`. Token in
    `storage.local`; LRU (200 entries, 5-min TTL, key `${source}:${username}:${orgId}`) in
    `storage.session` with an in-memory `Map` fallback. 401 clears the token and sets
    `needsReconnect`; 410 sets `needsUpdate`. One shim: `const api = globalThis.browser ?? globalThis.chrome`.
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
  - Files: `src/lib/extension/github-profile.ts` (new), `…/github-profile.test.ts` (new)
  - Do: `resolveGitHubProfile(login)` calling `GET https://api.github.com/users/{login}` with
    `env.GITHUB_TOKEN` when present, mapped to the shape `src/lib/sources/github.ts` produces
    (`sourceId: String(user.id)`, `profileUrl: user.html_url`, …). Assert the request host against
    the `github` policy's `allowedHosts` in `src/lib/enrichment/policies.ts`; rate limit
    `('extension-github-resolve', 'global', 20, 60)` to that policy's declared 20/min. Return `null`
    on 404/403/rate-limit — never throw into the route.
  - Verify: `pnpm test github-profile` with a mocked fetch — 404 → null; a non-`api.github.com` host
    throws before any fetch; the mapped `sourceId` is the numeric id.

- [ ] **`POST /api/extension/track`**
  - Files: `src/routes/api/extension/track.ts` (new)
  - Do: `requireExtensionPrincipal`; rate limit `('extension-track', authedId, 60, 3600)`. Body
    `{ source, username }` (or `sourceId`). Resolve display fields from `builder_identities` when
    known, else `resolveGitHubProfile`; 404 if unresolvable. Then replicate `/api/builders/track`'s
    sequence under `withTenantContext`: `getOrganizationEntitlement` → `countOrganizationBuilders` →
    `findOrganizationBuilderBySource` → `PLAN_LIMITS[resolveLegacyPlanTier(tier)].savedBuilders` gate
    (402, same body shape) → `trackOrganizationBuilder({ …, metadata: { origin: 'extension' } })`, and
    fire `upsertEmbeddingStubs([...]).catch(...)`. Return the fresh `extensionProfileDto`. Do **not**
    modify `/api/builders/track`.
  - Verify: `pnpm test:api-isolation:local` — tracking with A's token creates a row only in A; a
    free-tier org at 50 builders gets 402; `privateMetadata.origin === 'extension'`.

- [ ] **`POST /api/extension/note`**
  - Files: `src/routes/api/extension/note.ts` (new)
  - Do: `requireExtensionPrincipal`; rate limit `('extension-note', authedId, 60, 3600)`. Body
    `{ source, username, body: z.string().min(1).max(2000) }`. Resolve the tracking row via
    `findOrganizationBuilderBySource`; 404 when not tracked (notes require tracking, as in the web
    UI). `createOrganizationBuilderNote` under `withTenantContext`; return `{ noteCount }`.
  - Verify: isolation script — tenant B cannot note against tenant A's tracking row (404, not 403).

- [ ] **`POST /api/extension/status` (the "add to list" action)**
  - Files: `src/routes/api/extension/status.ts` (new),
    `src/shared/lib/repositories/organization-builders.ts`
  - Do: **Do not write `sprint_results`** — `withTenantContext` runs as `builderhunt_app`
    (`src/shared/lib/db/tenant-context.ts`) and `drizzle/0024_sourcing_sprints_grants.sql` grants that
    role only `SELECT` on that table (line 56, policy `sprint_results_app_select` at line 31); INSERT
    belongs to `builderhunt_worker`, and manual rows would also corrupt `sourcing_sprints.quota` /
    the `quotaHit → completed` transition in `src/lib/sprints/worker.ts`. See spec §8. Instead: add an
    additive `setOrganizationBuilderStatus(tx, organizationId, id, status)` to the existing
    repository (no existing caller changes; `organization_builders_status_check` already constrains
    the value and `drizzle/0008_tenant_rls.sql` already gives the app role UPDATE policy + grant).
    Route: `requireExtensionPrincipal`; rate limit `('extension-status', authedId, 60, 3600)`; body
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
  - Do: Add `'Browser extension (GitHub overlay)'` to `PLAN_PRICING.free.features` with a comment
    naming the one enforceable gate: `PLAN_LIMITS[tier].savedBuilders` on Track (Shortlist and Note
    only mutate an already-tracked row, so they need no separate gate). No new limit constant.
  - Verify: `pnpm test`; `/pricing` lists the bullet under Free.

- [ ] **Aggregate metrics, no browsing history**
  - Files: `src/routes/api/admin/metrics/index.ts`,
    `src/shared/lib/repositories/platform-extension-metrics.ts` (new)
  - Do: New repository beside `src/shared/lib/repositories/platform-billing.ts` (whose
    `getPlatformAccountMetrics` the metrics route already calls), reading
    `extension_tokens`/`extension_pairings` through `authDb` and `organization_builders` through
    `platformDb` from `../db/client` — the same two-connection pattern `platform-billing.ts` uses.
    Add it to `check-tenant-boundaries.mjs`'s `authDbAllowlist`. Aggregates: pairing counts by status
    over 30 days, a single count of `extension_tokens` with `lastUsedAt > now() - 7 days`, and a
    per-day count of `organization_builders` where `private_metadata->>'origin' = 'extension'` over
    30 days. No per-profile, per-username, or per-URL data anywhere.
  - Verify: the three fields appear for a platform admin; a non-admin gets 403;
    `pnpm test:api-isolation:local` still passes.

- [ ] **Sweep expired pairings on the existing worker**
  - Files: `src/routes/api/admin/legal/run-worker.ts`,
    `src/shared/lib/repositories/extension-tokens.ts`
  - Do: Add a `deleteExpiredPairings()` pass (`expires_at < now() - interval '1 day'`) to the existing
    legal run-worker's response as `{ pairingsSwept }`. Idempotent; no new endpoint, no new cron entry.
  - Verify: `curl -H "X-Cron-Secret: $CRON_SECRET" -X POST …/api/admin/legal/run-worker` returns
    `pairingsSwept`; a second run returns 0.

- [ ] **Extension release workflow**
  - Files: `.github/workflows/extension-release.yml` (new)
  - Do: Trigger on `push: tags: ['ext-v*']`. Mirror `.github/workflows/quality.yml`'s
    `pnpm/action-setup@v6` + `actions/setup-node@v7` (node 22), then
    `pnpm --dir extension install --frozen-lockfile`, build + pack both targets, attach
    `dist-chrome.zip` and `dist-firefox.zip` to the release. Header comment states that store upload
    is manual (the Chrome Web Store API needs OAuth client credentials that do not exist yet).
  - Verify: pushing `ext-v0.1.0-rc.1` on a branch produces both zips; `quality.yml` and `deploy.yml`
    are unaffected.

- [ ] **Store listing and compatibility contract docs**
  - Files: `extension/STORE_LISTING.md` (new), `docs/operations/extension-host-register.md`
  - Do: Write the single-purpose description, a justification per host permission, the
    limited-use/prominent-disclosure statement (matching `/legal/extension`), and the
    privacy-practices answers. Append the compatibility contract to the register: additive-only v1
    DTO, N/N-1 for 180 days, `features`-driven gating, `EXTENSION_MIN_VERSION` as the emergency stop.
  - Verify: every store privacy-practices question has a written answer; `STORE_LISTING.md` and
    `/legal/extension` say the same thing.

- [ ] **Decide `activityBand` and close the grant question**
  - Files: `scripts/db/verify-api-isolation-local.mjs`, `docs/architecture/data-classification.md`
  - Do: Confirm against the real `builderhunt_app` role that `builder_source_snapshots` is unreadable
    (no `drizzle/*.sql` grants it today), then either (a) leave `activityBand: 'unknown'` and record
    the deferral, or (b) add a narrow `GRANT SELECT ON builder_source_snapshots TO builderhunt_app`
    migration with a security-review note and populate the band from `payload->>'lastSeen'`. Do not
    guess — app-reality constraint 7 requires proving any newly-exercised path against the real role.
  - Verify: `pnpm test:api-isolation:local` — either the negative permission check passes (a) or the
    positive read passes as `builderhunt_app` (b).

- [ ] **Flip the flag in staging and run the full gate**
  - Files: `.env.example`
  - Do: Set `EXTENSION_API_ENABLED=true` in staging only; pair a store-signed build; run one Track,
    one Note, one sprint add; confirm the logs contain no username and no token.
  - Verify: `pnpm lint && pnpm type-check && pnpm test && pnpm test:rls:local &&
    pnpm test:api-isolation:local && pnpm security:boundaries && pnpm security:route-coverage &&
    pnpm build` all pass, plus a staging smoke of Phase 3's five threat cases.
