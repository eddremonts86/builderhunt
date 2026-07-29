# ATS Integrations (Greenhouse, Lever, Ashby) (plan)

> **Status**: `pending`
> **Depends on**: [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/plan.md) (hard — the pipeline stage model this plan maps external ATS status onto); [`security-and-multitenancy`](../../phase-1/01-security-and-multitenancy/plan.md) (per-organization third-party credentials, RLS, tenant-scoped sync state); [`stripe-billing-platform`](../../phase-1/30-stripe-billing-platform/plan.md) (the Team-tier gate this feature sells into does not bill anyone yet); [`legal-and-compliance`](../../phase-1/04-legal-and-compliance/plan.md) (candidate data leaving the product to a third-party processor).
> **Blocks**: nothing
> **Reality check**: Builds on `src/shared/lib/billing/{provider.ts,fake-provider.ts,provider-contract-suite.ts}` (provider-contract pattern), `src/lib/enrichment/{registry.ts,worker.ts}` + `src/shared/lib/repositories/enrichment-worker.ts` (registry + lease/backoff worker), `src/shared/lib/repositories/billing-worker.ts` (cross-org sweep), `src/routes/api/admin/alerts/run-worker.ts` (worker route), `src/shared/lib/crypto/webhook-payload.ts` (the only AES-GCM code in the repo, explicitly not general-purpose). No ATS code and no reusable secret-at-rest helper exist today. Phase 4 writes stages exclusively through [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/plan.md)'s `moveBuilderStage(..., { source: 'ats' })`, and navigation goes in `src/modules/dashboard/ui/shell/nav-config.ts` — the shell, not `UserMenu.tsx`.

## Phases (dependency order — shippable after each)

### Phase 0 — Secret-at-rest foundation

**Independently shippable, and worth shipping alone.** Phase 0 touches four files
(`crypto/secret-box.ts` new, `env.ts`, `log.ts`, `.env.example`) plus three test files. It adds no
table, no migration, no route, no UI, and no dependency on
[`hiring-pipeline-kanban`](../hiring-pipeline-kanban/plan.md) or on any other phase of this plan. It
can therefore merge to `master` on its own even if the rest of ATS is never built, and the next
feature that needs a per-tenant third-party credential inherits a reviewed helper instead of
inventing a fifth one.

Generalize `crypto/webhook-payload.ts` into `src/shared/lib/crypto/secret-box.ts`: versioned
`v1:iv:tag:ct` envelope, AAD bound to a caller-supplied context string,
`secretFingerprint`/`secretLast4`. Add `ATS_INTEGRATIONS_ENABLED`, `ATS_ENABLED_PROVIDERS`,
`ATS_CREDENTIAL_ENCRYPTION_KEY` (+ `_PREVIOUS`) and the worker/export bounds to `env.ts`, failing
closed in **every** environment when the feature is enabled without a valid 64-hex key. Add
`credential` to `log.ts`'s `sensitiveKey` regex.

**Exit criteria (all four must hold before the phase is called done):**

1. `pnpm test -- tests/unit/shared/lib/crypto/secret-box.test.ts`, `… env.security.test.ts` and
   `… log.test.ts` are green, including the cross-context transplant case and the previous-key
   overlap case.
2. `pnpm type-check`, `pnpm lint` and `pnpm build` pass with `ATS_INTEGRATIONS_ENABLED` unset —
   i.e. the defaults leave the whole feature off and raise no env error.
3. `src/shared/lib/crypto/webhook-payload.ts` is byte-identical to its pre-phase state and Stripe's
   `git diff` is empty for `src/shared/lib/billing/**` — the separation is the point of the phase.
4. Nothing user-visible changed: no new route, no nav entry, no migration in `drizzle/`.

### Phase 1 — Schema, RLS, grants, classification

Add `ats_connections`, `ats_candidate_links`, `ats_export_events`, `ats_sync_state` to `schema.ts`,
generate the migration, then hand-append a second RLS+grants migration mirroring
`drizzle/0044_abuse_usage_integrity_rls_grants.sql` — including the column-level `UPDATE` grant for
`builderhunt_worker` and the column-level `SELECT` grant that denies `builderhunt_platform` the
ciphertext. Update `docs/architecture/data-classification.md` and
`docs/architecture/authorization-matrix.md`. Four dead tables; app behavior unchanged.

### Phase 2 — Provider contract, deterministic fake, contract suite, stage mapping

`src/lib/ats/provider.ts` (interface + `AtsProviderError` + payload allowlist),
`fake-provider.ts` (deterministic, scenario-switchable), `provider-contract-suite.ts` (the shared
vitest suite every adapter must pass), `registry.ts` (`ATS_ENABLED_PROVIDERS`-gated),
and `stage-mapping.ts` (pure — `knownLocalStageKeys` is an input, so this phase has **no** dependency
on the sibling plan; `stage-source.ts` moved to Phase 4, where that plan's
`organization_pipeline_stages` table actually exists). **Re-confirm each provider's auth/write model
against live vendor docs in this phase** and record the findings in a new
`docs/operations/ats-provider-register.md`. Pure logic + tests only; no network, no routes, no
credentials in CI.

