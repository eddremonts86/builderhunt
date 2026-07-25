# ATS Integrations (Greenhouse, Lever, Ashby) (plan)

> **Status**: `pending`
> **Depends on**: [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/plan.md) (hard — the pipeline stage model this plan maps external ATS status onto); [`security-and-multitenancy`](../../security-and-multitenancy/plan.md) (per-organization third-party credentials, RLS, tenant-scoped sync state); [`stripe-billing-platform`](../../stripe-billing-platform/plan.md) (the Team-tier gate this feature sells into does not bill anyone yet); [`legal-and-compliance`](../../legal-and-compliance/plan.md) (candidate data leaving the product to a third-party processor).
> **Blocks**: nothing
> **Reality check**: Builds on `src/shared/lib/billing/{provider.ts,fake-provider.ts,provider-contract-suite.ts}` (provider-contract pattern), `src/lib/enrichment/{registry.ts,worker.ts}` + `src/shared/lib/repositories/enrichment-worker.ts` (registry + lease/backoff worker), `src/shared/lib/repositories/billing-worker.ts` (cross-org sweep), `src/routes/api/admin/alerts/run-worker.ts` (worker route), `src/shared/lib/crypto/webhook-payload.ts` (the only AES-GCM code in the repo, explicitly not general-purpose). No ATS code and no reusable secret-at-rest helper exist today.

## Phases (dependency order — shippable after each)

### Phase 0 — Secret-at-rest foundation

The blocking prerequisite. Generalize `crypto/webhook-payload.ts` into
`src/shared/lib/crypto/secret-box.ts`: versioned `v1:iv:tag:ct` envelope, AAD bound to
`${organizationId}:${provider}`, `secretFingerprint`/`secretLast4`. Add
`ATS_INTEGRATIONS_ENABLED`, `ATS_ENABLED_PROVIDERS`, `ATS_CREDENTIAL_ENCRYPTION_KEY`
(+ `_PREVIOUS`) and the worker/export bounds to `env.ts`, failing closed in **every** environment
when the feature is enabled without a valid 64-hex key. Add `credential` to `log.ts`'s
`sensitiveKey` regex. Nothing user-visible; `webhook-payload.ts` keeps working untouched.

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
`stage-mapping.ts` + `stage-source.ts`. **Re-confirm each provider's auth/write model against live
vendor docs in this phase** and record the findings in a new
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
and neither this repo nor [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/plan.md) widens it, so
write-back cannot execute until a column-scoped `GRANT UPDATE (pipeline_stage,
pipeline_stage_changed_at, updated_at)` plus an org-scoped `FOR UPDATE` policy lands (spec.md §5).
Then `src/lib/ats/worker.ts` + `src/routes/api/admin/ats-sync/run-worker.ts` (clone of the alerts
worker route), `repositories/ats-worker.ts` with lease/claim/backoff, `GET /api/ats/sync-status`.
Applies the ATS-authoritative-for-mapped-stages rule to that plan's `pipeline_stage` /
`pipeline_stage_changed_at`. **Hard-blocked on those columns existing.** Add the cron entry next to
the alerts/discovery/enrichment crons.

### Phase 5 — UI, failure surface, notification, Ashby adapter

`/settings/integrations` page + `UserMenu` link, `AtsExportDialog` wired into `/me/builders`, the
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
| Untracking an exported builder 500s an existing route on an FK violation | Certain with a composite FK | High (breaks working behavior) | No FK from `ats_candidate_links`/`ats_export_events` to `organization_builders` — links anchor to `builder_identities`; `conflictState = 'untracked'`; regression task exercises untrack-after-export |
| Write-back overwrites a stage a recruiter just set by hand | Medium | Medium | ATS-authoritative only for stages that *resolve*; unmapped stages write nothing; provenance shown on every worker-written stage; worker never touches owner or notes |
| Custom/renamed stages make mapping stale silently | High | Low | `stale_local_stage` resolves to `unmapped`, surfaced with a count + one-click remap; no write, no error |
| One tenant's failing ATS blocks every other tenant's sync | Medium | High | One transaction per connection in its own org context; per-connection lease; per-connection `consecutiveFailureCount` + exponential `backoffUntil`; a thrown adapter error is caught per connection |
| Provider rate limits cause a retry storm | Medium | Medium | `rate_limited` stops that connection immediately, keeps the cursor, honours the provider's reset header; no in-loop retry; page cap per run |
| Candidate data reaches a third party for a restricted subject | Low | Critical | `builder_processing_restrictions` checked before `findCandidates`, before `createCandidate`, and again in the worker; `skipped_restricted` audit event; API-isolation test covers it |
| `hiring-pipeline-kanban` lands late or names its stage config differently | Medium | Medium | Single coupling point `stage-source.ts`; frozen default ladder fallback; Phases 1–3 ship export-only with no dependency on the new columns |
| Encryption key lost or rotated badly | Low | High | `v1:` envelope + `_PREVIOUS` overlap; documented explicit re-encrypt task; lost key degrades to `invalid_credentials` + operator re-entry, no escrow and no backdoor |
| Feature sells Team tier while Stripe bills nobody | Certain | Low | Gate reads `organization_entitlements.tier`, which manual provisioning already writes and Stripe's projection will write later — no code change at cutover |

## Rollback

- **Phases 0–2** are invisible: revert the `secret-box.ts`/`env.ts`/`log.ts` commits, drop the four
  tables (purely additive, nothing else references them), delete `src/lib/ats/`.
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
