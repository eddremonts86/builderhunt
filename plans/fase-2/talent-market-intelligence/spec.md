# Talent Market Intelligence Reports (spec)

> **Status**: `pending`
> **Depends on**: [`proactive-discovery`](../../proactive-discovery/spec.md) (the global index breadth every aggregate is computed from — already shipped); [`public-landing-pages`](../../public-landing-pages/spec.md) (public page shell, SEO, and OG image plumbing — already shipped); [`content-marketing`](../../content-marketing/spec.md) (the blog/content surface these reports extend). Enhanced by [`smart-alerts`](../../smart-alerts/spec.md) (digest email delivery; not required).
> **Blocks**: nothing
> **Reality check**: The index exists — `builder_embeddings` (global, written by every search and by `src/lib/discovery/worker.ts`) and `builder_identities` (`src/shared/lib/db/schema.ts:138`). The public surface exists — `src/routes/_landing/{blog,changelog,explore}`, `src/routes/sitemap[.]xml.ts`, `src/routes/api/og/explore.tsx`. The admin-published-public-content precedent exists — `src/shared/lib/repositories/platform-content.ts` + `src/routes/api/admin/changelog/index.ts`. What does **not** exist: any time series, any aggregate table, any report route.

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

**Decision** — named lists are restricted to **claimed, published, explicitly opted-in** profiles
and ship **disabled** (Phase 8, flag off, zero published lists at launch):

1. Candidates = `published_builder_profiles` (subject claimed and published it themselves) **AND** a
   new `published_builder_profiles.include_in_public_rankings` boolean, `default false`, settable
   only by the subject in their own editor. Opt-in, not opt-out.
2. Anyone with an active `builder_processing_restrictions` row is excluded, via the existing
   `is_builder_processing_restricted` SQL function (see `repositories/enrichment-restrictions.ts`).
3. **Eligibility is re-evaluated at render time, never frozen at generation time.** Entries store
   `builder_identity_id` + `rank` only — never a denormalized name or bio. The public loader joins
   live and drops anyone who lost the claim, un-published, revoked the opt-in, or gained a
   restriction. A withdrawal takes effect on the next pageview, no regeneration, no admin action.
4. Publishable only at ≥ 25 eligible candidates for the topic; otherwise it stays an
   "insufficient opt-in" draft forever. Today that count is ~0 — hence capability-only.
5. Ordering uses only subject-supplied or first-party-observable signals (claimed `topics`,
   `followersCount`, profile-change activity). Never an AI ranking, never a "potential" score.

Honest consequence: the SEO value of the named-list type is deferred, possibly permanently. That is
the correct trade.

## 2. Can the trend even be computed? — RESOLVED (the load-bearing section)

Audited what the schema supports:

| Candidate                                      | Verdict                                                                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `builder_source_snapshots.observed_at`         | **Not a live series.** Its only writer in the repo is the one-shot backfill `scripts/db/backfills/builders.ts:110`; no runtime path inserts snapshots. Unusable.                 |
| `builder_identities.first_seen_at`             | **Two writers.** `trackOrganizationBuilder` (`repositories/organization-builders.ts:216`) stamps it when a tenant tracks someone; [`collaboration-graph`](../collaboration-graph/spec.md)'s crawler stamps it for co-contributors nobody tracked. Tenant-tracked identities are exactly those with `discovered_by IS NULL`. Either way: customer-choice biased or crawler biased, and small. Unusable as a population frame — see the touchpoint below. |
| `builder_embeddings.created_at` / `updated_at` | The only broad time dimension. `created_at` = when our crawler *or a user's search* first indexed the profile; `updated_at` bumps on a `content_hash` change. **Usable, with care.** |
| `discovery_state.stats`                        | Cumulative `{runs, upserted, errors}` only, no per-period history. Usable only as a coverage witness once snapshotted monthly.                                                   |
| `builder_embeddings.profile->topics/language`  | The topic signal. Deterministic keyword match, no LLM.                                                                                                                          |

