# Availability Signals (Open-to-Work Score) (plan)

> **Status**: `pending`
> **Depends on**: [`abuse-and-usage-integrity`](../../phase-1/32-abuse-and-usage-integrity/spec.md) (the decayed combined-signal scoring mechanics this plan reuses); [`claimable-profiles`](../../phase-1/36-claimable-profiles/spec.md) (a subject's explicit open-to-work state always outranks inference); [`legal-and-compliance`](../../phase-1/04-legal-and-compliance/spec.md) (inference about named individuals must be disclosed and contestable). Binding: [`security-policy`](../../_meta/security-policy.md), [`ai-policy`](../../_meta/ai-policy.md), [`conventions`](../../_meta/conventions.md).
> **Blocks**: nothing
> **Reality check**: The decay engine is shipped code (`src/shared/lib/abuse/risk.ts`, `drizzle/0043`–`0045`), the suppression mechanism is shipped (`builder_processing_restrictions`, `is_builder_processing_restricted`, `POST /api/me/builder/$builderId/restrict-processing` → `cascadeBuilderProcessingRestriction` at `src/lib/enrichment/worker.ts:206`), and the subject's own availability state is shipped (`published_builder_profiles.open_to_status`, `src/shared/lib/db/schema.ts:289`). `builder_source_snapshots` exists but still has **no runtime writer and no non-owner grants** at HEAD, so bio history must be created before any change-detection signal can work. An unrelated tenant-private "availability" domain (`availability_rules`/`availability_policies`/`availability_overrides`, `drizzle/0069`–`0071`) shipped after this plan was drafted — see `spec.md` §Naming for the prefixes that keep the two apart.

## Phases (dependency order — shippable after each)

### Phase 0 — Bio history: snapshot write path + grants

Nothing in the runtime can write `builder_source_snapshots` today (single caller is the one-shot
owner-role backfill `scripts/db/backfills/builders.ts:110`; zero grants for `builderhunt_app`/
`builderhunt_worker` in any of the 86 migrations, re-verified at HEAD). This phase makes bio history
exist, independent of any scoring: a grants migration, a `recordBuilderSourceSnapshot()` repository
call fired from `trackOrganizationBuilder`, content-hash idempotency (the existing
`(builder_identity_id, content_hash)` unique index already gives it), and a bounded per-identity
retention trim (`BUILDER_SNAPSHOT_KEEP`, 8).

Shippable value on its own: `builder_source_snapshots` finally does what its schema comment claims,
and `pnpm test:api-isolation:local` proves the app role can actually write it. Signal S3 needs two
distinct snapshots ≥7 days apart before it can ever fire.

**Cross-plan note before you start**: three other phase-2 plans currently document
`builder_source_snapshots` as unusable *because* of this gap — `browser-extension-overlay`
(`tasks.md:507-509` proposes its own `GRANT SELECT` and defers `activityBand` to `'unknown'`),
`match-evidence-panel` (`plan.md:6`), and `talent-market-intelligence` (`spec.md:83`). This phase
lands the grant once; those plans must consume it rather than mint a second grants migration.

### Phase 1 — Pure engine: shared decay primitive, detectors, precedence

No persistence, no routes. Extract **only** `decayedSum()` into `src/shared/lib/signal-decay.ts` (new),
make `src/shared/lib/abuse/risk.ts` delegate to it with `risk.test.ts` left byte-unchanged as the
no-behaviour-change proof, then build `src/shared/lib/availability-signals/{signals,score,disclosure}.ts`
with their own weights, thresholds, phrase/negation allowlists, source allowlist, and the five-rule
precedence resolver. Every file is pure and has a sibling test under `tests/unit/shared/lib/…`,
including the invariant test "no input can produce an inferred bucket that contradicts a non-empty
`open_to_status`".

The corroboration cap is **not** extracted — see `spec.md` §Reuse vs. new for why generalising a
two-line ternary out of a live anti-abuse escalation path was rejected.

Shippable value: the verdict logic is fully proven before a single row of data about a real person
is stored anywhere.

### Phase 2 — Schema, grants, data classification

Three tables (`builder_availability_signals`, `builder_availability_scores`,
`builder_availability_refresh_queue`), generated with `pnpm db:generate`, plus a hand-written grants
migration minted with `pnpm exec drizzle-kit generate --custom`, mirroring
`drizzle/0044_abuse_usage_integrity_rls_grants.sql`: `builderhunt_app` gets **SELECT only** on the
signal and score tables and `SELECT, INSERT` on the queue; `builderhunt_worker` gets the write verbs;
`builderhunt_platform` gets `SELECT` for investigation. No RLS (no owning subject column — same
posture as `abuse_signals`). Register all three in `scripts/db/audit-schema.ts` and
`docs/architecture/data-classification.md` as **system-operational**, with the "derived inference
about a natural person; publication forbidden" annotation on the scores table.

### Phase 3 — Collector, worker, admin endpoint, suppression enforcement

The GitHub `hireable`/`bio` collector over `safeFetch` + `getSourcePolicy('github')`; the worker
(lease → restriction check → collect → upsert signals → recompute verdict → reschedule queue row →
expiry purge) behind `AVAILABILITY_SIGNALS_ENABLED` (default `false`);
`POST /api/admin/availability-signals/run-worker` cloned from the alerts worker route **including its
`withJobRun` wrapper**, plus its `OPERATIONAL_SCHEDULES` entry; and the extension of
`cascadeBuilderProcessingRestriction` so an existing subject restriction purges availability rows too.

Shippable value: data collection works and is auditable via the admin endpoint, and **suppression
is enforced before anything is user-visible**. Nothing in the product UI has changed yet.

### Phase 4 — Subject-facing surface first

`GET /api/me/builder/$builderId/availability` (verified-claimant gate) and a card on
`/me` rendering byte-identical content to what recruiters will later see, plus the two suppression
controls. This ships **one full phase before any recruiter can see the inference** — a deliberate
sequencing decision, not an accident of ordering.

### Phase 5 — Recruiter surface, entitlement gate, forbidden-pattern tests

`GET /api/builders/$builderId/availability` with the tracked-builder + entitlement gate, the
`AvailabilityDisclosureCard` in `BuilderProfilePage.tsx`, the exact disclosure copy, the free-tier
static upsell row, the `PLAN_PRICING.pro.features` entry, the export/feed/email exclusion tests,
the isolation checks in `scripts/db/verify-api-isolation-local.mjs`, and the admin purge endpoint.

### Phase 6 — Optional AI explanation rung

`availability-explain` in `src/shared/lib/ai/tasks.ts` (`local-first`, structured input only, one
sentence, hidden on any failure). Droppable in review with zero impact on Phases 0–5.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| The feature is read as an assertion about a person's intent and damages a real career | Medium | Critical | Three coarse buckets, no number, per-signal disclosure with source URL and excerpt, an explicit `provenance` discriminator on every surfaced field (`spec.md` §Provenance labelling), self-declared signals only, "no signal" renders nothing, never on an anonymous or indexable page, never in an export/feed/email — each enforced by a test, not by review discipline |
| **A phrase is matched inside text BuilderHunt itself synthesized** and presented as the subject's own statement | Medium (was unmitigated in the 2026-07-25 draft) | Critical | `AVAILABILITY_BIO_SOURCE_ALLOWLIST` restricts S2/S3 to the eight sources whose `bio` is verifiably subject-authored, plus a rejection rule for `hn`'s synthesized `Posted: "…"` fallback. Verified source-by-source against `src/lib/sources/*.ts` at HEAD |
| Refactoring `abuse/risk.ts` to delegate to the shared primitive changes anti-abuse behaviour | Low | High | Scope of the extraction cut to `decayedSum` alone — the corroboration cap stays where it is, so the escalation line of a live anti-abuse path is never edited. `tests/unit/shared/lib/abuse/risk.test.ts` must pass **byte-unchanged**; weight tables and thresholds stay separate per feature |
| Two unrelated "availability" domains collide (`availability_rules`/`availability_policies`/`availability_overrides` from `drizzle/0069`–`0071`, `src/lib/scheduling/availability.ts`, `tests/unit/lib/scheduling/availability.test.ts`) | High | Medium | Every table, module directory and env var this plan creates is prefixed (`builder_availability_*`, `availability-signals/`, `AVAILABILITY_SIGNALS_*`) — `spec.md` §Naming is the authority; a grep for `availability_` must never return an ambiguous hit |
| Read-path enqueue loops forever for the (common) no-signal identity, re-fetching GitHub about a named person on every profile view | High (was a live defect in the 2026-07-25 draft) | High | The worker **reschedules** the queue row (`availableAt = now() + AVAILABILITY_SIGNALS_REFRESH_DAYS`, `lastCheckedAt = now()`) instead of deleting it, so the row is the durable "already checked" marker and `ON CONFLICT DO NOTHING` is genuinely idempotent. Only a purge deletes it |
| A still-displayed statement silently expires, or a two-year-old change event reads as fresh | Medium | High | Explicit split: S1/S2 refresh `observed_at` on re-observation (current-state signals, deleted when gone); S3 freezes `observed_at` and stores `prior_observed_at` (event signal, decays). Stated in `spec.md` §"What decay actually measures here" and asserted in `score.test.ts` |
| S3 asserts a change happened "recently" when the real bound is only as tight as our irregular observation cadence | High | High | `prior_observed_at` is stored and **shown**: the disclosure states both endpoints ("absent on X, present on Y") instead of a single date, and `open_signal_recent` requires the detection itself to be inside `AVAILABILITY_SIGNALS_RECENT_WINDOW_DAYS` |
| S3 coverage is so low the feature never reaches its top bucket in practice | High | Medium | Accepted and stated in the spec; S1/S2 still produce the `open_signal_present` bucket, which is the actual pre-outreach datum. Coverage is a tracked success metric, not an assumption |
| False positives on third-party phrasing ("open to work with partners") or recruiters' own bios | Medium | High | Blunt negation allowlist (including bare `hiring`), matcher biased toward false negatives, matched excerpt always shown so a human judges, measured-FP kill criterion at >25% |
| `hireable` set years ago reads as current | High | Medium | Lowest weight, can never reach the top bucket, disclosure says "last seen `<date>`" and never "since `<date>`"; decay is documented as measuring our observation age, not the subject's |
| App role can write an inference about a person (bug or compromise) | Low | High | `builderhunt_app` gets `SELECT` only on the signal and score tables; only `builderhunt_worker` writes — stricter than `builder_embeddings`, mirroring the `account_risk` posture in `drizzle/0044`. `builderhunt_platform` gets `SELECT` only, because nothing runs a DELETE under the platform role: the purge endpoint calls the repository, which uses `workerDb` |
| The scores table is registered as `global-public` and thereby declared publishable | Medium (was in the 2026-07-25 draft) | Critical | `docs/architecture/data-classification.md:3` defines `global-public` as "intentionally publishable", and `audit-schema.ts`'s `global()` helper records public DTO fields. All three tables are registered `system-operational` with public fields `none` |
| Queue table leaks which organization is interested in which person | Medium | High | `builder_availability_refresh_queue` has **no `organization_id` column by design**; enqueue is gated on the identity already being tracked by the caller's organization and is rate-limited |
| Fetch amplification against GitHub (arbitrary-user fetch via the enqueue path) | Medium | Medium | Enqueue only for identities the requesting organization already tracks; `AVAILABILITY_SIGNALS_DAILY_FETCH_CAP` (500/UTC-day, Redis counter with in-memory fallback); per-organization rate limit; `safeFetch` host allowlist from `getSourcePolicy('github').allowedHosts` |
| A migration mode / grant gap silently breaks every write, as happened with `builder_embeddings` (`drizzle/0025`) | Medium | High | Every new table and `builder_source_snapshots` get an explicit isolation check in `scripts/db/verify-api-isolation-local.mjs` executed as the real non-owner roles — the only method that has actually caught this class of bug in this repo |
| Retention lag: a subject removes the phrase and the panel keeps showing it for up to 180 days | Medium | High | Any re-observation that finds no phrase deletes that identity's live S2/S3 rows in the same transaction; removal is treated as evidence, not absence of evidence |
| Scope creep back toward the cut signals (work-hours, activity spikes) | Medium | High | Cut with reasons in the spec's Non-goals; the phrase allowlist and signal-type `CHECK` constraint make adding a fourth signal a visible migration, not a quiet commit |

## Rollback

1. **Instant, no deploy**: set `AVAILABILITY_SIGNALS_ENABLED=false`. The worker no-ops, both read
   endpoints return `{ availability: null }`, and every UI surface renders nothing. This is the
   documented kill switch and the response to the measured-FP kill criterion.
2. **Stop collecting only**: remove the cron entry for
   `/api/admin/availability-signals/run-worker` (and disable the `availability.signals` row in
   `operational_schedules`). Existing rows age out via `expiresAt` within
   `AVAILABILITY_SIGNALS_RETENTION_DAYS`.
3. **Delete the data**: run the Phase 5 admin purge endpoint
   (`POST /api/admin/availability-signals/purge`) — deleting all rows from
   `builder_availability_signals` and `builder_availability_scores` is safe at any time, because
   every row is derivable from public sources and no other feature reads them.
4. **Full revert**: the three tables are append-only-plus-purge and referenced by nothing else, so
   a forward-only `DROP TABLE` migration is a clean removal. Phase 0 (snapshot write path + grants)
   is deliberately independent and should **not** be reverted — it fixes a pre-existing gap in
   `builder_source_snapshots` that has nothing to do with this feature, and three other phase-2
   plans are waiting on it. `BUILDER_SNAPSHOT_KEEP` is named accordingly.
5. **Phase 1's shared primitive**: `src/shared/lib/signal-decay.ts` (created in Phase 1) is pure and used by
   `abuse/risk.ts`; reverting availability must not revert it. Guarded by
   `tests/unit/shared/lib/abuse/risk.test.ts` remaining byte-unchanged throughout.
