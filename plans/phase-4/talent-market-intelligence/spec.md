# Talent Market Intelligence Reports (spec)

> **Status**: `pending`
> **Depends on**: [`proactive-discovery`](../../phase-1/23-proactive-discovery/spec.md) (the global index breadth every aggregate is computed from — already shipped); [`public-landing-pages`](../../phase-1/45-public-landing-pages/spec.md) (public page shell, SEO, and OG image plumbing — already shipped); [`content-marketing`](../../phase-1/46-content-marketing/spec.md) (the blog/content surface these reports extend — already shipped); [`claimable-profiles`](../../phase-1/36-claimable-profiles/spec.md) (`published_builder_profiles`/`builder_claims`, the entire consent basis for §1 Type B — already shipped). Enhanced by [`smart-alerts`](../../phase-1/34-smart-alerts/spec.md) (digest email delivery; not required).
> **Blocks**: nothing
> **Reality check**: The index exists — `builder_embeddings` (global, no RLS, `src/shared/lib/db/schema.ts:816`) and `builder_identities` (`src/shared/lib/db/schema.ts:139`). The public surface exists — `src/routes/_landing/{blog,changelog,explore}`, `src/routes/sitemap[.]xml.ts`, `src/routes/robots[.]txt.ts`, `src/routes/api/og/explore.tsx`. Public-surface indexing is now *governed*: `src/shared/lib/seo/surfaces.ts` (`SEO_SURFACES`) + `public_surface_indexing` (`drizzle/0082`/`0083`), fail-closed to `noindex`. Cron is now *governed*: `OPERATIONAL_SCHEDULES` in `src/shared/lib/operational-schedules.ts` + `withJobRun` in `src/shared/lib/repositories/platform-operations.ts`. The admin-published-public-content precedent exists — `src/shared/lib/repositories/platform-content.ts` + `src/routes/api/admin/changelog/index.ts`. What does **not** exist: any time series, any aggregate table, any report route.

## Problem

BuilderHunt has a broad multi-source index and no way to turn it into public, self-regenerating
content. Missing: an SEO/top-of-funnel surface that grows without a human writing every page, and
a reason for a data buyer (not a searcher) to pay.