So: **no historical time series exists today, and the one time dimension that does is
crawler-driven.** Growth in what BuilderHunt indexed is growth of BuilderHunt's crawler. Publishing
index growth as market growth is a lie about a measurement and the fastest possible way to destroy
the credibility this surface exists to build.

### The metric contract — every published number is one of these four

Each carries a **declared population**, a required `population` field on the metrics row. All four
are `'indexed_profiles'`: they are computed over `builder_embeddings`, never over
`builder_identities` (§Cross-plan touchpoints explains why that distinction now matters).

1. **Composition share** — `topic_profiles / indexed_profiles` in the same period, over
   `builder_embeddings`. Index growth cancels in the ratio. Label: "of BuilderHunt's indexed
   profiles". Population: `indexed_profiles`.
2. **Like-for-like share delta** — the change in (1) between two periods, computed **only over
   discovery-matrix cells covered in both** and only when the matrix version hash is unchanged.
   Otherwise the delta is `null` with `reason: 'coverage_changed'`. This is the honest replacement
   for "+18% this quarter": a *share* moved, inside a *fixed frame*. Population: `indexed_profiles`.
3. **Cohort activity rate** — of **`builder_embeddings` rows** first indexed in period *P*, the
   fraction whose `content_hash` changed during *P+1*. A rate over a closed cohort, immune to index
   growth. Note the cohort is keyed on *first indexed*, not *first tracked*: it makes no claim about
   tenant interest, so it needs no identity-provenance filter. Population: `indexed_profiles`.
4. **Topic co-occurrence** — which topics appear alongside topic X in the same profile document.
   Purely relational, makes no growth claim: cheapest to defend, most interesting to read.
   Population: `indexed_profiles`.

Guards, pure and unit-tested in `src/shared/lib/market-reports/metrics.ts`: `MIN_COHORT = 200` per
topic per period (below it the topic is `insufficient_data`, never published with a number);
`MIN_PERIODS = 2` for any delta; deltas expressed in **percentage points** (`+0.4 pp`), never as a
relative percentage, so nobody can quote "+18%"; `assertNoForbiddenClaim(text)` rejecting
`developers grew`, `market size|growth|demand`, `there are N`, and bare relative-percent tokens —
run over both AI and template narrative before persist, and again at publish time; and
`assertPopulationDeclared(metrics)`, which throws when a metrics row omits `population` or names one
absent from `POPULATIONS`, so no number can be published whose population is ambiguous.

### Cross-plan touchpoints (conventions rule 6)

- **`builder_identities` — shared surface, second writer.**
  [`collaboration-graph`](../collaboration-graph/spec.md) becomes a second writer of this table:
  its crawler inserts co-contributors no tenant ever tracked, and `first_seen_at` is
  `.defaultNow().notNull()`, so every such insert stamps it. It owns the additive nullable
  `builder_identities.discovered_by` (`NULL` for every existing row and every
  `trackOrganizationBuilder` write, `'collaboration_crawl'` for its own), registered in
  `docs/architecture/data-classification.md`. **Tenant-tracked identities are those with
  `discovered_by IS NULL`** — the phrase "written only by `trackOrganizationBuilder`" is no longer
  true and must not be repeated. Ordering: `collaboration-graph` precedes this plan in
  [`plans/fase-2/README.md`](../README.md)'s build order, so the column is treated as present; any
  predicate this plan ever adds on `discovered_by` is a **hard error** if that plan has not shipped
  (see the guard note in tasks.md's repository task).
- **`builder_embeddings` — the population this plan actually measures.** Its writers today are the
  search write-through (`src/lib/semantic/index-writer.ts`) and the discovery worker
  (`src/lib/discovery/worker.ts`); `collaboration-graph` does **not** write it. That writer set is
  pinned as `INDEX_WRITERS` in `metrics.ts` and cross-checked against `coverage.indexWriters` by a
  test, so a future plan adding a third writer to the index breaks the build instead of silently
  changing what "indexed profiles" means.
- Shared surfaces this plan does **not** touch: `builders.metadata`, `organization_builders`,
  `PLAN_LIMITS`, the search pipeline. It adds `MARKET_INSIGHTS_ACCESS` to
  `billing-shared.ts`, one AI task id to `tasks.ts`, and `market_digest` to `user_consents.document`.

### Mandatory methodology disclosure

Every public report renders `<ReportMethodology>` **from the row's `coverage` JSON**, not from
prose, so it cannot drift from the data. In order: period boundaries; that the population is
BuilderHunt's own index, a convenience sample assembled by a crawler and by user searches, not a
census; the exact metric definitions; the period's crawl coverage (cells covered, matrix version,
daily cap, indexed total, newly indexed, discovery-vs-search attribution); the suppression
threshold; and the sentence **"These figures describe BuilderHunt's index. They are not a
measurement of the global developer population."** The same sentence appears in the OG image, the
digest email, and the `Dataset` JSON-LD (`measurementTechnique`, `variableMeasured`). Not collapsible.

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