### Phase 3 — Credentials + export path (Greenhouse adapter)

`greenhouse.ts` adapter (Basic auth, `On-Behalf-Of` on writes), the tenant repository
(`src/shared/lib/repositories/ats.ts`), the `can()` additions, the `ATS_CONNECTION_LIMITS` tier
gate, and the routes: connections CRUD + verify, `POST /api/ats/exports/preview` (dedup + restriction
preview, no writes), `POST /api/ats/exports` (create/link/skip, restriction gate, audit events).
**Shippable and valuable on its own**: one-way export with dedup, no write-back yet.

### Phase 4 — Status write-back worker

Opens with the **prerequisite grant migration**: `builderhunt_worker` today holds only
`GRANT SELECT ON TABLE organization_builders` (`drizzle/0018_enrichment_worker_target_access.sql`)
and nothing since widens it, while [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/plan.md)
grants the worker only `SELECT` on its two new tables. So write-back cannot execute until *both* a
column-scoped `GRANT UPDATE (pipeline_stage, pipeline_stage_changed_at, updated_at)` with an
org-scoped `FOR UPDATE` policy **and** an `INSERT`-only grant + policy on
`organization_builder_stage_events` land (spec.md §5). Then `src/lib/ats/stage-source.ts`,
`src/lib/ats/worker.ts` + `src/routes/api/admin/ats-sync/run-worker.ts` (clone of the alerts worker
route, including its `withJobRun` wrapper), `repositories/ats-worker.ts` with lease/claim/backoff,
`GET /api/ats/sync-status`. Every stage change goes through the sibling plan's
`moveBuilderStage(..., { source: 'ats' })` — never a direct column write — so the append-only stage
history stays complete. **Hard-blocked on that plan's tables and columns existing.** Register the
job in `OPERATIONAL_SCHEDULES` and add the runbook row next to the alerts/discovery/enrichment crons.

### Phase 5 — UI, failure surface, notification, Ashby adapter

`/settings/integrations` page + the `nav-config.ts` workspace-area entry (the shell owns navigation;
`UserMenu.tsx` has no settings list), `AtsExportDialog` wired into `/exports`, the
pipeline board and sprint results, the mapping editor, provenance chips,
`sendAtsConnectionFailureEmail` + the `failureNotifiedAt` dedup, and the Ashby adapter (same
credential model, so it lands against the finished contract suite with no interface change).
`legal-and-compliance`'s processor list and `PLAN_PRICING.team.features` updated here.

### Phase 6 — Lever (deliberately last)

