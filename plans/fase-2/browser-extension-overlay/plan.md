# Browser Extension Overlay (plan)

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../security-and-multitenancy/spec.md) (a new authenticated client outside the app's cookie/CSRF assumptions); [`ai-expansion`](../../ai-expansion/spec.md) (Chrome built-in AI is the local-first tier this surface sits closest to); [`ai-sourcing-sprints`](../../ai-sourcing-sprints/spec.md) (the "add to sprint" action target — already shipped). Binding: [`ai-policy`](../../_meta/ai-policy.md), [`security-policy`](../../_meta/security-policy.md).
> **Blocks**: nothing
> **Reality check**: Builds on `src/shared/lib/auth/tenant-principal.ts` (the `TenantPrincipal` contract the new bearer guard must return unchanged), `src/shared/lib/auth/cron.ts` (the only existing bearer-token principal — its sha256 + `timingSafeEqual` shape is reused), `src/shared/lib/repositories/organization-builders.ts` (`findOrganizationBuilderBySource`, `trackOrganizationBuilder`), `src/lib/enrichment/policies.ts` (`HARD_BLOCKED_CONNECTOR_IDS`), `server/security.mjs` (the single CSRF/headers gate `server.prod.mjs` imports; emits no `Access-Control-Allow-*`), and `drizzle/0044_abuse_usage_integrity_rls_grants.sql` (the RLS+grants migration template). No route today looks a builder up by `(source, sourceId)`. `builderhunt_app` has SELECT-only on `sprint_results` (`drizzle/0024_sourcing_sprints_grants.sql:31,56`), which is why the sprint relationship is read-only — spec §8.

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
`schema.ts`; `pnpm db:generate`; a hand-written companion migration for RLS + auth-only grants
modelled on `0044`. Pure token mint/parse/verify helpers with tests. Repository via `authDb`.
`requireExtensionPrincipal` returning `TenantPrincipal`. Wire the new guard into
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
list, pure + tested), `recency.ts` (bands matching `src/lib/score.ts`'s 1/7/30/90/365 cutoffs),
`profile-dto.ts` (the zod allowlist). One `--custom` migration adding
`builder_identities_lower_username_idx` — the existing `(source, username)` index cannot serve the
cross-source `lower(username)` lookup. `GET /api/extension/session` and `GET /api/extension/profile`
with rate limits, ETag, `private, max-age=300`, the read-only `sprintMatches` join, and the
restricted-subject path. Extend `verify-api-isolation-local.mjs` with tenant A/B cases for both
routes. Shippable and curl-verifiable with no client at all.

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

`PLAN_PRICING.free.features` bullet; `EXTENSION_MIN_VERSION` 410 path; the three aggregate
metrics on `/api/admin/metrics`; pairing-row sweep added to the existing legal run-worker;
`.github/workflows/extension-release.yml` on `ext-v*` tags; `extension/STORE_LISTING.md` with
the single-purpose and limited-use text; AMO build verified locally (submission deferred).

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Someone "fixes" the extension's 403s by relaxing `server/security.mjs`'s origin gate or adding `Access-Control-Allow-Origin` | Medium | Critical | Bearer-only, `credentials: 'omit'`, all fetches from the service worker (host-permission CORS exemption). `test/security/http-security.test.ts` already asserts no `Access-Control-Allow-*` header is emitted and that an extension origin carrying a cookie is rejected. |
| A new route writes to a table the app role has no grant for (the `sprint_results` case, found during review) | High | High | Every new write path names its table's grant + policy migration explicitly before it is written, and every write route gets a `verify-api-isolation-local.mjs` case run as the real non-owner role — `app-reality.md` constraint 7. Spec §8 records the one instance already caught. |
| Token bound to the wrong organization → write lands in the wrong tenant | Medium | Critical | Organization is server-set at mint from `principal.organizationId`; it is never a request field. Every response carries `organization.name`, rendered in the card header. Tenant A/B isolation cases per write route. |
| Chrome Web Store rejects or delists over host permissions | Medium | High | `github.com` only; no `<all_urls>`, no LinkedIn, no remote code; single-purpose description; future hosts via `optional_host_permissions`. Register decision recorded in Phase 0. |
| Old extension in the wild breaks against a newer API (review latency) | High | Medium | Additive-only v1 DTO, N/N-1 support for 180 days, server-side `features` gating, `EXTENSION_MIN_VERSION` as the emergency stop. |
| Per-pageview lookup cost / accidental browsing-history harvest | Medium | High | Profile-root URLs only, never list pages; one indexed Postgres read, zero external calls on lookup; 5-min SW cache in `storage.session`; 120/min rate limit; username never logged. |
| `extension_tokens` accidentally granted to `builderhunt_app` in a later migration | Low | High | Auth-role-only grants asserted by `verify-rls-local.mjs` (a `builderhunt_app` SELECT must fail) and by a `security/database-roles` test. |
| Token exfiltrated from `storage.local` by local filesystem access | Low | Medium | Org-scoped, 90-day expiry, one active token per (user, org), self-serve revoke, membership re-check on every request, `EXTENSION_API_ENABLED` kill switch. |
| `extension/` build creeping into the app's install/build/CI | Medium | Medium | Separate `package.json` + lockfile, not a pnpm workspace package; excluded from `tsconfig.json`, `eslint.config.js`, `.dockerignore`; app CI never runs the extension build. |
| Pairing code brute-forced or replayed | Low | High | ~40 bits, 5-min expiry, single use, hashed at rest, per-IP start limit, per-pairing claim limit, and the extension-held `verifier` also required. |
| `activityBand` silently faked from `lastSeenAt` | Medium | Low | Two distinct DTO fields; `activityBand` returns `'unknown'` in v1 because `builder_source_snapshots` has no runtime-role grant. Documented, not papered over. |

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
- No migration in this plan adds, alters, or drops a column on an existing table. The only DDL
  touching an existing table is the additive `builder_identities_lower_username_idx`, which is safe
  to `DROP INDEX` at any time — the query degrades to a sequential scan, nothing breaks. So a
  rollback never needs a backfill or a contraction step.
