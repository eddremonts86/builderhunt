# Browser Extension Overlay (plan)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../phase-1/01-security-and-multitenancy/spec.md) (a new authenticated client outside the app's cookie/CSRF assumptions); [`ai-expansion`](../../phase-1/20-ai-expansion/spec.md) (Chrome built-in AI is the local-first tier this surface sits closest to); [`ai-sourcing-sprints`](../../phase-1/40-ai-sourcing-sprints/spec.md) (the "add to sprint" action target — already shipped). Binding: [`ai-policy`](../../_meta/ai-policy.md), [`security-policy`](../../_meta/security-policy.md).
> **Blocks**: nothing
> **Reality check** (re-verified against `master` HEAD, 2026-07-27): Builds on `src/shared/lib/auth/tenant-principal.ts` (the `TenantPrincipal` contract the new bearer guard must return unchanged, including its newer `resolveEnforcementForUser` → `'blocked'` 403 step), `src/shared/lib/auth/cron.ts` (the only existing *header-bearer* principal — its sha256 + `timingSafeEqual` `secretsMatch` shape is reused), `src/lib/scheduling/capability.ts` + `capability-context.ts` (a second, accountless non-session principal on the dedicated `builderhunt_capability` role, `drizzle/0077`–`0078`, reconciled in spec §"The auth model" — this plan adds **no** new DB role), `src/shared/lib/repositories/organization-builders.ts` (`findOrganizationBuilderBySource:118`, `trackOrganizationBuilder:274`), `src/shared/lib/profile-suppression.ts` (`isSuppressed`, mandatory on every identity-surfacing path), `src/lib/enrichment/policies.ts:28` (`HARD_BLOCKED_CONNECTOR_IDS`), `server/security.mjs` (the single CSRF/headers gate `server.prod.mjs` imports at line 14; emits no `Access-Control-Allow-*`), and `drizzle/0044_abuse_usage_integrity_rls_grants.sql` (the RLS+grants migration template). No route today looks a builder up by `(source, sourceId)`. `builderhunt_app` has SELECT-only on `sprint_results` (`drizzle/0024_sourcing_sprints_grants.sql:31,56`), which is why the sprint relationship is read-only — spec §8. **Migration indices are never hardcoded**: `drizzle/meta/_journal.json` holds 86 entries at HEAD and moves; every migration task reads the next free index from it at execution time.

## Ordering against other plans

Land [`match-evidence-panel`](../match-evidence-panel/spec.md) **before** Phase 3. It refactors
`src/lib/score.ts` (adds `explainScore()`, reimplements `scoreBuilders` on top) and grants
`builder_source_snapshots` to `builderhunt_app` with a real writer. Phase 3's `recency.ts` reads
`score.ts`'s cutoffs, and Phase 6's `activityBand` decision is branch (a) or (b) depending on whether
that grant exists — see spec §4. Nothing else in `plans/phase-2/` touches this plan's surfaces.

## Phases (dependency order — shippable after each)

### Phase 0 — Host policy register + legal disclosure surface

No behavior ships. Write `docs/operations/extension-host-register.md` mirroring
`public-enrichment-source-register.md` field for field: `github` `enabled`, `linkedin`/`x`/
`facebook`/`instagram` `blocked` with the same permission references `policies.ts` already
cites. Add the `extension` consent document at `v1.0` to `src/shared/lib/legal.ts` **and**
`src/routes/api/consent/index.ts` (duplicated constant + zod enum), plus a `/legal/extension`
page. Record both new tables in `docs/architecture/data-classification.md` and the new guard in
`docs/architecture/authorization-matrix.md`. This phase is what makes the LinkedIn decision
reviewable before a single line of extension code exists.

### Phase 1 — Credential schema, RLS/grants, and `requireExtensionPrincipal`

`extension_tokens` (account-subject) + `extension_pairings` (system-operational) in
`schema.ts`; `pnpm db:generate`; a `--custom` companion migration for RLS + auth-only grants
modelled on `0044` (auth role only — explicitly nothing for `builderhunt_app`, `_worker`,
`_platform`, or `_capability`). Pure token mint/parse/verify helpers with tests. Repository via
`authDb`. `requireExtensionPrincipal` returning `TenantPrincipal`, including the enforcement-stage
check `requireTenantPrincipal` gained from `abuse-and-usage-integrity`. Wire the new guard into
`check-route-coverage.mjs` and the new repository into `check-tenant-boundaries.mjs`'s
`authDbAllowlist`. Still zero routes — dead but fully tested code, and the migration is
provable against the real non-owner roles.

### Phase 2 — Pairing flow + `/settings/extension`

`pair/start`, `pair/approve` (consent-gated, binds `principal.organizationId`), `pair/claim`
(one-shot token release), `GET|DELETE /api/extension/tokens`. New
`/settings/extension` page with the code field, the token list, and revoke; a `UserMenu` entry;
the token list also rendered on `/settings/security`. Shippable: a user can pair and revoke a
credential that currently reaches no data.

### Phase 3 — Read API

