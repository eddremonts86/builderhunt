# Availability Signals (Open-to-Work Score) (spec)

> **Status**: `pending`
> **Depends on**: [`abuse-and-usage-integrity`](../../abuse-and-usage-integrity/spec.md) (the decayed combined-signal scoring mechanics this plan reuses); [`claimable-profiles`](../../claimable-profiles/spec.md) (a subject's explicit open-to-work state always outranks inference); [`legal-and-compliance`](../../legal-and-compliance/spec.md) (inference about named individuals must be disclosed and contestable). Binding: [`security-policy`](../../_meta/security-policy.md).
> **Blocks**: nothing
> **Reality check**: The decay engine is already **shipped code**, not a pending plan — `src/shared/lib/abuse/risk.ts` (`computeDecayedRiskScore`, `MIN_CORROBORATING_SIGNAL_TYPES`), `repositories/abuse-signals.ts`, `repositories/account-risk.ts`, `drizzle/0043`–`0045` all exist (its `spec.md` header still says `pending` and is stale). Suppression is shipped: `builder_processing_restrictions` + `is_builder_processing_restricted(text)` (`drizzle/0017_enrichment_rls_policies.sql`) + `POST /api/me/builder/$builderId/restrict-processing`. A subject-claimed availability state is shipped: `published_builder_profiles.open_to_status` (`schema.ts:226`), edited via `PATCH /api/me/builder/$builderId`. This plan adds no second scoring engine and no second suppression mechanism.

## Problem

A recruiter spends an outreach credit and their own reputation on a cold message. The one datum
that changes that decision — "has this person recently said, in public, that they are open to
something?" — sits in text BuilderHunt already touches and is nowhere in the product. The only
availability data today is `published_builder_profiles.open_to_status`, which requires the subject
to have claimed their profile: near-zero coverage.

The idea as written ("probability of being receptive", inferred from bio changes, side-project
activity spikes, and *activity at hours that suggest an active job search*) is a different and much
worse product. It asserts an **employment intention** about a **third party who never opted in**,
and the cost of being wrong lands entirely on them — an employer inferring that someone is looking
is a career-level consequence. This spec builds the defensible part and cuts the rest.

## The asymmetry with `account_risk` — RESOLVED

Same arithmetic, completely different justification burden:

| | `account_risk` | availability |
| --- | --- | --- |
| Subject | our own signed-up user | a third party who never opted in |
| Input | their actions **against our service** | text they published **for other purposes** |
| Claim | "this account's behaviour looks like X" | "this person's *intent* is X" |
| Consequence | we throttle **our own** service | someone contacts them; their employer may infer disloyalty |
| Cost of error | a support ticket | a person's job |

**Resolution: the score must never claim intent.** The surface reports *which self-declared
availability statements we observed, from which public URL, and when we observed them*, with a
recency weight. It is a **declaration aggregator with decay**, not an intention predictor. Every
other decision below — three coarse buckets, no percentage, three signals, all self-declared —
follows from that reframing.

## Goal

For an entitled organization looking at a builder it already tracks:

1. The subject's own stated availability when it exists (fact, always wins).
2. Otherwise a coarse bucket from a deterministic, unit-tested, decayed sum of **self-declared
   public availability statements**, each disclosed individually with source URL, matched excerpt,
   and observation date.
3. Nothing at all when there is no signal, when the subject suppressed processing, or when the
   subject said they are not looking.

## Non-goals (with reasoning — several are the idea's own bullets, cut deliberately)

- **Activity at hours suggesting a job search — dropped.** (a) We cannot compute local time: source
  APIs return UTC and `builder_identities.country` is an unparsed free-text `location` string when
  present at all (`src/lib/sources/github.ts` maps `user.location` straight into `country`). (b) Even
  with the right timezone the inference is wrong constantly — freelancers, students, remote workers
  across timezones, night owls, parents, people on leave, CI/bot commits, and every country with a
  non-Mon–Fri workweek. (c) The detection method *is* the harm: it means watching a named person's
  working hours to guess whether they are disloyal to their employer. No disclosure copy makes that
  acceptable, so it is not built.
- **Side-project activity spikes — dropped.** Measures productivity, not availability: a prolific
  maintainer is permanently "spiking", a burned-out person about to quit is permanently quiet. No
  connector fetches per-user event streams today either, so it would need new fetch infrastructure
  to produce a signal we would then discard.
- **Generic bio-change detection — dropped.** Adding an emoji to a bio is not a job search. Only an
  allowlisted availability *phrase newly appearing* survives (S3 below).
- **Profile-README fetching — out of v1.** An extra fetch per identity for content that duplicates
  the bio almost always; revisit only if S2/S3 coverage proves too low.
- **Any numeric output.** No percentage, decimal, gauge, bar, or star rating in any DTO or UI.
  `score_bps` is stored for tuning and never serialized.
- **Sorting/filtering results by an *inferred* bucket** — that builds a "who is most vulnerable
  right now" leaderboard. Filtering by the subject's own *stated* status is allowed; they asked for it.
- **Availability in any export, RSS feed, email, or outreach draft body.** It must stay inside the
  surface that explains it. Test-enforced.
- **Availability on any anonymous route** (`/builders/$builderId`, OG images, sitemap). Publishing
  an inference about a named person to an indexable page is permanently out of scope.
- **No LLM in the verdict** (see §AI rung). **No scoring of identities nobody tracks** — the
  discovery worker inflates `builder_identities` with strangers. **No tenant-private copies** (§Data
  class). **No new sources** beyond what we already fetch plus GitHub's official `GET /users/{login}`.

## Signal-by-signal honesty pass

The matcher is deliberately biased toward **false negatives**: a missed signal costs a recruiter a
little, a fabricated one costs a person.

| ID | Signal | Available today? | Detection | False-positive risk |
| --- | --- | --- | --- | --- |
| **S1** | `github_hireable` — GitHub's self-set "Available for hire" flag | **No.** `GET /users/{login}` returns `hireable`, but `src/lib/enrichment/connectors/github.ts` never parses it and `src/lib/sources/github.ts` never calls that endpoint. Needs a new collector. | Boolean from the official API via `safeFetch` (`src/lib/enrichment/network.ts`) + the existing `github` source policy. | Low as a *statement*, high as *currency*: GitHub does not expose **when** the flag was set, so 2019 and yesterday are indistinguishable. Decay cannot fix this — re-observation resets our clock, not theirs. Hence lowest weight, and S1 can never reach the top bucket. |
| **S2** | `profile_text_open_phrase` — an allowlisted availability phrase in the stored bio | **Partly, and worse than it looks.** GitHub's `/search/users` does **not** return `bio` (`GitHubSearchUser` in `src/lib/sources/github.ts` declares it; the API does not send it), and several sources synthesize a fake bio: `stackoverflow.ts` → `"87% accept rate"`, `huggingface.ts` → pipeline tags, `npm.ts` → package description, `lobsters.ts` → `undefined`. Real prose bios come from reddit, hashnode, gitlab, codeberg, sourcehut, and hn (`hn.ts:123` prefers the genuine `user.about` prose and only falls back to `Posted: "<title>"` when it is empty — so HN counts, with a synthesized-string case the detector must tolerate) — and from GitHub only via S1's new `/users/{login}` fetch. | Case-insensitive word-boundary match against a fixed phrase allowlist, voided by a negation allowlist. Stores only the ≤120-char matched excerpt, never the whole bio. | Low for the phrase itself. Residual: third-party phrasing ("my company is open to work with partners") and recruiters' own bios — mitigated by the negation list and by always showing the excerpt so a human judges. Same unknowable-age problem as S1. |
| **S3** | `open_phrase_appeared` — the phrase is present now and absent in the newest retained snapshot ≥7 days older | **No, and this is the hardest blocker.** `builder_source_snapshots` has exactly one writer in the repo — the one-shot backfill `scripts/db/backfills/builders.ts:110` — and **zero grants for any non-owner role**, so no runtime code can write it. `trackOrganizationBuilder` (`repositories/organization-builders.ts:228`) overwrites `builder_identities.bio` in place via `onConflictDoUpdate` and keeps no history. **There is no bio history at all today.** | Phase 0 adds a write path + grants; then diff the two newest retained snapshots. | Low, and it is the **only signal with a real timestamp** — a bounded interval in which the change actually happened. Highest weight; the only signal that can produce the top bucket. Catch: zero coverage on day 1, and thereafter only for identities re-observed ≥7 days apart, driven by irregular customer search/track activity rather than a schedule. |
| **S4** | The subject's own `published_builder_profiles.open_to_status` | **Yes, today.** | Not a signal — a **fact**, handled by the precedence rule. | n/a |

Phrase allowlist (`AVAILABILITY_OPEN_PHRASES`, case-insensitive, word-boundary): `open to work`,
`#opentowork`, `open for work`, `open to offers`, `open to opportunities`, `open to new roles`,
`available for hire`, `available for work`, `for hire`, `hire me`, `looking for work`, `looking for
a job`, `looking for my next`, `looking for new opportunities`, `seeking new opportunities`,
`seeking opportunities`, `seeking a role`, `actively looking`, `job hunting`, `job seeking`.

Negation allowlist (`AVAILABILITY_NEGATION_PHRASES`) — **any** match voids S2/S3 for that
observation: `not looking`, `not currently looking`, `no longer looking`, `not open to work`, `not
for hire`, `not available for hire`, `not seeking`, `hiring`. (`hiring` is intentionally blunt: it
kills recruiters' own bios at the cost of some recall.)

## Explicit beats inferred — the precedence rule

One pure function, `resolveAvailabilityDisclosure()`, top-down; the first matching rule wins and the
rest are never consulted:

1. **Active `builder_processing_restrictions` row** (`is_builder_processing_restricted`) → `null`,
   **byte-identical to the no-data response**. A distinct "suppressed" state would itself disclose
   that the person objected.
2. **Verified claim + `open_to_status` contains `hires` or `consulting`** → `stated_by_subject` with
   the subject's own labels. The inferred bucket is not shown, not merged, not used as corroboration.
   The fact **replaces** the inference.
3. **Verified claim + `open_to_status` non-empty but excluding `hires`/`consulting`** (including
   `nothing` = "Not actively looking") → `null`. They said no; we do not second-guess them. This is
   also the subject's zero-new-storage opt-out — the toggle already exists in
   `src/routes/_dashboard/me/index.tsx`'s `OPEN_TO_OPTIONS`.
4. **Verified claim + empty `open_to_status`** → inferred bucket may show; the disclosure adds "This
   person has claimed this profile and has not stated an availability preference."
5. **No claim** → inferred bucket from the decay engine.

Unit-tested invariant: no input combination can produce an inferred bucket that contradicts a
non-empty `open_to_status`.

## Reuse vs. new

**Reused** (mechanics, not a fork): the half-life shape `weight × 0.5^(ageHours / halfLifeHours)`
and the corroboration cap from `src/shared/lib/abuse/risk.ts`. Phase 1 extracts both into a pure
`src/shared/lib/signal-decay.ts` (`decayedSum`, `capByCorroboration`) and makes `abuse/risk.ts`
**delegate**, with `src/shared/lib/abuse/risk.test.ts` left byte-unchanged as the no-behaviour-change
proof. Also reused as patterns: append-only-signals + one-derived-row-per-subject
(`abuse_signals`/`account_risk`), the worker-writes/app-cannot-write grant posture, the HTTP-cron
worker (`src/routes/api/admin/alerts/run-worker.ts`), the lease/attempt queue shape
(`enrichment_jobs`), and the Redis daily cap with in-memory fallback (`src/lib/discovery/worker.ts`).

**New**: subject key is `builder_identity_id`, not `user_id`; three coarse buckets instead of a
five-rung ladder (there is no enforcement — the output is never an action); the precedence rule; the
subject disclosure/suppression surface; "suppressed is indistinguishable from absent"; the
snapshot-history write path.

**Deliberately not shared**: weight tables and thresholds. Nobody should be able to move a fraud
threshold by tuning a recruiting signal.

## Architecture

### Buckets and thresholds

```ts
// src/shared/lib/availability/score.ts
export type AvailabilityBucket = 'no_public_signal' | 'open_signal_present' | 'open_signal_recent'
export type AvailabilitySignalType = 'github_hireable' | 'profile_text_open_phrase' | 'open_phrase_appeared'

export const AVAILABILITY_WEIGHTS: Record<AvailabilitySignalType, number> = {
  github_hireable: 2,          // unknowable age — lowest weight, can never reach the top bucket
  profile_text_open_phrase: 3, // unknowable age
  open_phrase_appeared: 5,     // the only signal with a real timestamp
}
export const AVAILABILITY_HALF_LIFE_DAYS = 45   // env-overridable; a job search is weeks, not hours
export const AVAILABILITY_PRESENT_MIN_SCORE = 2
export const AVAILABILITY_MIN_CORROBORATING_TYPES = 2 // same invariant as abuse/risk.ts

export interface AvailabilityVerdict {
  bucket: AvailabilityBucket
  scoreBps: number            // stored for tuning; NEVER returned by any DTO
  distinctSignalTypes: number
  topSignalType: AvailabilitySignalType | null
}
```

`open_signal_recent` requires an `open_phrase_appeared` observation inside
`AVAILABILITY_RECENT_WINDOW_DAYS` (30) **and** ≥2 distinct signal types. `open_signal_present`
requires a decayed score ≥ `AVAILABILITY_PRESENT_MIN_SCORE`. Everything else is `no_public_signal`
and persists **no row** — we do not store a record asserting anything about a person with no signals.

**Resolved tension**: with three inputs the decay engine does *recency weighting*, not
discrimination. A finer scale would be false precision, which is the exact failure mode this spec
exists to avoid. Hence three buckets and a hidden `score_bps`.

### Presentation — recommendation: coarse buckets, no number, ever

A percentage beside a real person's name manufactures certainty out of at most three binary
observations. Surface: one chip in the tracked-builder profile (`BuilderProfilePage.tsx`) expanding
into a disclosure panel. Chip copy, exact:

- `stated_by_subject` → **"Open to offers — stated by this person"** + their own labels.
- `open_signal_recent` → **"Public availability signal (recent)"**
- `open_signal_present` → **"Public availability signal"**
- `no_public_signal` / suppressed / rule 3 → **render nothing.** Absence of a signal is not evidence
  of unavailability; there is no "closed" state.

Disclosure body, exact, always above the signal list for inferred buckets:

> Inferred from public signals this person published themselves. BuilderHunt does not know whether
> they are looking for work. This is not a prediction and not a rating of the person.

Per-signal rows: `<label> · seen <date> · <source>` linking to the public source URL, plus the
≤120-char excerpt for S2/S3. Labels: "Marked 'available for hire' on GitHub", "Availability phrase
in public bio", "Availability phrase newly added to public bio".

**Forbidden UI patterns**, each with a test or assertion: no number/percentage/gauge/stars; no
red-green or traffic-light semantics (one neutral accent for present, nothing for absent); no
"not open"/"closed"/"unavailable" state; no sort/filter by inferred bucket; no availability in
exports, feeds, emails, or outreach drafts; nothing on anonymous routes; no AI prose restating the
bucket as certainty.

### Data class and storage — global-public derived, argued

**Chosen: global, one row per `builder_identity_id`, shared across tenants** (same shape as
`builder_embeddings`/`published_builder_profiles`). Rejected: tenant-private per organization. The
decisive argument is subject rights, not compute — a subject who contests or suppresses must do it
**once**, and two organizations must never show contradictory buckets for the same person on the
same day. Per-tenant copies make contestation a fan-out problem and guarantee drift; avoided fetches
are only a secondary benefit.

Declared `global-public` in `docs/architecture/data-classification.md` with the annotation *derived
inference about an identified natural person; publication forbidden; read requires an entitlement;
subject-suppressible*. With no owning-subject column RLS is not applicable (same as
`builder_embeddings`); access is GRANT plus route-level entitlement. Grants are **stricter** than
`builder_embeddings`: `builderhunt_app` gets `SELECT` only, so a bug or compromised app role can
never fabricate or edit an inference about a person. Only `builderhunt_worker` writes.

```ts
// src/shared/lib/db/schema.ts — three new tables (identityFk = text('builder_identity_id')
// .references(() => builderIdentities.id, { onDelete: 'cascade' }), spelled out in the real file)
export const availabilitySignals = pgTable('availability_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  builderIdentityId: identityFk.notNull(),
  signalType: text('signal_type').notNull(),
  source: text('source').notNull(),          // SourceName
  sourceUrl: text('source_url').notNull(),   // the public URL a human can check
  evidenceExcerpt: text('evidence_excerpt'), // ≤120 chars, matched phrase only
  contentHash: text('content_hash').notNull(),
  detectorVersion: integer('detector_version').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [
  // idempotent re-observation; then identity+observed scan, then the retention purge scan
  uniqueIndex('availability_signals_identity_type_hash_unique').on(t.builderIdentityId, t.signalType, t.contentHash),
  index('availability_signals_identity_observed_idx').on(t.builderIdentityId, t.observedAt),
  index('availability_signals_expiry_idx').on(t.expiresAt),
  check('availability_signals_type_check', sql`${t.signalType} in ('github_hireable','profile_text_open_phrase','open_phrase_appeared')`),
  check('availability_signals_excerpt_len_check', sql`length(${t.evidenceExcerpt}) <= 120`),
])

export const builderAvailabilityScores = pgTable('builder_availability_scores', {
  builderIdentityId: identityFk.primaryKey(),
  bucket: text('bucket').notNull(),
  scoreBps: integer('score_bps').notNull(),   // internal tuning only, never in a DTO
  distinctSignalTypes: integer('distinct_signal_types').notNull(),
  topSignalType: text('top_signal_type'),
  detectorVersion: integer('detector_version').notNull(),
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // never store no_public_signal — a row must always assert something a signal supports
  check('builder_availability_scores_bucket_check', sql`${t.bucket} in ('open_signal_present','open_signal_recent')`),
])

// System-operational queue, global, DELIBERATELY WITHOUT organization_id — a global table carrying
// "which org asked about this person" would be a cross-tenant interest leak. Lease/attempt columns
// mirror enrichment_jobs minus the tenant columns; `availableAt ASC` IS the worker's cursor.
export const availabilityRefreshQueue = pgTable('availability_refresh_queue', {
  builderIdentityId: identityFk.primaryKey(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  leaseToken: text('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
}, (t) => [
  index('availability_refresh_queue_scan_idx').on(t.availableAt, t.leaseExpiresAt),
  check('availability_refresh_queue_attempts_check', sql`${t.attempts} >= 0`),
])
```

Classes: `availability_signals` and `availability_refresh_queue` = **system operational** (no owning
subject, GRANT-only, no RLS — the `abuse_signals` posture from `drizzle/0044`);
`builder_availability_scores` = **global public (derived)** with the annotation above. Phase 0 also
needs `GRANT SELECT, INSERT, DELETE ON builder_source_snapshots TO builderhunt_app` and
`GRANT SELECT ... TO builderhunt_worker` — that table has **no grants at all** today, which is
exactly why nothing has ever written it outside the owner-role backfill.

### Worker

`POST /api/admin/availability-signals/run-worker` — structural clone of
`src/routes/api/admin/alerts/run-worker.ts`: `tryCronPrincipal(request) ?? await
requirePlatformAdminPrincipal(request)`, `auditPlatformAdminAction`, JSON counts, hit by the
Coolify/VPS cron. No queue system.

Per run: lease ≤ `AVAILABILITY_IDENTITIES_PER_RUN` (50) queue rows ordered by `availableAt ASC`
(the queue **is** the cursor), skipping live leases. Per identity, own transaction: check
`is_builder_processing_restricted` → if restricted, purge signals + score + queue row; else collect
S1/S2/S3, upsert signals idempotently on `(identity, type, contentHash)`, delete now-absent S2/S3
rows in the same transaction, recompute the verdict, upsert or delete the score row. Each run also
deletes signals past `expiresAt`. Idempotent: the unique index makes re-observation a no-op and the
verdict is a pure function of live rows. Quota: `AVAILABILITY_DAILY_FETCH_CAP` (500 external
fetches/UTC-day) in Redis with the in-memory fallback from `src/lib/discovery/worker.ts`; on cap the
run returns `capped: true` and leaves rows queued. `AVAILABILITY_SIGNALS_ENABLED=false` (default)
makes the worker a no-op and the read path return `null` — the kill switch.

Queue population: the read path enqueues on missing/stale score (`ON CONFLICT DO NOTHING`), only for
an identity the requesting organization already tracks (`findOrganizationBuilderByIdentity`), rate
limited per organization. That bounds work to people a customer is actually considering and makes
arbitrary-user fetch amplification impossible.

### Read APIs

- `GET /api/builders/$builderId/availability` — `requireTenantPrincipal` →
  `can(principal, 'resource:read')` → must be tracked by this organization → entitlement gate →
  `resolveAvailabilityDisclosure()`. Returns `{ availability: null }` or
  `{ availability: { kind: 'stated_by_subject' | 'inferred', bucket?, statedLabels?, signals: [{ type, label, source, sourceUrl, excerpt, observedAt }], disclosure } }`.
  `scoreBps`, `distinctSignalTypes`, and `detectorVersion` are never serialized.
- `GET /api/me/builder/$builderId/availability` — the **subject's** view, gated by
  `isVerifiedBuilderClaimant` exactly as `evidence-provenance.ts` is. Returns the identical payload
  recruiters see, plus a `suppression` block naming both controls.

### Subject rights

- **See**: the subject endpoint plus a card on `/me` rendering byte-identical content to the
  recruiter panel — no separate "subject-friendly" wording.
- **Contest**: the panel links to the claim flow and the restriction endpoint. **Honest gap**: an
  *unclaimed* subject must claim their profile (i.e. create an account) to use either control. We
  deliberately do **not** add an anonymous suppression endpoint — it would let anyone suppress
  anyone. Compensating control: platform admins can apply a `reason='subject_request'` restriction
  from an emailed request, and the panel names that route. The asymmetry is inherited from
  `claimable-profiles`, not created here.
- **Suppress**: `POST /api/me/builder/$builderId/restrict-processing` already exists and already
  cascades cross-organization. Phase 3 extends `cascadeBuilderProcessingRestriction`
  (`src/lib/enrichment/worker.ts:206`) to also purge availability signals, score, and queue row.
  Because the score is global, suppression is one write with global effect — the whole point of the
  global-public choice.
- **Retention**: signal rows expire `AVAILABILITY_SIGNAL_RETENTION_DAYS` (180) after `observedAt` and
  are deleted by the worker; score rows are deleted the moment no live signal supports them; a
  restriction purges everything immediately. `builder_source_snapshots` keeps the newest
  `AVAILABILITY_SNAPSHOT_KEEP` (8) per identity — enough for the S3 diff, not a history of someone's
  self-description.

### Tier and billing gating

`getOrganizationEntitlement(tx, organizationId)` (`repositories/entitlements.ts`) must yield
`policy.paidActionsAllowed === true` and `policy.tier ∈ {'pro','pro_max','team'}`, else
`403 { error: 'plan' }`. Add `'Public availability signals'` to `PLAN_PRICING.pro.features`
(`src/shared/lib/billing-shared.ts`). No new limit counter — a boolean capability like semantic
search.

**With `STRIPE_BILLING_ENABLED=false` (today, everywhere)** the gate still works: it reads
`organization_entitlements`, which admins populate manually via `setPlatformUserPlan`. Manually
granted pro/team organizations get the feature; free ones do not. Nothing here needs Checkout,
webhooks, or the credit ledger.

**Free-tier surface**: a *static, unconditional* "Availability signals — Pro" row, byte-identical
whether or not signals exist. A conditional lock would itself leak that a signal exists.

## AI rung (optional, droppable)

The verdict contains **no LLM**: `computeAvailabilityVerdict()` and
`resolveAvailabilityDisclosure()` are pure, deterministic, and unit-tested, and the endpoint calls
nothing else.

The only permitted AI is one optional sentence explaining an **already-computed** verdict: task
`availability-explain` in `src/shared/lib/ai/tasks.ts`, tier `local-first` (interactive, ephemeral,
this-user-only → Chrome AI first, `/api/ai/complete` MiniMax fallback). Input is **structured
metadata only** — signal labels, source names, ISO dates, bucket — never the subject's bio, so there
is no untrusted-content surface and `wrapUntrusted` is unnecessary by construction. Output
`z.object({ summary: z.string().min(1).max(280) })`, `cacheTtlSeconds: 604800`,
`allowances: { free: 0, pro: 50, team: 200 }`, `maxOutputTokens: 300` (MiniMax M3 emits a `<think>`
block — see the `ping` task's note). The system prompt forbids asserting certainty, speculating
about employers or reasons, and adding any fact not in the input. Ladder: Chrome AI → MiniMax →
**hide the sentence**; the structured signal list is the non-AI rung and the panel works without it.
Hidden entirely when `AI_DISABLED` or the task is disabled.

**Cost model**: ≤1 call per (identity, verdict) per 7 days, ~250 input + ~120 output tokens, ≥70%
expected on Chrome AI at zero cost; server spend is Pro/Team-gated. If the sentence does not
measurably help in review, drop Phase 6 — nothing depends on it.

## Success metrics

- **Coverage** — % of tracked identities with ≥1 live signal. Expected 5–15%, dominated by GitHub.
  A low number is the honest outcome, not a failure.
- **Measured false-positive rate**, auditable from our own data: of identities that had a non-null
  inferred bucket and were *later* claimed with `open_to_status = ['nothing']`, that fraction is our
  measured FP. **Kill criterion: FP > 25% over 100+ observations ⇒ switch the feature off via
  `AVAILABILITY_SIGNALS_ENABLED`.** Target < 10%.
- **Recall proxy**: of identities later claimed with `hires`/`consulting`, the fraction that had a
  non-null bucket beforehand.
- Zero availability fields in `/api/export/builders`, `/api/feeds/*.xml`, or any email — asserted by
  tests, not by review.
- Zero signal/score rows for any identity with an active processing restriction — asserted by
  `pnpm test:api-isolation:local`. No regression in `pnpm test:rls:local`.

## Resolved edge cases

- **Day-1 cold start**: S3 has zero coverage until the snapshot write path has been live ≥7 days, so
  nothing can be `open_signal_recent` at launch. Expected and acceptable.
- **`hireable` set years ago**: unknowable age ⇒ lowest weight and the hard rule that S1 alone never
  reaches the top bucket. The disclosure says "seen <date>", never "since <date>".
- **Person deletes the phrase**: any re-observation that finds no phrase deletes that identity's live
  S2/S3 rows in the same transaction — removal is treated as evidence, not as absence of evidence.
  Without that rule the panel could lag by up to 180 days.
- **Recruiter's own bio** ("hiring engineers, not looking"): the negation list voids the signal.
- **Third-party phrasing** ("we are open to work with partners"): residual FP, mitigated by showing
  the excerpt so a human judges; deliberately not "fixed" with heuristics that create their own errors.
- **Same person on several sources**: signals key on `builder_identity_id`, which is per
  `(source, sourceId)`, so one human yields independent verdicts per source — same as
  `builder_embeddings`. Cross-source merging belongs to `unified-timeline`.
- **Subject claims the profile after a bucket was shown**: rules 2/3 take effect on the next read;
  nothing is cached beyond the request, so no backfill is needed.
- **Restriction withdrawn** (`withdrawBuilderProcessingRestriction`): purged rows do not return; the
  identity is simply re-enqueued and re-collected on the next request.
- **`AVAILABILITY_SIGNALS_ENABLED=false`**: worker no-ops, both endpoints return
  `{ availability: null }`, UI renders nothing. Existing rows are untouched — a flag flip is not a
  deletion event; the Phase 5 admin purge endpoint is how you actually delete them.