// Named lists store references + rank only, so eligibility can be re-checked live (§1.3).
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
export const reportMetricsSchema = z.object({
  indexedTotal: z.number().int().nonnegative(),
  topicCount: z.number().int().nonnegative(),
  sharePct: z.number().min(0).max(100),
  shareDeltaPp: z.number().nullable(),            // null => not computable
  shareDeltaReason: z.enum(['ok', 'coverage_changed', 'no_prior_period', 'insufficient_cohort']),
  cohortActivityRate: z.number().min(0).max(1).nullable(),
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
})
```

**Immutability: versioned, not mutable.** A published row is never updated except
`status → superseded|withdrawn` and `digestSentAt`. A correction inserts `version + 1` with a
required `correctionNote`; the old version stays fetchable at `/reports/$slug?v=N` behind a
"superseded" banner; canonical always points at the newest published version. Reason: these pages
will be cited, and silently editing a number a third party quoted is precisely the failure mode
this design exists to avoid.

### Generation worker

`POST /api/admin/market-reports/run-worker`, cloning
`src/routes/api/admin/alerts/run-worker.ts` exactly (`tryCronPrincipal(request) ?? await
requirePlatformAdminPrincipal(request)`, `auditPlatformAdminAction`). Monthly cron (1st, 03:00
UTC). **Generates drafts only — it never publishes.** Topic set = `DISCOVERY_TOPIC_SLUGS`, a new
export derived from `DISCOVERY_MATRIX` in `src/lib/discovery/matrix.ts`, so reported topics and the
crawl frame are the same list by construction. One transaction per report (`workerDb`), so a
failing topic cannot roll back another. Idempotent via `ON CONFLICT (slug, version) DO NOTHING`;
`?force=true` regenerates **drafts only** and refuses published rows. Returns
`{ periodStart, periodEnd, generated, skippedExisting, insufficientData, failed }`.

### Publishing

Reuses the changelog/roadmap pattern (`repositories/platform-content.ts` +
`routes/api/admin/changelog/index.ts`) with a new admin page
`src/routes/_dashboard/admin/market-reports.tsx`. A human platform admin reads the draft's numbers,
coverage and narrative, then publishes; `POST /api/admin/market-reports/$id/publish` is the only
writer of `status='published'` and re-runs `assertNoForbiddenClaim`, audited via
`auditPlatformAdminAction`. Withdrawal is one click and immediately removes the page and its
sitemap entry.

## 4. Public surface

**DB-backed, not file-based like the blog.** The blog is 3 hand-written essays in `content/posts/`
loaded by `src/shared/lib/blog.ts`; reports are ~30 machine-generated pages per month needing
period/topic querying, versioning, and — for named lists — a *live* eligibility filter a static
file physically cannot do. The blog stays file-based.

- `src/routes/_landing/reports/index.tsx` (published reports by period/topic) and
  `.../reports/$slug.tsx` (headline share, pp delta or an explicit "not comparable" note, cohort
  activity, co-occurrence, narrative, `<ReportMethodology>`, prior-version link, `/explore` CTA).
- Loaders via `createServerFn` in `src/shared/lib/reports-data.ts`, mirroring `blog-data.ts`, so
  pages are server-rendered. Do **not** copy `_landing/changelog/$slug.tsx`, which client-fetches
  `/api/changelog` in a `useEffect` and is therefore invisible to crawlers.
- **Canonical URLs need no new code.** `src/routes/__root.tsx:62` already emits
  `{ rel: 'canonical', href: canonicalUrl }` on every route, built at lines 14–16 from the leaf
  match's `pathname` — search params are already excluded, so `/reports/$slug?v=1` canonicalises to
  `/reports/$slug` exactly as required. Report routes therefore **must not** add their own
  `links: [{ rel: 'canonical' }]`: a second tag on the same page is what search engines treat as
  conflicting. The only report-specific requirement is `noindex` on withdrawn and superseded
  versions (a `meta` entry, not a link).
- **Sitemap**: `src/routes/sitemap[.]xml.ts` gains `/reports` plus published slugs from one indexed
  query, wrapped so a DB failure degrades to today's static list instead of a 500.
- **OG image**: `src/routes/api/og/report.tsx`, cloned from `api/og/explore.tsx` (1200×630 SVG →
  `@resvg/resvg-js` PNG, same fallback-to-SVG), with the "of BuilderHunt's index" qualifier baked
  into the image so a shared card cannot lose the caveat.
- **Structured data**: `Dataset` (`temporalCoverage`, `measurementTechnique`, `variableMeasured`,
  `creator`) — deliberately not `Article`, because this is data — plus `BreadcrumbList`; named lists
  add `ItemList` built from the live-filtered entries only.

## 5. AI — narrative only, numerically muzzled

Numbers come from SQL. The optional AI layer writes connective prose and nothing else.

- Task `market-report-narrative` in `src/shared/lib/ai/tasks.ts`, tier **`server-only`** (persisted
  + shared + background, per [`ai-policy`](../../_meta/ai-policy.md)'s decision rule).
- **Input carries no figures**: `{ topicLabel, direction: 'rose'|'flat'|'fell'|'unknown',
  comparable: boolean, coOccurringTopicLabels: string[] }`. The model cannot restate a number it
  was never given.
- **Output has no numeric fields and forbids digits**: `z.object({ headline: z.string().min(10).max(90),
  paragraphs: z.array(z.string().max(400)).min(2).max(3), caveat: z.string().max(200) })` refined to
  reject `/\d/` anywhere, plus `assertNoForbiddenClaim`. Failure → one retry (`minimaxChat` already
  retries) → **template fallback** with `narrativeSource: 'template'`.
- The page interpolates `metrics` into fixed sentences around the prose — templated numbers only.
- `cacheTtlSeconds: 2592000`, `maxOutputTokens: 700`, `allowances: { free: 0, pro: 0, team: 0 }` —
  zero on every tier means no end user can invoke it via `/api/ai/complete` (`decideBudget` returns
  `reason: 'plan'` at limit 0). The worker calls `minimaxChat` directly with the registry
  definition, as `src/lib/semantic/semantic-search.ts` does, capped at `NARRATIVE_MAX_PER_RUN = 12`
  per run in lieu of a per-user budget.
- Every narrative, AI or template, is read by a human before publish. Publishing *is* the review.

**Cost model**: ≤ 12 calls/month at ~500 in + ~500 out tokens ⇒ ~12k tokens/month. Negligible,
absorbed by the platform, not a tenant. Zero AI calls in any read path.

## 6. Monthly digest email — a consent surface

A marketing digest to a list is not transactional. Resend exists (`src/shared/lib/email.ts`;
`sendAlertDigestEmail` is the shape to copy) and no new mailing-list system is built.

- **Opt-in only, authenticated users only.** Reuses `user_consents` (`schema.ts:491` — free-text
  `document`/`version`, no check constraint): `document: 'market_digest'`, `version: 'v1'`.
  `/api/consent` gains `market_digest` in its enum but **not** in `CURRENT_VERSIONS` (never a
  blocking consent).
- **Withdrawal must work**, so `user_consents` gains a nullable `revoked_at` (expand-only).
  Subscribed = a `market_digest` row with `revoked_at IS NULL`. That is the entire subscriber list.
- **One-click unsubscribe**: `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click` headers and a
  signed link (HMAC over `userId` with `BETTER_AUTH_SECRET`) to `/api/reports/digest/unsubscribe` —
  no login required, honoured immediately.
- Sending is separate from publishing: `POST /api/admin/market-reports/send-digest`, admin/cron
  auth, per-recipient try/catch, idempotent via `digest_sent_at` (refuses a resend without
  `?force=true`). Carries the methodology sentence verbatim; never includes a named list.

## 7. Insights tier

| Surface                                                                                                                     | Access                   |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `/reports` + `/reports/$slug` HTML, latest period, ~10 curated topics, methodology, coverage envelope, co-occurrence         | Public, anonymous        |
| `GET /api/reports/$slug/data` (JSON) and `GET /api/reports/series?topic=` (full history, all `DISCOVERY_TOPIC_SLUGS`, JSON/CSV) | **Insights entitlement** |
| Cohort activity tables and per-topic breakdowns beyond the curated set                                                       | **Insights entitlement** |

Gate: `MARKET_INSIGHTS_ACCESS: Record<PlanTier, boolean> = { free: false, pro: false, team: true }`
in `src/shared/lib/billing-shared.ts` (beside `SOURCING_SPRINT_LIMITS`), evaluated against the
organization entitlement through `resolveLegacyPlanTier` so `pro_max` maps to `team` and is
allowed. Denials return `403 { error: 'plan', upgradeUrl: '/pricing' }`. A
`PLAN_PRICING.team.features` bullet is added.

**With `STRIPE_BILLING_ENABLED=false` (today, everywhere)** nobody self-serve upgrades, so the
entitlement is granted the same way every other paid capability is granted right now — admin action
on `organization_entitlements`. The gate is real and enforced from day one; only the purchase path
is missing, and that belongs to `stripe-billing-platform`.

## 8. Success metrics

- **SEO**: ≥ 60% of published report URLs indexed in Search Console within 60 days; organic
  impressions to `/reports/*` ≥ 30% of `/blog/*` within 90 days.
- **Funnel**: sign-up rate of `/reports/*` entry sessions, reported separately from `/explore` and
  `/blog` so the surface is judged on its own.
- **Integrity (the metric that matters most)**: zero published reports containing a forbidden claim
  (audited by `assertNoForbiddenClaim` over every published row in CI); ≤ 1 correction per 12
  published reports; 100% of published reports render a non-empty coverage envelope.
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
- **Subject objects to a named-list appearance**: un-publish, revoke opt-in, revoke claim, or a
  `builder_processing_restrictions` row each remove them at the next render, with no admin action.
- **Withdrawn report**: explicit "withdrawn" page carrying `robots: noindex, follow` and dropped
  from the sitemap — not a soft 404 that keeps ranking. (The canonical tag stays; it is emitted for
  every route by `__root.tsx` and `noindex` is the control that matters here.)
- **Missing grants against the real runtime role**: exactly what silently broke semantic search and
  the discovery worker (`drizzle/0025_public_tables_app_grants.sql`) — and it bites this plan
  directly: `0025:19` grants `builder_embeddings` to `builderhunt_app` **only**, while the
  generation worker aggregates that table as `builderhunt_worker`, so the grants migration must add
  `GRANT SELECT ON TABLE builder_embeddings TO builderhunt_worker`. Mandatory task: extend
  `scripts/db/verify-api-isolation-local.mjs` to cover **every** table the worker touches (including
  pre-existing ones) plus the public routes as `builderhunt_app` — a guard limited to the new tables
  would have missed `0025`'s bug too.
- **`MINIMAX_API_KEY` unset / `AI_DISABLED=true`**: template narrative; everything else identical.
- **Crawler burst**: one indexed row read per page plus
  `Cache-Control: public, s-maxage=3600`, the same header the sitemap and OG routes already use.