Lever's customer-facing path is OAuth 2.0 authorization-code, i.e. a **second credential model**
(redirect URIs, refresh-token storage and rotation, per-tenant token lifecycle). Scoped as its own
phase so it cannot destabilize the two API-key providers. Basic-auth-only Lever support may ship
first as an interim step if a design-partner asks for it.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| A tenant's ATS credential leaks through a DTO, log line, or error message | Medium | Critical | Write-only column + boundary test allowlisting the only files permitted to reference `credential_ciphertext`; `credential` added to `log.ts` redaction; column-level `SELECT` denies `builderhunt_platform` the ciphertext; negative assertions in `verify-api-isolation-local.mjs` |
| BuilderHunt creates duplicate candidates in a customer's ATS | High without §4 | High (trust-ending) | Profile-URL exact match before every create; `probable` matches never auto-linked; unique `(organizationId, connectionId, builderIdentityId)`; never PATCH an existing ATS record |
| Provider API facts asserted here are wrong or have changed | Medium | Medium | Phase 2 re-confirms each auth/write model against live docs before the adapter is written, recorded in `docs/operations/ats-provider-register.md`; the fake provider + contract suite mean a wrong assumption breaks one adapter, not the design |
| Write-back silently no-ops because `builderhunt_worker` cannot `UPDATE organization_builders` | Certain without the Phase 4 grant | Critical (the feature's whole point) | Phase 4's own column-scoped `GRANT UPDATE` + `FOR UPDATE` policy migration, ordered after the sibling's column migration, proven by `pnpm test:api-isolation:local` as the real worker role per `app-reality.md` constraint 7 |
| Write-back throws `permission denied` on the *history* table even after the column grant lands | Certain without the second grant | Critical | The sibling plan grants `builderhunt_worker` only `SELECT` on `organization_builder_stage_events` (verified in its tasks.md), but `moveBuilderStage` inserts one event per move. Phase 4's migration adds an `INSERT`-only grant + `WITH CHECK` policy in the same file as the column grant, so the two can never ship apart |
| ATS write-back bypasses `moveBuilderStage` and the stage history loses every ATS transition | Medium (it is the shorter path) | High — the outcome labels this feature exists to produce would be invisible to the board's own history | The sibling plan states the contract (`source: 'ats'` is already in its check constraint); this plan's worker repository calls `moveBuilderStage` and its test asserts exactly one `organization_builder_stage_events` row per applied stage. The column-scoped grant is deliberately narrow enough that a hand-rolled write still works — the test, not the grant, is the guard here |
| A new `onDelete: 'restrict'` reference to `auth_users` makes accounts permanently undeletable | Certain without the fix | High, and silent — the original instance failed only in a swallowed worker log | Three such columns are added (`ats_connections.created_by_user_id`, `ats_candidate_links.created_by_user_id`, `ats_export_events.actor_user_id`). `hardDeleteAccountSubject` reassigns all three to `DELETED_USER_SENTINEL_ID` in the same per-membership transaction that already handles `organization_builders`, and `checkLegalRunWorker` in `verify-api-isolation-local.mjs` regression-tests it — the same check that found the original |
| Synthesized `topics` reaches a customer's ATS as if it were an assessment | High if transmitted by default | High (a fabricated skill list in a permanent hiring record) | `app-reality.md` constraint 8: `hn.ts` sets `topics` to the operator's query keywords. `topics` is opt-in per connection alongside `bio`/`location`, sourced explicitly from `organization_builders.private_metadata.topics`, and named with its provenance in the disclosure |
| A suppressed profile is exported because only `builder_processing_restrictions` was checked | Medium | High | `filterSuppressed` on both export routes and `isSuppressed` in the worker — the same enforcement surface `GET /api/export/builders` already honours and that `profile-suppression.ts`'s own doc comment names as mandatory for exports |
| Untracking an exported builder 500s an existing route on an FK violation | Certain with a composite FK | High (breaks working behavior) | No FK from `ats_candidate_links`/`ats_export_events` to `organization_builders` — links anchor to `builder_identities`; `conflictState = 'untracked'`; regression task exercises untrack-after-export |
| Write-back overwrites a stage a recruiter just set by hand | Medium | Medium | ATS-authoritative only for stages that *resolve*; unmapped stages write nothing; provenance shown on every worker-written stage; worker never touches owner or notes |
| Custom/renamed stages make mapping stale silently | High | Low | `stale_local_stage` resolves to `unmapped`, surfaced with a count + one-click remap; no write, no error |
| One tenant's failing ATS blocks every other tenant's sync | Medium | High | One transaction per connection in its own org context; per-connection lease; per-connection `consecutiveFailureCount` + exponential `backoffUntil`; a thrown adapter error is caught per connection |
| Provider rate limits cause a retry storm | Medium | Medium | `rate_limited` stops that connection immediately, keeps the cursor, honours the provider's reset header; no in-loop retry; page cap per run |
| Candidate data reaches a third party for a restricted subject | Low | Critical | `builder_processing_restrictions` checked before `findCandidates`, before `createCandidate`, and again in the worker; `skipped_restricted` audit event; API-isolation test covers it |
| `hiring-pipeline-kanban` lands late or names its stage config differently | Medium | Medium | Single coupling point `stage-source.ts`, deferred to Phase 4 so nothing earlier can fail to compile; `resolveExternalStage` takes `knownLocalStageKeys` as a plain input, so Phases 0–3 ship export-only with zero reference to that plan's schema. The earlier "frozen default ladder" fallback was removed — the sibling seeds its own defaults and enforces the key set with an FK, so a duplicate ladder here could only drift |
| Encryption key lost or rotated badly | Low | High | `v1:` envelope + `_PREVIOUS` overlap; documented explicit re-encrypt task; lost key degrades to `invalid_credentials` + operator re-entry, no escrow and no backdoor |
| Feature sells Team tier while Stripe bills nobody | Certain | Low | Gate reads `organization_entitlements.tier`, which manual provisioning already writes and Stripe's projection will write later — no code change at cutover |

## Rollback

- **Phase 0 alone** reverts by deleting `src/shared/lib/crypto/secret-box.ts` and its test and
  reverting the additive `env.ts`/`log.ts`/`.env.example` hunks. Nothing else in the repo imports it,
  so the revert is a clean `git revert` of one commit.
- **Phases 0–2** are invisible: revert the above, drop the four tables (purely additive, nothing else
  references them), delete `src/lib/ats/`.
  `crypto/webhook-payload.ts` and Stripe billing are untouched throughout.
- **Phase 3+ without a schema change**: set `ATS_INTEGRATIONS_ENABLED=false`. Routes 503, the
  settings tab disappears, the worker no-ops, existing links and audit rows are preserved and inert.
  Narrower kill: remove a provider from `ATS_ENABLED_PROVIDERS`.
- **Phase 4 only**: stop the cron. Exports keep working; stages simply stop updating. Because the
  worker owns only `pipeline_stage` / `pipeline_stage_changed_at` and records provenance, a bad sync
  is auditable and manually correctable from `ats_candidate_links` — no local data is destroyed.
- **Full teardown**: dropping the tables cannot un-send data already transmitted to a customer's ATS,
  which is exactly why every export is an explicit, disclosed, audited human action rather than an
  automatic background sync.