`src/shared/lib/extension/profile-ref.ts` (URL → `{ source, username }` + GitHub reserved-path
list, pure + tested), `recency.ts` (bands matching `src/lib/score.ts:42-46`'s 1/7/30/90/365 cutoffs),
`api-version.ts` (the compatibility-contract constants, spec §6), `profile-dto.ts` (the zod
allowlist). One `--custom` migration adding `builder_identities_lower_username_idx` — the existing
`(source, username)` index cannot serve the cross-source `lower(username)` lookup. `GET
/api/extension/session` and `GET /api/extension/profile` with rate limits, ETag, `private,
max-age=300`, the `sourcing_sprints`-leading `sprintMatches` join (spec §4 — no second index), the
`isSuppressed` filter, and the restricted-subject path. Extend `verify-api-isolation-local.mjs` with
tenant A/B cases for both routes. Shippable and curl-verifiable with no client at all.

### Phase 4 — The MV3 extension package (read-only overlay)

`extension/` as a non-workspace package: `manifest.json` (github + app host permissions only),
`manifest.firefox.json`, `sw.ts` (token store, LRU cache, all fetches), `content.ts` (Shadow-DOM
card, no DOM reading), `popup`, host-policy module with `HARD_BLOCKED_HOSTS`, Vite multi-entry
build, `pack.mjs`. Exclude `extension/` from the app's eslint/tsconfig/dockerignore. Shippable:
a real, useful read-only overlay.

### Phase 5 — Write actions

`POST /api/extension/track` (server-side GitHub resolution through the approved `github` policy
host check, existing `savedBuilders` gate, `privateMetadata.origin = 'extension'`),
`POST /api/extension/status` (`organization_builders.status = 'shortlisted'` via a new additive
`setOrganizationBuilderStatus()` helper — the app role already owns this table), and
`POST /api/extension/note`. **No `sprint_results` write**: `builderhunt_app` has SELECT-only on that
table and manual rows would corrupt `quota`/`completed` accounting — spec §8. Buttons wired in the
overlay behind the server's `features` object. Isolation-script cases for each write.

### Phase 6 — Gating, metrics, release pipeline, Firefox target

`PLAN_PRICING.free.features` bullet; `EXTENSION_MIN_VERSION` 410 path; **two** aggregate metrics on
`/api/admin/metrics` (pairings by status, active tokens — the tracked-with-`origin: 'extension'`
count is deferred because `builderhunt_platform` has no grant *or* policy on `organization_builders`,
spec §Success metrics); pairing-row sweep added to the existing legal run-worker;
`.github/workflows/extension-release.yml` on `ext-v*` tags; `extension/STORE_LISTING.md` with
the single-purpose and limited-use text; AMO build verified locally (submission deferred).

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Someone "fixes" the extension's 403s by relaxing `server/security.mjs`'s origin gate or adding `Access-Control-Allow-Origin` | Medium | Critical | Bearer-only, `credentials: 'omit'`, all fetches from the service worker (host-permission CORS exemption). `tests/unit/security/http-security.test.ts` already asserts both cases — "adds no CORS surface" (:68) and "rejects an extension origin carrying a cookie" for `chrome-extension://` *and* `moz-extension://` (:113-115). `isTrustedMutationOrigin` (`server/security.mjs:87`) passes cookieless requests through untouched, so nothing needs relaxing in the first place. |
| A new route writes to a table the app role has no grant for (the `sprint_results` case, found during review) | High | High | Every new write path names its table's grant + policy migration explicitly before it is written, and every write route gets a `verify-api-isolation-local.mjs` case run as the real non-owner role — `app-reality.md` constraint 7. Spec §8 records the one instance already caught. |
| Token bound to the wrong organization → write lands in the wrong tenant | Medium | Critical | Organization is server-set at mint from `principal.organizationId`; it is never a request field. Every response carries `organization.name`, rendered in the card header. Tenant A/B isolation cases per write route. |
| Chrome Web Store rejects or delists over host permissions | Medium | High | `github.com` only; no `<all_urls>`, no LinkedIn, no remote code; single-purpose description; future hosts via `optional_host_permissions`. Register decision recorded in Phase 0. |
| Old extension in the wild breaks against a newer API (review latency) | High | High | The five rules in spec §6, pinned as constants + a unit test in `src/shared/lib/extension/api-version.ts` rather than left as prose: additive-only within a major; `SUPPORTED_API_VERSIONS` never shrinks by less than 180 days and a missing header means `1` forever; `features` is a server field so capability changes need no store release; `EXTENSION_MIN_VERSION` is reserved for security stops; and a per-status degradation table defines "renders nothing" as the failure mode on `github.com`. Impact raised from Medium to High: this is the one class of breakage the server can cause unilaterally and the user cannot fix. |
| A second, redundant auth path is invented because the reviewer only knew about `cron.ts` | Medium | Medium | Spec §"The auth model" now names both existing non-session principals and states why neither is reused: `cron.ts` authenticates a machine with no tenant, `builderhunt_capability` authenticates an accountless subject against one invitation on a role with 41 scheduling-only grants. This plan adds **no DB role and no DB connection** — it resolves an ordinary `TenantPrincipal` through `authDb` and hands it to the ordinary `withTenantContext`. Any PR that adds `DATABASE_EXTENSION_URL` or a `builderhunt_extension` role has misread the plan. |
| A per-pageview read turns out to be a sequential scan | High | High | Two lookups run on every profile view. The `lower(username)` cross-source query has no index at HEAD (`grep -n "lower(" drizzle/*.sql` is empty) and gets a dedicated functional index in Phase 3. The `sprintMatches` lookup **also** had no usable index — `sprint_results` indexes both lead with `sprint_id` — and is fixed by query shape instead (lead with the org's ≤10 sprints, nested-loop into `sprint_results_sprint_source_unique`), so no second index is added. Phase 3 requires `EXPLAIN ANALYZE` evidence of an Index Scan for **both** before it is done. |
| A new route surfaces a subject who filed a verified profile-removal request | Medium | Critical | `isSuppressed(source, sourceId)` on both the read and the Track write, returning `known: false` / 404 — indistinguishable from never-seen, so the removal itself is not leakable. This was missing from the first draft and is the same omission `profile-suppression.ts`'s header comment exists to prevent. |
| A growth metric is built on a cross-tenant read the platform role cannot legally do | Medium | Medium | `builderhunt_platform` has no grant and no policy on `organization_builders`; `/api/admin/metrics` already hardcodes `totalBuilders: null` for that reason. Phase 6 ships only the auth-role-legal aggregates and records the third as deferred rather than granting a cross-tenant read for a vanity number. |
| Accidental browsing-history harvest | Medium | High | Profile-root URLs only, never list pages; indexed Postgres reads only and zero external calls on lookup (cost is the row above); 5-min SW cache in `storage.session`, so nothing about browsing lands on disk; 120/min rate limit keyed `userId:organizationId`, never the profile; the username is never logged. |
| `extension_tokens` accidentally granted to `builderhunt_app` in a later migration | Low | High | Six negatives in `scripts/db/verify-rls-local.mjs` (`pnpm test:rls:local`): a direct SELECT on each table must fail `42501` as `builderhunt_app`, `builderhunt_worker` **and** `builderhunt_capability`. There is no `tests/unit/security/database-roles.test.ts` at HEAD — the directory holds `http-security`, `restore-roles-bootstrap`, `billing-tenant-isolation` and three team specs — so the local-RLS script is the whole assertion, not a second line of defence. |
| Token exfiltrated from `storage.local` by local filesystem access | Low | Medium | Org-scoped, 90-day expiry, one active token per (user, org), self-serve revoke, membership re-check on every request, `EXTENSION_API_ENABLED` kill switch. |
| `extension/` build creeping into the app's install/build/CI | Medium | Medium | Separate `package.json` + lockfile, not a pnpm workspace package (`pnpm-workspace.yaml` has no `packages:` key and must not gain one); added to `eslint.config.js:7`'s `ignores` and to `.dockerignore`. **No `tsconfig.json` change** — its `include` is already `["src/**/*", "*.ts"]`, so `extension/` is outside the program by construction and an `exclude` entry would be a misleading no-op. Because the repo root is still a workspace root, every `extension/` pnpm command uses `--ignore-workspace`. App CI never runs the extension build. |
| Pairing code brute-forced or replayed | Low | High | ~40 bits, 5-min expiry, single use, hashed at rest, per-IP start limit, per-pairing claim limit, and the extension-held `verifier` also required. |
| `activityBand` silently faked from `lastSeenAt` | Medium | Low | Two distinct DTO fields; `activityBand` returns `'unknown'` in v1 because `builder_source_snapshots` still has no runtime-role grant and no runtime writer (re-verified at HEAD). Documented, not papered over. This plan does **not** add the grant — [`match-evidence-panel`](../match-evidence-panel/spec.md) owns it, together with the writer that would make the table non-empty; Phase 6's task branches on whether that has landed. |

## Rollback

- **Phases 0–1** are invisible: revert the docs/consent commit; drop `extension_tokens` and
  `extension_pairings` (two additive tables, no existing table altered) and remove the guard.
- **Phase 2–3**: set `EXTENSION_API_ENABLED=false` → every `/api/extension/*` route 503s
  immediately with no deploy; `/settings/extension` hides behind the same flag. Existing routes
  are untouched throughout, so the web app cannot regress.
- **Phase 4–6**: unpublish the store listing (extension stops being installed, existing installs
  degrade to a silent no-op once the API flag is off); or set `EXTENSION_MIN_VERSION` above every
  shipped version to force the "update required" state; or revoke all tokens with
  `UPDATE extension_tokens SET revoked_at = now(), revoked_reason = 'rotated' WHERE revoked_at IS NULL`
  (auth role, one statement) to cut access without touching the app.
- No migration in this plan adds, alters, or drops a column on an existing table, and none changes a
  grant or policy on an existing table. The only DDL touching an existing table is the additive
  `builder_identities_lower_username_idx`, which is safe to `DROP INDEX` at any time — the query
  degrades to a sequential scan, nothing breaks. So a rollback never needs a backfill or a
  contraction step.
