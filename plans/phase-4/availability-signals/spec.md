# Availability Signals (Open-to-Work Score) (spec)

> **Status**: `pending`
> **Depends on**: [`abuse-and-usage-integrity`](../../phase-1/32-abuse-and-usage-integrity/spec.md) (the decayed combined-signal scoring mechanics this plan reuses); [`claimable-profiles`](../../phase-1/36-claimable-profiles/spec.md) (a subject's explicit open-to-work state always outranks inference); [`legal-and-compliance`](../../phase-1/04-legal-and-compliance/spec.md) (inference about named individuals must be disclosed and contestable). Binding: [`security-policy`](../../_meta/security-policy.md), [`ai-policy`](../../_meta/ai-policy.md), [`conventions`](../../_meta/conventions.md), [`app-reality`](../../_meta/app-reality.md).
> **Blocks**: nothing
> **Reality check**: The decay engine is already **shipped code**, not a pending plan — `src/shared/lib/abuse/risk.ts` (`computeDecayedRiskScore`, `MIN_CORROBORATING_SIGNAL_TYPES`, private `decayedWeight`), `src/shared/lib/repositories/abuse-signals.ts`, `src/shared/lib/repositories/account-risk.ts`, `drizzle/0043`–`0045` all exist. Suppression is shipped: `builder_processing_restrictions` + `is_builder_processing_restricted(text)` (`drizzle/0017_enrichment_rls_policies.sql:70,82`) + `POST /api/me/builder/$builderId/restrict-processing`, which already calls `cascadeBuilderProcessingRestriction` (`src/lib/enrichment/worker.ts:206`). A subject-claimed availability state is shipped: `published_builder_profiles.open_to_status` (`src/shared/lib/db/schema.ts:289`), edited via `PATCH /api/me/builder/$builderId` → `updateVerifiedBuilderProfile`. `builder_source_snapshots` still has **no runtime writer** (only `scripts/db/backfills/builders.ts:110`, owner role) and **no GRANT to any runtime role** in any migration — re-verified at HEAD. This plan adds no second scoring engine and no second suppression mechanism.

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

## Naming: this repo already has an unrelated "availability" domain

`drizzle/0069`–`0071` shipped the interview-scheduling domain: `availability_rules`,
`availability_policies`, `availability_overrides` (all **tenant-private**, owner-scoped, about a
BuilderHunt *organizer's* calendar), plus `src/lib/scheduling/availability.ts`,
`src/routes/api/calendar/availability`, `tests/unit/lib/scheduling/availability.test.ts`, and the
constants `MAX_AVAILABILITY_HORIZON_DAYS` / `AVAILABILITY_HORIZON_DEFAULT_DAYS` /
`AVAILABILITY_OVERRIDE_KINDS`.

None of that existed when this plan was written. Two unrelated concepts sharing the token
`availability` in table names, module directories, and env vars is a live foot-gun, so **everything
this plan creates is prefixed to disambiguate**:

| Kind | Name |
| --- | --- |
| Tables | `builder_availability_signals`, `builder_availability_scores`, `builder_availability_refresh_queue` |
| Pure engine module | `src/shared/lib/availability-signals/` (new) |
| Server module | `src/lib/availability-signals/` (new) |
| Feature env vars | `AVAILABILITY_SIGNALS_*` (see §Env) |
| Snapshot retention env var | `BUILDER_SNAPSHOT_KEEP` (Phase 0 is independent of this feature — see §Phase 0 note) |
| Worker route / job key | `/api/admin/availability-signals/run-worker`, `availability.signals` |

Route paths keep the plain word because they are already namespaced by the subject
(`/api/builders/$builderId/availability`, `/api/me/builder/$builderId/availability`).

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
  present at all (`src/lib/sources/github.ts:64` maps `user.location` straight into `country`). (b) Even
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
  surface that explains it. Test-enforced against `src/routes/api/export/builders.ts`,
  `src/routes/api/feeds/$searchId.ts`, and `src/shared/lib/outreach.ts`.
- **Availability on any anonymous route** (`/builders/$builderId`, OG images, sitemap). Publishing
  an inference about a named person to an indexable page is permanently out of scope.
- **No LLM in the verdict** (see §AI rung). **No scoring of identities nobody tracks** — the
  discovery worker inflates `builder_identities` with strangers. **No tenant-private copies** (§Data
  class). **No new sources** beyond what we already fetch plus GitHub's official `GET /users/{login}`.
- **No second decay engine, no second suppression mechanism, no second phrase matcher.** Phase 1
  extracts exactly one shared arithmetic primitive (`decayedSum`) and nothing else (§Reuse vs new).

## Signal-by-signal honesty pass

The matcher is deliberately biased toward **false negatives**: a missed signal costs a recruiter a
little, a fabricated one costs a person.

| ID | Signal | Available today? | Detection | False-positive risk |
| --- | --- | --- | --- | --- |
| **S1** | `github_hireable` — GitHub's self-set "Available for hire" flag | **No.** `src/lib/enrichment/connectors/github.ts:33` already fetches `https://api.github.com/users/<login>` through `safeFetch` with `getSourcePolicy('github')`, but its `GithubUserResponse` interface (lines 12–20) does not declare `hireable` and nothing parses it. `src/lib/sources/github.ts` never calls that endpoint at all. Needs a collector that reuses that connector's exact fetch shape. | Boolean from the official API via `safeFetch` (`src/lib/enrichment/network.ts:69`) + `getSourcePolicy('github').allowedHosts` (`['github.com','api.github.com']`). | Low as a *statement*, high as *currency*: GitHub does not expose **when** the flag was set, so 2019 and yesterday are indistinguishable. Decay cannot fix this — re-observation resets our clock, not theirs. Hence lowest weight, and S1 can never reach the top bucket. |
| **S2** | `profile_text_open_phrase` — an allowlisted availability phrase in a **subject-authored** stored bio | **Partly, and worse than it looks.** GitHub's `/search/users` does **not** return `bio` (`GitHubSearchUser` in `src/lib/sources/github.ts:4-15` declares it; the API does not send it). Several sources **synthesize** `bio` from something the subject never wrote — see §"S2 source allowlist". | Case-insensitive word-boundary match against a fixed phrase allowlist, voided by a negation allowlist, and **only** on sources in the subject-authored allowlist. Stores only the ≤120-char matched excerpt, never the whole bio. | Low for the phrase itself. Residual: third-party phrasing ("my company is open to work with partners") and recruiters' own bios — mitigated by the negation list and by always showing the excerpt so a human judges. Same unknowable-age problem as S1. |
| **S3** | `open_phrase_appeared` — the phrase is present now and absent in the newest retained snapshot, with the gap inside a bounded window | **No, and this is the hardest blocker.** `builder_source_snapshots` has exactly one writer in the repo — the one-shot backfill `scripts/db/backfills/builders.ts:110`, which runs as the schema owner — and **zero grants for any non-owner role** (re-verified at HEAD: no `GRANT` naming that table exists in any of the 86 migrations, and `drizzle/0002_database_roles.sql:29` revokes everything from `PUBLIC`). `trackOrganizationBuilder` (`src/shared/lib/repositories/organization-builders.ts:274`, identity upsert at 282–294) overwrites `builder_identities.bio` in place via `onConflictDoUpdate` and keeps no history. **There is no bio history at all today.** | Phase 0 adds a write path + grants; then diff the two newest retained snapshots. | Low, and it is the **only signal with a real timestamp** — a bounded interval in which the change actually happened. Highest weight; the only signal that can produce the top bucket. Catches: zero coverage on day 1; thereafter only for identities re-observed inside the bounded window, driven by irregular customer track activity rather than a schedule; and the interval is only as tight as our observation cadence, which is why the *disclosure states both endpoints* rather than claiming a date. |
| **S4** | The subject's own `published_builder_profiles.open_to_status` | **Yes, today.** | Not a signal — a **fact**, handled by the precedence rule. | n/a |

### S2 source allowlist — do not match phrases in text BuilderHunt wrote

`builder_identities.bio` is not uniformly the subject's own words. Verified at HEAD:

| Source | `bio` mapping | Subject-authored? |
| --- | --- | --- |
| `github` | fetched by the S1 collector (`data.bio`) | **yes** |
| `reddit` | `user.data.public_description` (`src/lib/sources/reddit.ts:109`) | **yes** |
| `bluesky` | `actor.description` (`src/lib/sources/bluesky.ts:77`) | **yes** |
| `hashnode` | `u.bio \|\| u.tagline` (`src/lib/sources/hashnode.ts:103`) | **yes** |
| `codeberg` | `u.description \|\| u.location` (`src/lib/sources/codeberg.ts:114`) | **yes** |
| `sourcehut` | `u.description \|\| u.location` (`src/lib/sources/sourcehut.ts:61`) | **yes** |
| `producthunt` | `a.maker.headline` (`src/lib/sources/producthunt.ts:134`) | **yes** |
| `hn` | `user.about` when present, else the synthesized `Posted: "<title>"` (`src/lib/sources/hn.ts:123`) | **conditional** |
| `stackoverflow` | `"<n>% accept rate"` (`src/lib/sources/stackoverflow.ts:201`) | **no — BuilderHunt wrote it** |
| `huggingface` | pipeline/library tags (`src/lib/sources/huggingface.ts:78`) | **no** |
| `npm` | `pkg.description` (`src/lib/sources/npm.ts:125`) | **no — package text, not a person** |
| `devto` | derived from article titles (`src/lib/sources/devto.ts:91`) | **no** |
| `gitlab` | `undefined` for users; repo description for projects (`src/lib/sources/gitlab.ts:139,193`) | **no** |
| `lobsters` | `undefined` (`src/lib/sources/lobsters.ts:173`) | n/a |
| `devpost` | `row.bio` from the ingested profile row | **no — not re-verified as prose; excluded from v1** |

`AVAILABILITY_BIO_SOURCE_ALLOWLIST = ['github','reddit','bluesky','hashnode','codeberg','sourcehut','producthunt','hn']`,
and for `hn` the detector additionally rejects any bio matching `/^Posted: "/`. Matching an
availability phrase inside a string BuilderHunt generated and then labelling it "availability
phrase in public bio" would be presenting our own text as the subject's statement. That is the
single worst failure this feature can produce, so it is closed by an allowlist, not by a heuristic.

### Phrases

Phrase allowlist (`AVAILABILITY_OPEN_PHRASES`, case-insensitive, word-boundary): `open to work`,
`#opentowork`, `open for work`, `open to offers`, `open to opportunities`, `open to new roles`,
`available for hire`, `available for work`, `for hire`, `hire me`, `looking for work`, `looking for
a job`, `looking for my next`, `looking for new opportunities`, `seeking new opportunities`,
`seeking opportunities`, `seeking a role`, `actively looking`, `job hunting`, `job seeking`.

Negation allowlist (`AVAILABILITY_NEGATION_PHRASES`) — **any** match anywhere in the bio voids
S2/S3 for that observation: `not looking`, `not currently looking`, `no longer looking`, `not open
to work`, `not for hire`, `not available for hire`, `not seeking`, `hiring`. (`hiring` is
intentionally blunt: it kills recruiters' own bios at the cost of some recall.)

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
   `src/routes/_dashboard/me/index.tsx:29` (`OPEN_TO_OPTIONS`, values `chats | mentoring |
   collaboration | hires | consulting | nothing`).
4. **Verified claim + empty `open_to_status`** → inferred bucket may show; the disclosure adds "This
   person has claimed this profile and has not stated an availability preference."
5. **No claim** → inferred bucket from the decay engine.

Unit-tested invariant: no input combination can produce an inferred bucket that contradicts a
non-empty `open_to_status`.

## Reuse vs. new

**Reused** (mechanics, not a fork): the half-life shape `weight × 0.5^(ageHours / halfLifeHours)`
from `src/shared/lib/abuse/risk.ts`. Phase 1 extracts **only that** into a pure
`src/shared/lib/signal-decay.ts` (new) (`decayedSum`) and makes `abuse/risk.ts` **delegate**, with
`tests/unit/shared/lib/abuse/risk.test.ts` left byte-unchanged as the no-behaviour-change proof.

**Deliberately NOT extracted: the corroboration cap.** The 2026-07-25 draft also wanted a generic
`capByCorroboration()`. In shipped code that cap is one ternary
(`risk.ts:94-95`) whose ordering comes from `stageRank`, a five-rung ladder this feature does not
have (three buckets, no enforcement, no ranking function). Generalising it would mean inventing a
rank parameter, editing the escalation line of a live anti-abuse path, and gaining nothing but a
shared one-liner. Each feature keeps its own two-line cap. `decayedSum` — the only genuinely
identical arithmetic — is shared. Recorded in the Risks table.

Also reused as patterns: append-only-signals + one-derived-row-per-subject
(`abuse_signals`/`account_risk`), the worker-writes/app-cannot-write grant posture, the HTTP-cron
worker (`src/routes/api/admin/alerts/run-worker.ts`) **including its `withJobRun({ jobKey })`
wrapper and its `OPERATIONAL_SCHEDULES` registry entry** (`src/shared/lib/operational-schedules.ts`
— both added after this plan was drafted and now mandatory for every admin worker route), the
lease/attempt queue shape (`enrichment_jobs`), and the Redis daily cap with in-memory fallback
(`src/lib/discovery/worker.ts:65-95`).

**New**: subject key is `builder_identity_id`, not `user_id`; three coarse buckets instead of a
five-rung ladder (there is no enforcement — the output is never an action); the precedence rule; the
subject disclosure/suppression surface; "suppressed is indistinguishable from absent"; the
snapshot-history write path.

**Deliberately not shared**: weight tables and thresholds. Nobody should be able to move a fraud
threshold by tuning a recruiting signal.

## Architecture

### Buckets, weights, and the exact formula

```ts
// src/shared/lib/availability-signals/score.ts
export type AvailabilityBucket = 'no_public_signal' | 'open_signal_present' | 'open_signal_recent'
export type AvailabilitySignalType = 'github_hireable' | 'profile_text_open_phrase' | 'open_phrase_appeared'

export const AVAILABILITY_WEIGHTS: Record<AvailabilitySignalType, number> = {
  github_hireable: 2,          // unknowable age — lowest weight, can never reach the top bucket
  profile_text_open_phrase: 3, // unknowable age
  open_phrase_appeared: 5,     // the only signal with a real, bounded timestamp
}
export const AVAILABILITY_HALF_LIFE_DAYS = 45          // default; env-overridable
export const AVAILABILITY_RECENT_WINDOW_DAYS = 30      // default; env-overridable
export const AVAILABILITY_PRESENT_MIN_SCORE = 2
export const AVAILABILITY_DETECTOR_VERSION = 1

export interface AvailabilityVerdict {
  bucket: AvailabilityBucket
  scoreBps: number            // stored for tuning; NEVER returned by any DTO
  distinctSignalTypes: number
  topSignalType: AvailabilitySignalType | null
}
```

Exact arithmetic, no other rule:

```
ageHours(s)   = max(0, (now - s.observedAt) / 3_600_000)
decayed(s)    = AVAILABILITY_WEIGHTS[s.signalType] * 0.5 ** (ageHours(s) / (halfLifeDays * 24))
score         = Σ decayed(s) over live signals            // NOT rounded here
scoreBps      = Math.round(score * 100)
distinctTypes = new Set(live.map(s => s.signalType)).size
topSignalType = argmax decayed(s); ties broken by weight, then open_phrase_appeared >
                profile_text_open_phrase > github_hireable; null when there are no live signals

bucket =
  'open_signal_recent'   if ∃ s with s.signalType === 'open_phrase_appeared'
                            AND ageHours(s) <= AVAILABILITY_RECENT_WINDOW_DAYS * 24
                            AND distinctTypes >= 2
  'open_signal_present'  else if score >= AVAILABILITY_PRESENT_MIN_SCORE
  'no_public_signal'     otherwise
```

**What decay actually measures here — the part the 2026-07-25 draft left ambiguous.** S1 and S2 are
*current-state* signals: the worker refreshes their `observed_at` on every re-observation and
deletes them the moment the phrase or flag is gone (§Resolved edge cases). Their age is therefore
always ≈ 0 and they contribute full weight while they are true — which is correct: a statement that
is still publicly displayed should not silently fade. S3 is an *event* signal: its `observed_at` is
the detection moment and is **never** refreshed, so the half-life applies to it alone. Saying this
plainly is what stops the panel from either (a) dropping a live, still-displayed statement after 180
days or (b) treating a two-year-old change event as fresh.

`github_hireable` alone scores exactly 2 and therefore *can* reach `open_signal_present`. That is
deliberate: "this person set GitHub's Available-for-hire flag" is a real self-declaration and the
disclosure names it, its source URL, and the date **we** saw it. It can never reach
`open_signal_recent`, because that bucket requires an `open_phrase_appeared` row.

Everything scoring below the threshold is `no_public_signal` and persists **no row** — we do not
store a record asserting anything about a person with no signals.

**Resolved tension**: with three inputs the decay engine does *recency weighting*, not
discrimination. A finer scale would be false precision, which is the exact failure mode this spec
exists to avoid. Hence three buckets and a hidden `score_bps`.

### Provenance labelling — every field, explicitly

Acceptance requirement for this plan: nothing self-declared or inferred may read as measured. The
DTO carries a `provenance` discriminator per row and the UI renders it verbatim.

| Surfaced field | Provenance | Rendered as |
| --- | --- | --- |
| `stated_by_subject` labels | **self-declared, in BuilderHunt** | "stated by this person" |
| `github_hireable` row | **self-declared, on GitHub** — server-observed | "This person set GitHub's *Available for hire* flag. Last seen by BuilderHunt on `<date>`. GitHub does not publish when it was set." |
| `profile_text_open_phrase` row | **self-declared, in their public bio** — server-observed | "Availability phrase in this person's public bio. Last seen by BuilderHunt on `<date>`." + excerpt |
| `open_phrase_appeared` row | **inferred by BuilderHunt** from two server-measured observations | "This phrase was absent when BuilderHunt observed this profile on `<priorObservedAt>` and present on `<observedAt>`." + excerpt |
| `bucket` | **inferred by BuilderHunt** | the chip copy below, always under the disclosure sentence |
| `observedAt` / `priorObservedAt` | **server-measured** (our observation clock, never the subject's) | always phrased "seen by BuilderHunt", never "since" |
| `sourceUrl` | **server-measured** (the URL we fetched / the identity's `profile_url`) | a plain link |
| `scoreBps`, `distinctSignalTypes`, `detectorVersion` | internal | **never serialized** |

### Presentation — coarse buckets, no number, ever

A percentage beside a real person's name manufactures certainty out of at most three binary
observations. Surface: one chip in the tracked-builder profile
(`src/modules/builder-profile/components/BuilderProfilePage.tsx`) expanding into a disclosure panel.
Chip copy, exact:

- `stated_by_subject` → **"Open to offers — stated by this person"** + their own labels.
- `open_signal_recent` → **"Public availability signal (recent)"**
- `open_signal_present` → **"Public availability signal"**
- `no_public_signal` / suppressed / rule 3 → **render nothing.** Absence of a signal is not evidence
  of unavailability; there is no "closed" state.

Disclosure body, exact, always above the signal list for inferred buckets:

> Inferred from public signals this person published themselves. BuilderHunt does not know whether
> they are looking for work. This is not a prediction and not a rating of the person.

Per-signal rows use the provenance sentences in the table above, each linking to the public source
URL, plus the ≤120-char excerpt for S2/S3.

**Forbidden UI patterns**, each with a test or assertion: no number/percentage/gauge/stars; no
red-green or traffic-light semantics (one neutral accent for present, nothing for absent); no
"not open"/"closed"/"unavailable" state; no sort/filter by inferred bucket; no availability in
exports, feeds, emails, or outreach drafts; nothing on anonymous routes; no AI prose restating the
bucket as certainty.

### Data class and storage — global (cross-tenant), NOT publishable

**Chosen: one row per `builder_identity_id`, shared across tenants.** Rejected: tenant-private per
organization. The decisive argument is subject rights, not compute — a subject who contests or
suppresses must do it **once**, and two organizations must never show contradictory buckets for the
same person on the same day. Per-tenant copies make contestation a fan-out problem and guarantee
drift; avoided fetches are only a secondary benefit.

**Correction to the 2026-07-25 draft: the manifest class is `system-operational`, not
`global-public`.** `docs/architecture/data-classification.md:3` defines `global-public` as
"intentionally publishable through an allowlisted DTO", and `scripts/db/audit-schema.ts`'s
`global(table, publicDtoFields, plans)` helper records those fields as public and sets
`retention: 'published history'`. Registering `builder_availability_scores` that way would declare
an inference about a named person publishable — the exact opposite of this spec's hard non-goal.
"Global" here means *not tenant-scoped*; it does not mean public. All three tables are
`system-operational` (no owning subject, GRANT-only, no RLS, bounded retention), the same posture as
`abuse_signals` in `drizzle/0044`, with the doc row annotated *derived inference about an identified
natural person; publication forbidden; read requires an entitlement; subject-suppressible* and
public fields `none`.

Grants are **stricter** than `builder_embeddings`: `builderhunt_app` gets `SELECT` only on the
signal and score tables, so a bug or compromised app role can never fabricate or edit an inference
about a person. Only `builderhunt_worker` writes.

```ts
// src/shared/lib/db/schema.ts — three new tables. `identityFk` below is shorthand for
// text('builder_identity_id').references(() => builderIdentities.id, { onDelete: 'cascade' }),
// spelled out in full in the real file.
export const builderAvailabilitySignals = pgTable('builder_availability_signals', {
  id: uuid('id').primaryKey().defaultRandom(),
  builderIdentityId: identityFk.notNull(),
  signalType: text('signal_type').notNull(),
  source: text('source').notNull(),          // builder_identities.source
  sourceUrl: text('source_url').notNull(),   // the public URL a human can check
  evidenceExcerpt: text('evidence_excerpt'), // <=120 chars, matched phrase only
  contentHash: text('content_hash').notNull(),
  detectorVersion: integer('detector_version').notNull(),
  // Our observation clock, never the subject's. Refreshed on re-observation for
  // github_hireable / profile_text_open_phrase; frozen for open_phrase_appeared.
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
  // Only for open_phrase_appeared: the observation at which the phrase was ABSENT.
  // Together with observedAt it is the honest, checkable bound on when the change happened.
  priorObservedAt: timestamp('prior_observed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => [
  uniqueIndex('builder_availability_signals_identity_type_hash_unique')
    .on(t.builderIdentityId, t.signalType, t.contentHash),
  index('builder_availability_signals_identity_observed_idx').on(t.builderIdentityId, t.observedAt),
  index('builder_availability_signals_expiry_idx').on(t.expiresAt),
  check('builder_availability_signals_type_check',
    sql`${t.signalType} in ('github_hireable','profile_text_open_phrase','open_phrase_appeared')`),
  check('builder_availability_signals_excerpt_len_check', sql`length(${t.evidenceExcerpt}) <= 120`),
  // prior_observed_at exists only for the change signal, and must precede the detection.
  check('builder_availability_signals_prior_check',
    sql`(${t.signalType} = 'open_phrase_appeared') = (${t.priorObservedAt} is not null)
        and (${t.priorObservedAt} is null or ${t.priorObservedAt} < ${t.observedAt})`),
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
  check('builder_availability_scores_bucket_check',
    sql`${t.bucket} in ('open_signal_present','open_signal_recent')`),
])

// System-operational queue, global, DELIBERATELY WITHOUT organization_id — a global table carrying
// "which org asked about this person" would be a cross-tenant interest leak. Lease/attempt columns
// mirror enrichment_jobs minus the tenant columns; `availableAt ASC` IS the worker's cursor.
export const builderAvailabilityRefreshQueue = pgTable('builder_availability_refresh_queue', {
  builderIdentityId: identityFk.primaryKey(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
  // Set by the worker after a successful pass. The row is RESCHEDULED, never deleted, so it
  // doubles as the "we already checked this person" record — see the note below.
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  leaseToken: text('lease_token'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  lastErrorCode: text('last_error_code'),
}, (t) => [
  index('builder_availability_refresh_queue_scan_idx').on(t.availableAt, t.leaseExpiresAt),
  check('builder_availability_refresh_queue_attempts_check', sql`${t.attempts} >= 0`),
])
```

**Why the queue row is rescheduled and not deleted.** The 2026-07-25 draft had the worker drop the
queue row on success and the read path enqueue whenever no score row exists. For the common case —
a tracked person with no availability signal at all — that pair is an infinite loop: no score row,
no queue row, so every single profile view re-enqueues and the worker re-fetches GitHub about that
named person again. Rescheduling (`availableAt = now() + AVAILABILITY_SIGNALS_REFRESH_DAYS`,
`lastCheckedAt = now()`, lease cleared, `attempts = 0`) makes the queue row the durable
"already checked" marker, and `enqueue ... ON CONFLICT DO NOTHING` becomes genuinely idempotent.
Only `purgeAvailabilityForIdentity` (restriction or admin purge) deletes the row.

Phase 0 also needs `GRANT SELECT, INSERT, DELETE ON builder_source_snapshots TO builderhunt_app`
and `GRANT SELECT ON builder_source_snapshots TO builderhunt_worker` — that table has **no grants at
all** today, which is exactly why nothing has ever written it outside the owner-role backfill.

### Worker

`POST /api/admin/availability-signals/run-worker` — structural clone of
`src/routes/api/admin/alerts/run-worker.ts` as it exists at HEAD:
`tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`, the body wrapped in
`withJobRun({ jobKey: 'availability.signals' }, …)` from
`src/shared/lib/repositories/platform-operations.ts:173`, then
`auditPlatformAdminAction(principal, { … })`, JSON counts, `platformAdminErrorResponse(err)`
fallback. A matching `OPERATIONAL_SCHEDULES` entry is required or the run produces a `job_runs` row
with a null `schedule_id` and never appears in the operations calendar. Hit by the Coolify/VPS cron.
No queue system.

Per run: lease ≤ `AVAILABILITY_SIGNALS_IDENTITIES_PER_RUN` (50) queue rows ordered by
`availableAt ASC` (the queue **is** the cursor), skipping live leases. Per identity, own transaction:
check `is_builder_processing_restricted` → if restricted, purge signals + score + queue row; else
collect S1/S2/S3, upsert signals, delete now-absent S2/S3 rows in the same transaction, recompute
the verdict, upsert or delete the score row, then reschedule the queue row. Each run also deletes
signals past `expiresAt`.

Upsert semantics, exactly:
- `github_hireable`, `profile_text_open_phrase`: `ON CONFLICT (builder_identity_id, signal_type,
  content_hash) DO UPDATE SET observed_at = now(), expires_at = now() + retention,
  detector_version = excluded.detector_version` — "still true, last confirmed now".
- `open_phrase_appeared`: `ON CONFLICT … DO NOTHING` — the detection moment and its
  `prior_observed_at` are historical facts and must not move.

Idempotent: re-running over an unchanged profile produces the same row set (only S1/S2 timestamps
advance) and the verdict is a pure function of live rows.

Quota: `AVAILABILITY_SIGNALS_DAILY_FETCH_CAP` (500 external fetches/UTC-day) in Redis with the
in-memory fallback from `src/lib/discovery/worker.ts`; on cap the run returns `capped: true` and
leaves rows queued. `AVAILABILITY_SIGNALS_ENABLED=false` (default) makes the worker a no-op and the
read path return `null` — the kill switch.

Queue population: the read path enqueues on missing/stale score (`ON CONFLICT DO NOTHING`), only for
an identity the requesting organization already tracks (`findOrganizationBuilderByIdentity`), rate
limited per organization. That bounds work to people a customer is actually considering and makes
arbitrary-user fetch amplification impossible.

### Read APIs

- `GET /api/builders/$builderId/availability` — `requireTenantPrincipal` → `withTenantContext` →
  `findOrganizationBuilderByIdentity(tx, principal.organizationId, params.builderId)` (404 if not
  tracked) → entitlement gate → `resolveAvailabilityDisclosure()`. Returns
  `{ availability: null }` or
  `{ availability: { kind: 'stated_by_subject' | 'inferred', bucket?, statedLabels?, signals: [{ type, provenance, label, source, sourceUrl, excerpt, observedAt, priorObservedAt }], disclosure } }`.
  `scoreBps`, `distinctSignalTypes`, and `detectorVersion` are never serialized.

  **Correction to the 2026-07-25 draft:** it specified `can(principal, 'resource:read')` with no
  resource context. At HEAD that predicate is
  `resource.creatorUserId === principal.userId || resource.visibility === 'organization'`
  (`src/shared/lib/authorization/permissions.ts:81-84`), so calling it with no context returns
  **false for everyone** and the route would deny every request. `privateBuilderFields`
  (`organization-builders.ts:31-47`) does not select `creator_user_id` or `visibility`, so the
  context cannot be supplied without widening that projection. Every other `$builderId` route
  (`synergy.ts:73`, `enrichment.ts`) gates on membership + `findOrganizationBuilderByIdentity` and
  calls no permission predicate. This route does the same.

  The global tables are read through `publicDb` (`src/shared/lib/db/client.ts:52`), the app-role
  client already used for the other non-tenant tables — not through the tenant transaction, which is
  reserved for tenant-private reads.
- `GET /api/me/builder/$builderId/availability` — the **subject's** view, gated by
  `isVerifiedBuilderClaimant` exactly as
  `src/routes/api/me/builder/$builderId/evidence-provenance.ts:22` is. Returns the identical payload
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
  cross-tenant single-row choice. Note that function runs on `workerDb` even though it is triggered
  from an app request, which is why `builderhunt_worker` needs `DELETE` on all three tables.
- **Retention**: signal rows expire `AVAILABILITY_SIGNALS_RETENTION_DAYS` (180) after their last
  `observedAt` and are deleted by the worker; score rows are deleted the moment no live signal
  supports them; a restriction purges everything immediately. `builder_source_snapshots` keeps the
  newest `BUILDER_SNAPSHOT_KEEP` (8) per identity — enough for the S3 diff, not a history of
  someone's self-description. Because that table de-duplicates on `(builder_identity_id,
  content_hash)`, "newest 8" means the 8 most recently *first-seen distinct* payloads, not the last
  8 observations; the S3 detector must therefore treat `observed_at` as "first seen with this
  content", which is exactly what `prior_observed_at` records.

### Tier and billing gating

`getOrganizationEntitlement(tx, organizationId)`
(`src/shared/lib/repositories/entitlements.ts:78`) must yield `policy.paidActionsAllowed === true`
and `policy.tier ∈ {'pro','pro_max','team'}` (`EntitlementTier = OrganizationTier`, which includes
`pro_max`), else `403 { error: 'plan' }`. Add `'Public availability signals'` to
`PLAN_PRICING.pro.features` (`src/shared/lib/billing-shared.ts:88`). No new limit counter — a
boolean capability like semantic search.

**With `STRIPE_BILLING_ENABLED=false` (today, everywhere)** the gate still works: it reads
`organization_entitlements`, which admins populate manually via `setPlatformUserPlan`. Manually
granted pro/team organizations get the feature; free ones do not. Nothing here needs Checkout,
webhooks, or the credit ledger.

**Free-tier surface**: a *static, unconditional* "Availability signals — Pro" row, byte-identical
whether or not signals exist. A conditional lock would itself leak that a signal exists.

### Env

Eight new variables, all verified unclaimed at HEAD (`src/shared/lib/env.ts` has no `AVAILABILITY_*`
or `BUILDER_SNAPSHOT_*` entry; the existing `AVAILABILITY_*` identifiers in `src/` are scheduling
*constants*, not env vars):

| Var | Default | Phase |
| --- | --- | --- |
| `BUILDER_SNAPSHOT_KEEP` | `8` | 0 |
| `AVAILABILITY_SIGNALS_ENABLED` | `'false'` | 2 |
| `AVAILABILITY_SIGNALS_IDENTITIES_PER_RUN` | `50` | 2 |
| `AVAILABILITY_SIGNALS_DAILY_FETCH_CAP` | `500` | 2 |
| `AVAILABILITY_SIGNALS_RETENTION_DAYS` | `180` | 2 |
| `AVAILABILITY_SIGNALS_HALF_LIFE_DAYS` | `45` | 2 |
| `AVAILABILITY_SIGNALS_RECENT_WINDOW_DAYS` | `30` | 2 |
| `AVAILABILITY_SIGNALS_REFRESH_DAYS` | `7` | 2 |

`AVAILABILITY_SIGNALS_LEASE_SECONDS` from the 2026-07-25 draft is dropped: the lease length is a
worker implementation constant with no operational reason to differ per environment, and the draft
already spent one of its eight slots on it while omitting the refresh interval the queue actually
needs. `BUILDER_SNAPSHOT_KEEP` is deliberately *not* `AVAILABILITY_*`: Phase 0 fixes a pre-existing
gap in `builder_source_snapshots` and must survive a full rollback of this feature.

## AI rung (optional, droppable)

The verdict contains **no LLM**: `computeAvailabilityVerdict()` and
`resolveAvailabilityDisclosure()` are pure, deterministic, and unit-tested, and the endpoint calls
nothing else.

The only permitted AI is one optional sentence explaining an **already-computed** verdict: task
`availability-explain` in `src/shared/lib/ai/tasks.ts` (id verified unregistered at HEAD; the
registry holds `ping`, `query-translate`, `outreach-draft`, `profile-enrich`, `jd-parse`,
`criteria-decompose`, `filter-refine`, `synergy-analysis`, `alert-digest-summary`,
`work-sample-analyze`, `fingerprint-v2`, `timeline-summary`), tier `local-first` (interactive,
ephemeral, this-user-only → Chrome AI first, `/api/ai/complete` MiniMax fallback). Input is
**structured metadata only** — signal labels, source names, ISO dates, bucket — never the subject's
bio, so there is no untrusted-content surface and `wrapUntrusted` is unnecessary by construction.
Output `z.object({ summary: z.string().min(1).max(280) })`, `cacheTtlSeconds: 604800`,
`allowances: { free: 0, pro: 50, team: 200 }` (`Record<PlanTier, number>` — free/pro/team, exactly
the shape `AITaskDefinition` declares), `maxOutputTokens: 300` (MiniMax M3 emits a `<think>` block —
see the `ping` task's note at `tasks.ts:80-85`). The system prompt forbids asserting certainty,
speculating about employers or reasons, and adding any fact not in the input. Ladder: Chrome AI →
MiniMax → **hide the sentence**; the structured signal list is the non-AI rung and the panel works
without it. Hidden entirely when `AI_DISABLED` or the task is disabled.

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
- Zero availability fields in `/api/export/builders`, `/api/feeds/$searchId`, or any email —
  asserted by tests, not by review.
- Zero signal/score rows for any identity with an active processing restriction — asserted by
  `pnpm test:api-isolation:local`. No regression in `pnpm test:rls:local`.

## Resolved edge cases

- **Day-1 cold start**: S3 has zero coverage until the snapshot write path has been live long enough
  to produce two distinct snapshots ≥7 days apart, so nothing can be `open_signal_recent` at launch.
  Expected and acceptable.
- **`hireable` set years ago**: unknowable age ⇒ lowest weight and the hard rule that S1 alone never
  reaches the top bucket. The disclosure says "last seen `<date>`", never "since `<date>`".
- **Person deletes the phrase**: any re-observation that finds no phrase deletes that identity's live
  S2/S3 rows in the same transaction — removal is treated as evidence, not as absence of evidence.
  Without that rule the panel could lag by up to 180 days.
- **Recruiter's own bio** ("hiring engineers, not looking"): the negation list voids the signal.
- **Third-party phrasing** ("we are open to work with partners"): residual FP, mitigated by showing
  the excerpt so a human judges; deliberately not "fixed" with heuristics that create their own errors.
- **A synthesized bio** (`"87% accept rate"`, an npm package description, an HN `Posted: "…"`
  fallback): excluded structurally by `AVAILABILITY_BIO_SOURCE_ALLOWLIST` + the `hn` prefix rule, not
  by hoping the phrase list never matches.
- **Same person on several sources**: signals key on `builder_identity_id`, which is per
  `(source, sourceId)`, so one human yields independent verdicts per source — same as
  `builder_embeddings`. Cross-source merging belongs to
  [`unified-timeline`](../../phase-1/33-unified-timeline/spec.md).
- **Subject claims the profile after a bucket was shown**: rules 2/3 take effect on the next read;
  nothing is cached beyond the request, so no backfill is needed.
- **Restriction withdrawn** (`withdrawBuilderProcessingRestriction`): purged rows do not return; the
  identity is simply re-enqueued and re-collected on the next request.
- **`AVAILABILITY_SIGNALS_ENABLED=false`**: worker no-ops, both endpoints return
  `{ availability: null }`, UI renders nothing. Existing rows are untouched — a flag flip is not a
  deletion event; the Phase 5 admin purge endpoint is how you actually delete them.