The idea as originally written ("Rust builders +18% this quarter", "the 50 emerging builders in AI
tooling", "only aggregated and anonymous data") has two defects this spec exists to fix, because
shipping it literally would publish dishonest numbers and a non-consensual ranking of named
private individuals.

## Goal

A monthly, precomputed, human-published family of public report pages under `/reports/*` whose
every number comes from SQL over BuilderHunt's own index, is explicitly scoped to that index, and
survives an adversarial read of the methodology. Plus a gated machine-readable tier for buyers who
want the series, not the conclusion.

## Non-goals (each prevents a specific dishonest or unsafe outcome)

- **No claims about the real-world developer population.** Never "Rust developers grew 18%",
  "there are N Rust developers", "demand for X is up". Enforced by a test, not by habit (§2).
- **No raw index-growth metric published as a trend.** `count(*) this month / last month` over
  `builder_embeddings` measures `DISCOVERY_CELLS_PER_RUN`, `DISCOVERY_DAILY_STUB_CAP`, and how
  many users happened to search Rust — not Rust.
- **No coverage number published as a market number.** This is the founding correction of this
  plan and it now has a second edge (§2.1): `builder_embeddings.updated_at` is *also* a coverage
  signal, not an activity signal, and is therefore confined to the coverage envelope.
- **No LLM-produced numbers**, ever (§5).
- **No salary, seniority, employability, or "quality" scoring of individuals.**
- **No anonymous mailing list** — digest recipients are authenticated users with a recorded consent.
- **No new billing tier** — "Insights" is an entitlement on the existing `team`/`pro_max` tiers.
- **No per-request computation**; a public pageview never runs an aggregation.
- **No backfill of history never observed** — the first report is a labelled baseline with no delta.

## 1. The anonymity split — RESOLVED

"Only aggregated and anonymous data" is true of exactly one of the two proposed content types.

**Type A — aggregate report** (`kind = 'aggregate'`): "Rust holds 6.1% of BuilderHunt's indexed
profiles". Genuinely non-personal — no identity is retrievable, and cohorts below `MIN_COHORT`
(200 profiles) are suppressed entirely so no aggregate can be de-anonymised by narrowing. This is
the whole of Phases 1–7 and the entire SEO engine.

**Type B — named ranked list** (`kind = 'named_list'`): "the 50 emerging builders in AI tooling" is
the *opposite* of anonymous — a published, Google-indexed editorial claim about identifiable real
people, derived from inference over data they never submitted. The legitimate-interest balance
fails by default because the subject cannot reasonably expect it and normally never learns the page
exists: BuilderHunt holds no verified contact channel for an unclaimed identity (the claim flow in
`src/shared/lib/repositories/builder-claims.ts` is always subject-initiated). An opt-out nobody can
discover is not a control, and "it's public data" makes publishing a ranking neither lawful nor decent.

**Decision** — named lists are restricted to **published, opted-in** claimed profiles and ship
**disabled** (Phase 8, flag off, zero published lists at launch):

1. Candidates = rows in `published_builder_profiles` **AND** a new
   `published_builder_profiles.include_in_public_rankings` boolean, `default false`, settable only
   by the subject in their own editor. Opt-in, not opt-out.
2. **The candidate predicate keys on `published_builder_profiles` alone — it must not join
   `builder_claims`.** `builder_claims` has `FORCE ROW LEVEL SECURITY` with exactly three
   policies, all `TO builderhunt_app` and all scoped
   `subject_user_id = current_setting('app.user_id')` (`drizzle/0011_builder_claim_policies.sql:1-16`).
   An anonymous public render has no `app.user_id`, so the join would silently return zero rows —
   the worst possible failure for a privacy filter, because "nobody is eligible" and "the filter is
   broken" look identical. A row in `published_builder_profiles` is already proof of a verified
   claim: the tree's only `insert(publishedBuilderProfiles)` sits in the private helper
   `publishVerifiedProfile` (`src/shared/lib/repositories/builder-claims.ts:96-112`), reached from
   exactly two call sites — `verifyPendingBuilderClaim` (line 152) and
   `verifyBuilderClaimBySourceProof` (line 184) — both of which have just written
   `builderClaims.status = 'verified'` for the calling subject. Thereafter only
   `updateVerifiedBuilderProfile` (line 232) mutates it, scoped to
   `published_by_user_id = subjectUserId`. Its app SELECT policy is `USING (true)`
   (`drizzle/0011:17-18`), so it *is* legitimately readable anonymously.
   Claim revocation therefore has to be honoured by the subject un-publishing; the render-time
   filter in point 4 plus the `builder_processing_restrictions` check are the live controls.
3. Anyone with an active `builder_processing_restrictions` row is excluded, via the existing
   `is_builder_processing_restricted(text)` SQL function
   (`drizzle/0017_enrichment_rls_policies.sql:70`), whose `EXECUTE` is granted to
   `builderhunt_app` and `builderhunt_worker` (`drizzle/0017:82`) — both roles this plan needs.
4. **Eligibility is re-evaluated at render time, never frozen at generation time.** Entries store
   `builder_identity_id` + `rank` only — never a denormalized name or bio. The public loader joins
   live and drops anyone who un-published, revoked the opt-in, or gained a restriction. A
   withdrawal takes effect on the next pageview, no regeneration, no admin action.
5. Publishable only at ≥ 25 eligible candidates for the topic; otherwise it stays an
   "insufficient opt-in" draft forever. Today that count is ~0 — hence capability-only.
6. Ordering uses only subject-supplied or first-party-observable signals (`published_builder_profiles.topics`,
   `builder_identities.followers_count`, profile-change activity). Never an AI ranking, never a
   "potential" score.

Honest consequence: the SEO value of the named-list type is deferred, possibly permanently. That is
the correct trade.

## 2. Can the trend even be computed? — RESOLVED (the load-bearing section)

Audited what the schema supports, re-audited against HEAD on 2026-07-27:

| Candidate                                      | Verdict                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builder_source_snapshots.observed_at`         | **Not a live series.** Its only writer in the repo is still the one-shot backfill `scripts/db/backfills/builders.ts:109-112`; no runtime path inserts snapshots. Unusable.       |
| `builder_identities.first_seen_at`             | **Will have two writers.** `trackOrganizationBuilder` (`src/shared/lib/repositories/organization-builders.ts:274`, the only `insert(builderIdentities)` in the tree at HEAD) stamps it when a tenant tracks someone; [`collaboration-graph`](../collaboration-graph/spec.md)'s crawler will stamp it for co-contributors nobody tracked. Either way: customer-choice biased or crawler biased, and small. Unusable as a population frame — see the touchpoint below. |
| `builder_embeddings.created_at`                | The only broad time dimension. `created_at` = when one of the ingestion paths in §2.2 first indexed the profile. **Usable, with care.**                                          |
| `builder_embeddings.updated_at`                | **Not a content-change signal — a coverage signal.** See §2.1. Confined to the coverage envelope.                                                                                |
| `discovery_state.stats`                        | Cumulative `{runs, upserted, errors}` only (`src/shared/lib/db/schema.ts:853-856`), no per-period history. Usable only as a coverage witness once snapshotted monthly.            |
| `builder_embeddings.profile->topics/language`  | The topic signal. Deterministic keyword match, no LLM.                                                                                                                          |

So: **no historical time series exists today, and the one time dimension that does is
crawler-driven.** Growth in what BuilderHunt indexed is growth of BuilderHunt's crawler. Publishing
index growth as market growth is a lie about a measurement and the fastest possible way to destroy
the credibility this surface exists to build.

### 2.1 The `updated_at` correction (found by the 2026-07-27 re-audit)

The earlier draft of this spec said "`updated_at` bumps on a `content_hash` change" and built a
published metric — "cohort activity rate" — on top of it. **That is false at HEAD**, in two ways,
both in `src/shared/lib/repositories/public-builder-embeddings.ts`:

- `upsertBuilderEmbeddingStub`'s `onConflictDoUpdate` sets `updatedAt: sql\`now()\`` **unconditionally**
  (line 43). The content-hash comparison on lines 44–45 governs only whether the *embedding vector*
  is invalidated. Re-encountering a byte-identical profile bumps `updated_at`.
- `markBuilderEmbeddingsEmbedded` sets `updatedAt: new Date()` (line 72) when the embedding
  backfill worker fills in a vector. That is a purely internal event with no relation to the
  builder at all, and it fires for essentially every row shortly after creation.

So `updated_at` means **"the last time one of BuilderHunt's own pipelines touched this row"**. It is
a re-crawl frequency, i.e. *coverage*. Publishing it as "cohort activity" would be the founding
error of this plan committed a second time through a different column, and — since this is a
public, quotable surface — it would be a public, quotable error.

**Decision (not a hedge): the measurement stays, the publication does not.** The quantity is
renamed `cohortReobservationRate`, moved out of `ReportMetrics` and into `ReportCoverage`, rendered
inside `<ReportMethodology>` as a coverage witness under the heading "how often we re-touched this
cohort", and is never phrased as builder activity. A true content-change rate would require a
per-row content-hash history that no table holds; inventing one is a third table and out of scope,
and the honest alternative to a metric we cannot compute is not to publish it.

### 2.2 The metric contract — every published number is one of these three

Each carries a **declared population**, a required `population` field on the metrics row. All three
are `'indexed_profiles'`: they are computed over `builder_embeddings`, never over
`builder_identities` (§2.3 explains why that distinction now matters).

**Definition of `indexed_profiles(P)`** — the count of `builder_embeddings` rows with
`created_at <= periodEnd(P)`. One row is one `(source, source_id)` pair
(`builder_embeddings_source_unique`), so a person present on GitHub and on DEV.to is two rows. It
is *rows in an index*, not people, and the methodology block says so.

**Definition of `topic_profiles(X, P)`** — the count of `indexed_profiles(P)` rows where
`matchesTopic(profile, X)` holds: a case-insensitive exact match of any keyword in
`DISCOVERY_TOPIC_KEYWORDS[X]` against an element of `profile->'topics'` or against
`profile->>'language'`. Never against `document` (free-text prose; a bio reading "I don't write
Rust" would match).

1. **Composition share** — `topic_profiles(X, P) / indexed_profiles(P) * 100`, both measured at the
   same `periodEnd`. Index growth cancels in the ratio.
   *Source*: `builder_embeddings`. *Label*: "of BuilderHunt's indexed profiles".
   *This is NOT*: a share of developers, of the labour market, or of anything outside the index.
   Two topics' shares do not sum meaningfully — a profile can match several.
2. **Like-for-like share delta** — `share(X, P) − share(X, P−1)`, expressed in **percentage points**,
   computed **only** when `coverage.matrixVersion` is identical in both periods **and**
   `coverage.cellsCoveredInPeriod` of `P−1` is a subset of that of `P`. Otherwise `null` with
   `shareDeltaReason: 'coverage_changed'`. This is the honest replacement for "+18% this quarter":
   a *share* moved, inside a *fixed frame*.
   *Source*: two `market_report_snapshots` rows for the same `topic_slug`.
   *This is NOT*: growth, a relative percentage, or a rate of change of anything real. A `+0.4 pp`
   move can happen with the topic's absolute count falling, if other topics fell faster.
3. **Topic co-occurrence** — for each other topic `Y`, the share of `topic_profiles(X, P)` that also
   satisfies `matchesTopic(profile, Y)`, top 8 by share.
   *Source*: `builder_embeddings`. *This is NOT*: a claim that these skills co-occur among
   developers; it is a claim about how profiles in this index are labelled, and labelling is a
   property of the sources crawled.

And, in the coverage envelope only, never as a headline:

4. **Cohort re-observation rate** (`coverage.cohortReobservationRate`) — of the `builder_embeddings`
   rows with `created_at` inside period `P`, the fraction whose `updated_at` falls inside `P+1`.
   *Source*: `builder_embeddings`. *This measures*: how often BuilderHunt's own ingestion and
   embedding pipelines re-touched that cohort. *This is NOT, and must never be labelled as*:
   builder activity, profile freshness, or engagement — see §2.1 for exactly why.

Guards, pure and unit-tested in `src/shared/lib/market-reports/metrics.ts`:

- `MIN_COHORT = 200` per topic per period — below it the topic is `suppressed: true` and is listed
  as "insufficient data", never published with a number. Doubles as the k-anonymity floor.
- `MIN_PERIODS = 2` for any delta.
- Deltas are expressed in percentage points (`+0.4 pp`) and the module exports no function that
  returns a ratio of two raw index counts, so "+18%" is not expressible through its public API.
- `assertNoForbiddenClaim(text)` rejecting `developers grew`, `market size|growth|demand`,
  `there are N`, and bare relative-percent growth tokens — run over both AI and template narrative
  before persist, and again at publish time.
- `assertPopulationDeclared(metrics)`, which throws when a metrics row omits `population` or names
  one absent from `POPULATIONS`, so no number can be published whose population is ambiguous.

### 2.3 Cross-plan touchpoints (conventions rule 6)

- **`builder_identities` — shared surface, second writer (future).**
  [`collaboration-graph`](../collaboration-graph/spec.md) becomes a second writer of this table:
  its crawler inserts co-contributors no tenant ever tracked, and `first_seen_at` is
  `.defaultNow().notNull()`, so every such insert stamps it. It owns the additive nullable
  `builder_identities.discovered_by`. **The column does not exist at HEAD** (verified:
  `grep discovered_by src/shared/lib/db/schema.ts drizzle/*.sql` → no match), and
  `collaboration-graph` precedes this plan in [`plans/phase-2/README.md`](../README.md)'s build
  order. **This plan adds no predicate on `discovered_by` and needs none** — every metric above is
  keyed on `builder_embeddings`. If a future task here ever wants one, it is a hard error unless
  that plan has shipped; the repository task in tasks.md carries the guard note.
- **`builder_embeddings` — the population this plan actually measures, and its writer set changed.**
  The earlier draft claimed "its writers today are `src/lib/semantic/index-writer.ts` and
  `src/lib/discovery/worker.ts`". At HEAD that is wrong on both halves, so the guard is redesigned
  around what is actually stable — the two-layer set below, both pinned in `metrics.ts` and both
  cross-checked by a build-failing test:
  - **`INDEX_WRITE_CHOKEPOINT`** = `src/shared/lib/repositories/public-builder-embeddings.ts`. It is
    the *only* module in the tree emitting `INSERT`/`UPDATE` SQL against `builder_embeddings`
    (`upsertBuilderEmbeddingStub`, `markBuilderEmbeddingsEmbedded`). `src/lib/discovery/worker.ts`
    does not write the table at all — it writes `discovery_state` and calls `upsertEmbeddingStubs`.
  - **`INDEX_ROW_CREATORS`** = the modules that can cause a *new row* to appear, i.e. that call
    `upsertEmbeddingStubs` from `src/lib/semantic/index-writer.ts`. At HEAD, exactly five:
    `src/lib/discovery/worker.ts`, `src/lib/semantic/semantic-search.ts`,
    `src/lib/sprints/semantic-write-through.ts`, `src/routes/api/builders/track.ts`,
    `src/routes/api/search/builders.ts`. The third of those (`ai-sourcing-sprints`) appeared after
    this plan was first written — proof the guard is needed rather than theoretical.
  This set is not trivia: it *is* the sampling frame. "Indexed profiles" means "profiles some
  BuilderHunt crawl, search, sprint or track action happened to touch", and the five paths are what
  make that sentence true. `coverage.indexRowCreators` carries the list into every published
  report's methodology block, and the test fails the build when the set changes, forcing whoever
  adds a sixth to update the published methodology in the same commit.
  `collaboration-graph` does **not** write `builder_embeddings`, and must not start.
- Shared surfaces this plan does **not** touch: `builders.metadata`, `organization_builders`,
  `PLAN_LIMITS`, the search pipeline. It adds `MARKET_INSIGHTS_ACCESS` to `billing-shared.ts`, one
  AI task id (`market-report-narrative`) to `tasks.ts`, `market_digest` to `user_consents.document`,
  a `reports` entry to `SEO_SURFACES`, and two entries to `OPERATIONAL_SCHEDULES`. All verified
  unclaimed at HEAD.

### 2.4 Mandatory methodology disclosure

Every public report renders `<ReportMethodology>` **from the row's `coverage` JSON**, not from
prose, so it cannot drift from the data. In order: period boundaries; that the population is
BuilderHunt's own index, a convenience sample assembled by a crawler and by user searches, not a
census; **the named ingestion paths from `coverage.indexRowCreators`**; the exact metric definitions
from §2.2 including each metric's "this is NOT" line; the period's crawl coverage (cells covered,
matrix version, daily cap, indexed total, newly indexed, discovery-vs-search attribution,
cohort re-observation rate labelled as coverage); the suppression threshold; and the sentence
**"These figures describe BuilderHunt's index. They are not a measurement of the global developer
population."** The same sentence appears in the OG image, the digest email, and the `Dataset`
JSON-LD (`measurementTechnique`, `variableMeasured`). Not collapsible.

## 3. Architecture

### Precomputed snapshots — why a table, and which data class

An SEO surface cannot aggregate on pageview: the composition query scans the index and a crawler
hits 30+ report URLs in a burst. Reports are computed once monthly by a worker and served as one
indexed row read.

**Data class: global public** (per [`security-policy`](../../_meta/security-policy.md)), identical
class and controls to `changelog`/`roadmap_items`/`incidents`: no `organization_id`, no RLS, DTO
allowlist on read, publication policy, provenance. "System operational" was rejected because the
row's *purpose* is publication to anonymous visitors — the operational counterpart (crawl cursor)
already exists separately as `discovery_state`, and a mixed-class table is forbidden. Draft rows are
not public; that is a `status` filter in the public repository, not a different class. No tenant
data of any kind enters these tables.

```ts
// src/shared/lib/db/schema.ts (additions)
export const marketReportSnapshots = pgTable('market_report_snapshots', {
  id: text('id').primaryKey(),                            // randomId()
  slug: text('slug').notNull(),                           // 'rust-2026-07'
  kind: text('kind').notNull(),                           // 'aggregate' | 'named_list'
  topicSlug: text('topic_slug').notNull(),                // DISCOVERY_TOPIC_SLUGS member
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  version: integer('version').notNull().default(1),
  status: text('status').notNull().default('draft'),      // draft|published|superseded|withdrawn
  metrics: jsonb('metrics').$type<ReportMetrics>().notNull(),     // SQL-derived only
  coverage: jsonb('coverage').$type<ReportCoverage>().notNull(),  // crawl-bias envelope
  narrative: text('narrative'),                           // prose, contains no digits
  narrativeSource: text('narrative_source').notNull().default('template'), // template|ai
  correctionNote: text('correction_note'),
  supersedesVersion: integer('supersedes_version'),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedByUserId: text('published_by_user_id').references(() => authUsers.id, { onDelete: 'set null' }),
  digestSentAt: timestamp('digest_sent_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('market_report_snapshots_slug_version_unique').on(t.slug, t.version),
  uniqueIndex('market_report_snapshots_published_slug_unique').on(t.slug).where(sql`${t.status} = 'published'`),
  index('market_report_snapshots_kind_period_idx').on(t.kind, t.periodEnd),
  check('market_report_snapshots_kind_check', sql`${t.kind} in ('aggregate','named_list')`),
  check('market_report_snapshots_status_check', sql`${t.status} in ('draft','published','superseded','withdrawn')`),
])

// Named lists store references + rank only, so eligibility can be re-checked live (§1.4).
export const marketReportListEntries = pgTable('market_report_list_entries', {
  reportId: text('report_id').notNull().references(() => marketReportSnapshots.id, { onDelete: 'cascade' }),
  builderIdentityId: text('builder_identity_id').notNull().references(() => builderIdentities.id, { onDelete: 'cascade' }),
  rank: integer('rank').notNull(),
  basis: jsonb('basis').$type<{ signal: string; value: number }>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.reportId, t.builderIdentityId] }),
  uniqueIndex('market_report_list_entries_report_rank_unique').on(t.reportId, t.rank),
])
```

Zod shapes in `src/shared/lib/market-reports/schema.ts`:

```ts
export const POPULATIONS = ['indexed_profiles'] as const

export const reportMetricsSchema = z.object({
  population: z.enum(POPULATIONS),
  indexedTotal: z.number().int().nonnegative(),
  topicCount: z.number().int().nonnegative(),
  sharePct: z.number().min(0).max(100),
  shareDeltaPp: z.number().nullable(),            // null => not computable
  shareDeltaReason: z.enum(['ok', 'coverage_changed', 'no_prior_period', 'insufficient_cohort']),
  coOccurringTopics: z.array(z.object({ topicSlug: z.string(), sharePct: z.number() })).max(8),
  suppressed: z.boolean(),
})

export const reportCoverageSchema = z.object({
  matrixVersion: z.string(),                     // sha256 of sorted DISCOVERY_MATRIX cell keys
  cellsCoveredInPeriod: z.array(z.string()),
  dailyStubCap: z.number().int(),
  newlyIndexed: z.number().int(),
  discoveryAttributedPct: z.number().min(0).max(100),
  minCohort: z.number().int(),
  comparablePriorPeriod: z.boolean(),
  // §2.1 — a coverage witness, NOT a published activity metric.
  cohortReobservationRate: z.number().min(0).max(1).nullable(),
  // §2.3 — the sampling frame, rendered verbatim in the methodology block.
  indexRowCreators: z.array(z.string()).min(1),
})
```

**Immutability: versioned, not mutable.** A published row is never updated except
`status → superseded|withdrawn` and `digestSentAt`. A correction inserts `version + 1` with a
required `correctionNote`; the old version stays fetchable at `/reports/$slug?v=N` behind a
"superseded" banner; canonical always points at the newest published version. Reason: these pages
will be cited, and silently editing a number a third party quoted is precisely the failure mode
this design exists to avoid.

### Generation worker

`POST /api/admin/market-reports/run-worker`, cloning `src/routes/api/admin/alerts/run-worker.ts`
exactly: `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`, the body
wrapped in `withJobRun({ jobKey: 'market-reports.generate' })`, then
`auditPlatformAdminAction(principal, { action: 'admin.worker.run', targetType: 'worker', targetId:
'market-reports', result: 'allowed' })`, with `platformAdminErrorResponse(err)` as the fallback.

**Cadence is declared, not doc-commented.** `OPERATIONAL_SCHEDULES` in
`src/shared/lib/operational-schedules.ts` is now the single registry the ops feed, the admin panel
and `POST /api/admin/operations/sync-schedules` all read, and `withJobRun` joins `job_runs` to it by
`jobKey`. This plan adds two entries — `market-reports.generate` (`0 3 1 * *`,
`Europe/Copenhagen`, scope `platform`) and `market-reports.digest` (`0 9 2 * *`, scope `platform`).
`assertRegistryIsSafe` (`operational-schedules.ts:137`) enforces unique `jobKey` and an
`/api/admin/` `sourceRoute`; both new keys are free at HEAD.

**Generates drafts only — it never publishes.** Topic set = `DISCOVERY_TOPIC_SLUGS`, a new export
derived from the private `TOPICS` array in `src/lib/discovery/matrix.ts` (30 entries at HEAD), so
reported topics and the crawl frame are the same list by construction. One transaction per report
(`workerDb` from `~/shared/lib/db/worker-db`), so a failing topic cannot roll back another.
Idempotent via `ON CONFLICT (slug, version) DO NOTHING`; `?force=true` regenerates **drafts only**
and refuses published rows. Returns
`{ periodStart, periodEnd, generated, skippedExisting, insufficientData, failed }`.

### Publishing

Reuses the changelog/roadmap pattern (`repositories/platform-content.ts` +
`routes/api/admin/changelog/index.ts`) with a new admin page
`src/routes/_dashboard/admin/market-reports.tsx`. A human platform admin reads the draft's numbers,
coverage and narrative, then publishes; `POST /api/admin/market-reports/$id/publish` is the only
writer of `status='published'` and re-runs `assertNoForbiddenClaim`, audited via
`auditPlatformAdminAction`. Withdrawal is one click and immediately removes the page from the index
and its sitemap entry.

## 4. Public surface

**DB-backed, not file-based like the blog.** The blog is hand-written essays in `content/posts/`
loaded by `src/shared/lib/blog.ts`; reports are ~30 machine-generated pages per month needing
period/topic querying, versioning, and — for named lists — a *live* eligibility filter a static
file physically cannot do. The blog stays file-based.

- `src/routes/_landing/reports/index.tsx` (published reports by period/topic) and
  `.../reports/$slug.tsx` (headline share, pp delta or an explicit "not comparable" note,
  co-occurrence, narrative, `<ReportMethodology>`, prior-version link, `/explore` CTA).
- Loaders via `createServerFn` in `src/shared/lib/reports-data.ts`, mirroring `blog-data.ts`
  (including its `/^[a-z0-9-]{1,160}$/` slug validator), so pages are server-rendered. Do **not**
  copy `_landing/changelog/$slug.tsx`, which client-fetches `/api/changelog/$slug` in a
  `React.useEffect` (line 42) and is therefore invisible to crawlers.
- **Indexing is admin-governed and fails closed.** `/reports` must be registered as a fourth
  surface in `SEO_SURFACES` / `SEO_SURFACE_DEFINITIONS` (`src/shared/lib/seo/surfaces.ts:14,32`)
  with a seeded `public_surface_indexing` row, and its route heads, `robots[.]txt.ts` and
  `sitemap[.]xml.ts` must consult `getSurfaceDirectives()` exactly as `/blog`, `/changelog` and
  `/roadmap` already do. `DEFAULT_DIRECTIVES` is `{ noindex: true, nofollow: true }`
  (`surfaces.ts:60`) and `drizzle/0083:31-33` seeds the existing three as hidden, so **`/reports`
  will not be indexed until a platform admin flips it in `/admin/content`** — that flip is an
  explicit launch step, not an oversight, and §8's SEO metrics start counting from it.
- **Canonical URLs need no new code.** `src/routes/__root.tsx:62` already emits
  `{ rel: 'canonical', href: canonicalUrl }` on every route, built at lines 14–16 from the leaf
  match's `pathname` — search params are already excluded, so `/reports/$slug?v=1` canonicalises to
  `/reports/$slug` exactly as required. Report routes therefore **must not** add their own
  `links: [{ rel: 'canonical' }]`: a second tag on the same page is what search engines treat as
  conflicting. The only report-specific `meta` requirements are the surface directives above and
  `noindex` on withdrawn and explicitly-requested superseded versions.
- **Sitemap**: `src/routes/sitemap[.]xml.ts` gains `/reports` plus published slugs from one indexed
  query, gated on `!isHiddenFromSitemap(surfaces.reports)` like the blog/changelog/roadmap blocks
  (lines 90–109) and wrapped in its own try/catch so a failure of *the reports query* cannot take
  the sitemap down. Note the route as a whole is not fail-soft today — `getSurfaceDirectives()` is
  (it swallows and returns defaults), but `listAllPublicRadarSlugs()` and
  `listPublishedPortfolioClaimIds()` at lines 124/137 are not, so a full DB outage already 500s the
  sitemap. Making the whole route fail-soft is a pre-existing improvement, out of this plan's scope.
- **OG image**: `src/routes/api/og/report.tsx`, cloned from `api/og/explore.tsx` (1200×630 SVG →
  `@resvg/resvg-js` PNG, same `escapeXml`/`truncate` helpers, same fallback-to-SVG), with the
  "of BuilderHunt's index" qualifier baked into the image so a shared card cannot lose the caveat.
- **Structured data**: `Dataset` (`temporalCoverage`, `measurementTechnique`, `variableMeasured`,
  `creator`) — deliberately not `Article`, because this is data — plus `BreadcrumbList`; named lists
  add `ItemList` built from the live-filtered entries only.

## 5. AI — narrative only, numerically muzzled

Numbers come from SQL. The optional AI layer writes connective prose and nothing else.

- Task `market-report-narrative` in `src/shared/lib/ai/tasks.ts`, tier **`server-only`** (persisted
  + shared + background, per [`ai-policy`](../../_meta/ai-policy.md)'s decision rule). The id is
  unclaimed at HEAD.
- **Input carries no figures**: `{ topicLabel, direction: 'rose'|'flat'|'fell'|'unknown',
  comparable: boolean, coOccurringTopicLabels: string[] }`. The model cannot restate a number it
  was never given.
- **Output has no numeric fields and forbids digits**: `z.object({ headline: z.string().min(10).max(90),
  paragraphs: z.array(z.string().max(400)).min(2).max(3), caveat: z.string().max(200) })` refined to
  reject `/\d/` anywhere, plus `assertNoForbiddenClaim`. Failure → one retry (`minimaxChat` already
  retries) → **template fallback** with `narrativeSource: 'template'`.
- The page interpolates `metrics` into fixed sentences around the prose — templated numbers only.
- `cacheTtlSeconds: 2592000`, `maxOutputTokens: 700`, `allowances: { free: 0, pro: 0, team: 0 }` —
  zero on every tier means no end user can invoke it via `/api/ai/complete`
  (`src/shared/lib/ai/budget.ts:27` returns `{ allowed: false, reason: 'plan' }` at limit 0). The
  worker calls `minimaxChat` directly with the registry definition, as
  `src/lib/semantic/semantic-search.ts` does, capped at `NARRATIVE_MAX_PER_RUN = 12` per run in
  lieu of a per-user budget.
- Every narrative, AI or template, is read by a human before publish. Publishing *is* the review.

**Cost model**: ≤ 12 calls/month at ~500 in + ~500 out tokens ⇒ ~12k tokens/month. Negligible,
absorbed by the platform, not a tenant. Zero AI calls in any read path.

## 6. Monthly digest email — a consent surface

A marketing digest to a list is not transactional. Resend exists (`src/shared/lib/email.ts`;
`sendAlertDigestEmail` at line 249 is the shape to copy, including the `E2E_MODE` outbox
short-circuit at line 41) and no new mailing-list system is built.

- **Opt-in only, authenticated users only.** Reuses `user_consents` (`src/shared/lib/db/schema.ts:663`
  — free-text `document`/`version`, no check constraint): `document: 'market_digest'`,
  `version: 'v1'`. `/api/consent`'s `ConsentBody` enum (`src/routes/api/consent/index.ts:14`) gains
  `market_digest`, but its local `CURRENT_VERSIONS` map (line 7) does **not** — a missing marketing
  consent must never appear in `needsAcceptance` and block the app.
- **Withdrawal must work**, so `user_consents` gains a nullable `revoked_at` (expand-only).
  Subscribed = a `market_digest` row with `revoked_at IS NULL`. That is the entire subscriber list.
- **One-click unsubscribe**: `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click` headers and a
  signed link (HMAC-SHA256 over `market-digest:v1:<userId>` with `BETTER_AUTH_SECRET`) to
  `/api/reports/digest/unsubscribe` — no login required, honoured immediately, constant-time
  comparison mirroring `secretsMatch` in `src/shared/lib/auth/cron.ts`.
- Sending is separate from publishing: `POST /api/admin/market-reports/send-digest`, admin/cron
  auth, per-recipient try/catch, idempotent via `digest_sent_at` (refuses a resend without
  `?force=true`). Carries the methodology sentence verbatim; never includes a named list.

## 7. Insights tier

| Surface                                                                                                                     | Access                   |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `/reports` + `/reports/$slug` HTML, latest period, ~10 curated topics, methodology, coverage envelope, co-occurrence         | Public, anonymous        |
| `GET /api/reports/$slug/data` (JSON) and `GET /api/reports/series?topic=` (full history, all `DISCOVERY_TOPIC_SLUGS`, JSON/CSV) | **Insights entitlement** |
| Per-topic breakdowns beyond the curated set                                                                                 | **Insights entitlement** |

Gate: `MARKET_INSIGHTS_ACCESS: Record<OrganizationTier, boolean> =
{ free: false, pro: false, pro_max: true, team: true }` in `src/shared/lib/billing-shared.ts`,
beside `SOURCING_SPRINT_LIMITS`.

**Keyed by `OrganizationTier`, deliberately not by `PlanTier` + `resolveLegacyPlanTier`.** An
earlier draft of this spec specified the latter. `billing-shared.ts:39-53` documents that exact
pattern as a shipped bug: `SOURCING_SPRINT_LIMITS` used to be `Record<PlanTier, number>`, which
forced enforcement sites through `resolveLegacyPlanTier` and let the advertised allowance and the
enforced one disagree — `/pricing` promised Pro Max three sprints while the code allowed ten. The
fix was to key on `OrganizationTier` and index it directly with `entitlement.tier`, which is what
`src/routes/api/sprints/index.ts:41` does today. This plan follows the fixed pattern, not the one
that caused the bug. Denials return `403 { error: 'plan', upgradeUrl: '/pricing' }`. A
`PLAN_PRICING.team.features` bullet is added.

**With `STRIPE_BILLING_ENABLED=false` (its default, `src/shared/lib/env.ts:141`)** nobody self-serve
upgrades, so the entitlement is granted the same way every other paid capability is granted right
now — admin action on `organization_entitlements`. The gate is real and enforced from day one; only
the purchase path is missing, and that belongs to `stripe-billing-platform`.

## 8. Success metrics

- **SEO**: measured from the date a platform admin flips the `reports` surface to indexable in
  `/admin/content` (§4) — not from deploy. ≥ 60% of published report URLs indexed in Search Console
  within 60 days of that flip; organic impressions to `/reports/*` ≥ 30% of `/blog/*` within 90 days.
- **Funnel**: sign-up rate of `/reports/*` entry sessions, reported separately from `/explore` and
  `/blog` so the surface is judged on its own.
- **Integrity (the metric that matters most)**: zero published reports containing a forbidden claim
  (audited by `assertNoForbiddenClaim` over every published row in CI); ≤ 1 correction per 12
  published reports; 100% of published reports render a non-empty coverage envelope naming its
  ingestion paths.
- **Insights**: organizations hitting the gated data API; conversions attributed to `/reports` entry.
- **Cannibalization — named risk**: free public reports plausibly reduce the reason to buy the
  insights tier. Mitigation is a deliberate split (free = the conclusion, latest period, ~10 topics;
  paid = full series, every topic, machine-readable). If after two quarters `/reports` traffic grows
  while insights conversions stay at zero, the correct conclusion is that the paid tier has no
  market and the free surface is a marketing cost — **not** that more should be paywalled.
  Second-order risk: the reports teach competitors what BuilderHunt's index covers; accepted, since
  coverage disclosure is the price of honesty.

## 9. Resolved edge cases

- **First run**: no prior period ⇒ `shareDeltaPp: null`, `reason: 'no_prior_period'`; the page
  prints "baseline period — no comparison available" instead of a delta.
- **Matrix edited between periods**: `matrixVersion` differs ⇒ every delta is `null` with
  `reason: 'coverage_changed'` and the methodology block says the frame changed. Shares still publish.
- **Tiny topic**: cohort < 200 ⇒ `suppressed: true`, listed as "insufficient data", never published
  with a number. Doubles as the k-anonymity floor.
- **Number wrong after publication**: new version + `correctionNote`; the old version stays
  reachable and banners itself. Never an in-place edit.
- **Subject objects to a named-list appearance**: un-publish, revoke the opt-in, or a
  `builder_processing_restrictions` row each remove them at the next render, with no admin action.
- **Withdrawn report**: the slug keeps returning **200** with an explicit "withdrawn" body,
  `{ name: 'robots', content: 'noindex, follow' }`, and no sitemap entry — deliberately not a 404,
  410 or soft-404, because a page that already carries citations should explain that its numbers
  were withdrawn rather than vanish. (The canonical tag stays; it is emitted for every route by
  `__root.tsx` and `noindex` is the control that matters here.)
- **Missing grants against the real runtime role**: exactly what silently broke semantic search and
  the discovery worker (`drizzle/0025_public_tables_app_grants.sql`) — and it bites this plan in
  three places, all verified at HEAD:
  1. `drizzle/0025:19` grants `builder_embeddings` to `builderhunt_app` **only**, while the
     generation worker aggregates that table as `builderhunt_worker` ⇒ the grants migration must add
     `GRANT SELECT ON TABLE builder_embeddings TO builderhunt_worker`.
  2. `published_builder_profiles` is granted to `builderhunt_app` only (`drizzle/0011:33`) **and**
     has `FORCE ROW LEVEL SECURITY` with app-only policies (`drizzle/0011:3-4,17-28`) ⇒ the named-list
     generator running as `builderhunt_worker` would get `42501` on the grant and, once granted,
     zero rows from RLS. The grants migration must add both a `SELECT` grant and a
     `FOR SELECT TO builderhunt_worker USING (true)` policy. That is not a privacy expansion: the
     app-role policy on the same table is already `USING (true)` because these are, by definition,
     profiles their subjects published.
  3. `builder_claims` must **not** be read by either role for this feature — see §1.2.
  Mandatory task: extend `scripts/db/verify-api-isolation-local.mjs` to cover **every** table the
  worker touches (including pre-existing ones) plus the public routes as `builderhunt_app` — a guard
  limited to the new tables would have missed `0025`'s bug too.
- **`MINIMAX_API_KEY` unset / `AI_DISABLED=true`**: template narrative; everything else identical.
- **Crawler burst**: one indexed row read per page plus
  `Cache-Control: public, s-maxage=3600`, the same header the sitemap and OG routes already use.
