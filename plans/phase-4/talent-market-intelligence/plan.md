# Talent Market Intelligence Reports (plan)

> **Status**: `pending`
> **Depends on**: [`proactive-discovery`](../../implemented/23-proactive-discovery/spec.md) (the global index breadth every aggregate is computed from — already shipped); [`public-landing-pages`](../../implemented/45-public-landing-pages/spec.md) (public page shell, SEO, and OG image plumbing — already shipped); [`content-marketing`](../../implemented/46-content-marketing/spec.md) (the blog/content surface these reports extend — already shipped); [`claimable-profiles`](../../implemented/36-claimable-profiles/spec.md) (`published_builder_profiles`, the consent basis for Phase 8 — already shipped). Enhanced by [`smart-alerts`](../../implemented/34-smart-alerts/spec.md) (digest email delivery; not required).
> **Blocks**: nothing
> **Reality check**: Builds on `src/lib/discovery/matrix.ts` (topic frame + coverage witness), `builder_embeddings` (the only usable time dimension), `src/routes/api/admin/alerts/run-worker.ts` (worker pattern, now including `withJobRun`), `src/shared/lib/operational-schedules.ts` (cron registry), `src/shared/lib/seo/surfaces.ts` + `public_surface_indexing` (admin-governed, fail-closed indexing), `src/shared/lib/repositories/platform-content.ts` (admin-published public content), `src/routes/api/og/explore.tsx` + `src/routes/sitemap[.]xml.ts` (SEO plumbing), `src/shared/lib/email.ts` (Resend). Two new global-public tables; one additive column each on `user_consents` and `published_builder_profiles`.

## Phases (dependency order — shippable after each)

### Phase 1 — Metric contract as pure, tested code (no DB, no UI)

The whole plan rests on metrics that survive an adversarial read, so they are built and tested
first. `src/shared/lib/market-reports/metrics.ts`: composition share, like-for-like share delta
in percentage points with `shareDeltaReason`, co-occurrence ranking, cohort **re-observation**
rate (a coverage witness, never a published metric — spec.md §2.1), `MIN_COHORT`/`MIN_PERIODS`
suppression, `matrixVersionHash()`, `assertNoForbiddenClaim(text)`, `assertPopulationDeclared()`,
and the `INDEX_WRITE_CHOKEPOINT` / `INDEX_ROW_CREATORS` pins with the build-failing guard test that
detects a sixth ingestion path. `schema.ts` holds the zod `ReportMetrics`/`ReportCoverage`.
`topics.ts` exports the deterministic `matchesTopic(profile, topic)` keyword matcher. Ships as
dead code with a full test suite — including tests that assert a raw index-growth ratio is *not*
expressible through the public API of this module.

### Phase 2 — Snapshot tables, grants, data classification

`market_report_snapshots` + `market_report_list_entries` in `schema.ts`; `pnpm db:generate`; then a
second, grants-only migration minted with `pnpm exec drizzle-kit generate --custom` (a hand-created
`.sql` is never journaled, so `drizzle-kit migrate` skips it and
`scripts/db/verify-migration-integrity.mjs` fails on the file-set comparison at lines 12–15).
Never hardcode the index — read the next one from `drizzle/meta/_journal.json` at the moment you
run it. Global public, no RLS on the two new tables, same shape as
`drizzle/0025_public_tables_app_grants.sql` — `SELECT` to `builderhunt_app`,
`SELECT/INSERT/UPDATE` to `builderhunt_worker`, `SELECT/UPDATE` to `builderhunt_platform`, no
`DELETE` anywhere — **plus two grants on pre-existing tables the worker cannot otherwise read**:
`GRANT SELECT ON TABLE builder_embeddings TO builderhunt_worker` (`0025:19` granted the app role
only) and, for Phase 8, `GRANT SELECT ON TABLE published_builder_profiles TO builderhunt_worker`
together with a `FOR SELECT TO builderhunt_worker USING (true)` policy, because that table has
`FORCE ROW LEVEL SECURITY` and app-only policies (`0011:3-4,17-28`) so a grant alone yields zero
rows. Additive `published_builder_profiles.include_in_public_rankings` and
`user_consents.revoked_at`. `docs/architecture/data-classification.md` updated. No behaviour change.

### Phase 3 — Aggregate computation + generation worker (drafts only)

`src/shared/lib/repositories/market-reports.ts` (all SQL, DTO allowlists; aggregation **and** draft
writes on `workerDb` from `~/shared/lib/db/worker-db` in one transaction, `publicDb` for public
reads — deliberately not the app-role path `src/lib/discovery/worker.ts` uses, since that would mean
granting the web-serving role write access to published report rows) and
`src/lib/market-reports/worker.ts` composing repository SQL with Phase 1's pure math.
`POST /api/admin/market-reports/run-worker` cloned from the alerts worker including its
`withJobRun` wrapper, plus two `OPERATIONAL_SCHEDULES` entries, per-report transaction, idempotent,
`?force` limited to drafts. Nothing is public yet: the worker produces drafts only, which makes this
phase safe to run in production before any page exists.

### Phase 4 — Admin review, publish, correct, withdraw

Platform-admin list/detail/publish/withdraw endpoints and
`src/routes/_dashboard/admin/market-reports.tsx`, following the changelog admin CRUD precedent.
Publish is the human review gate and the only writer of `status='published'`. Corrections create
`version+1` and mark the prior version `superseded`. Every mutation audited.

### Phase 5 — Public pages + SEO

`src/routes/_landing/reports/{index,$slug}.tsx` with `createServerFn` loaders in
`src/shared/lib/reports-data.ts` (SSR — not the changelog's client-fetch pattern),
`<ReportMethodology>` rendered from `coverage`, `Dataset`/`BreadcrumbList` JSON-LD,
`src/routes/api/og/report.tsx`, sitemap entries with a scoped fail-soft read, footer link. No
canonical tag is added — `src/routes/__root.tsx:62` already emits a query-free one for every route;
the phase verifies that rather than duplicating it.
**This phase also registers `reports` as a fourth `SEO_SURFACES` entry** so its indexing is
admin-controlled and fails closed like every other public surface. That means the pages ship
`noindex` and a platform admin must flip them in `/admin/content` — an explicit launch step, and
the point from which spec.md §8's SEO metrics are measured.
This is the phase that produces the SEO surface.

### Phase 6 — Insights-tier gated data API

`MARKET_INSIGHTS_ACCESS` in `billing-shared.ts`, keyed by `OrganizationTier` and indexed directly
with `entitlement.tier` (the fixed pattern, not the `PlanTier` + `resolveLegacyPlanTier` one that
produced the documented `SOURCING_SPRINT_LIMITS` bug), `GET /api/reports/$slug/data` and
`GET /api/reports/series`, rate-limited, CSV + JSON. `PLAN_PRICING.team.features` bullet. Free HTML
surface unchanged.

### Phase 7 — Monthly digest email (consent + unsubscribe)

`market_digest` consent document, revoke path, signed one-click unsubscribe endpoint,
`sendMarketDigestEmail` in `email.ts` (copying `sendAlertDigestEmail`), and
`POST /api/admin/market-reports/send-digest` with `digest_sent_at` idempotency.

### Phase 8 — Named-list content type (capability only, ships disabled)

Subject opt-in toggle in the claimed-profile editor, eligibility query (published + opted-in + not
restricted — **never joining `builder_claims`**, whose RLS makes it unreadable both anonymously and
by the worker; see spec.md §1.2), `market_report_list_entries` generation, and the render-time live
eligibility filter. Feature-flagged off by `MARKET_REPORT_NAMED_LISTS_ENABLED=false` and blocked
by a `>= 25 eligible candidates` publish guard, so no named list can be published at launch.
Shipping it as code with the guard is deliberate: it makes the policy testable rather than
aspirational.

## Risks

| Risk                                                                                          | Likelihood | Impact   | Mitigation                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A published report is read as a claim about the real developer market                          | High       | Critical | Non-relative pp deltas, mandatory non-collapsible methodology block rendered from `coverage`, an explicit "this is NOT" line written into every metric definition, the literal disclaimer sentence in page + OG image + email + JSON-LD, `assertNoForbiddenClaim` in CI |
| **A coverage signal is published as a market signal through a column nobody re-read**          | **Certain (already happened once)** | **Critical** | Found at HEAD: `builder_embeddings.updated_at` bumps on *every* re-upsert regardless of content hash (`public-builder-embeddings.ts:43`) and on the embedding backfill (line 72), so the previously-specified "cohort activity rate" measured re-crawl frequency. Redesigned in spec.md §2.1 — renamed `cohortReobservationRate`, moved out of `ReportMetrics` into `ReportCoverage`, rendered only inside the methodology block under a coverage heading. Rule generalised: any new metric must name the exact writer set of every column it reads before it may be published |
| Crawl-coverage change silently corrupts a delta                                                | Medium     | High     | `matrixVersion` hash stored per period; any mismatch, or a shrunken `cellsCoveredInPeriod`, forces `shareDeltaPp: null` with `reason: 'coverage_changed'` — no delta is ever computed across an incomparable frame |
| **A new ingestion path silently changes what "indexed profiles" means**                        | **High (one appeared since 2026-07-25)** | High | `src/lib/sprints/semantic-write-through.ts` joined the row-creating set after this plan was drafted, taking it from the assumed 2 to 5. Guard redesigned around the stable chokepoint: `INDEX_WRITE_CHOKEPOINT` (the single repository emitting write SQL) plus `INDEX_ROW_CREATORS` (the five modules calling `upsertEmbeddingStubs`), both pinned in `metrics.ts`, published in `coverage.indexRowCreators`, and asserted by a test that fails the build so the sixth path must update the methodology in the same commit |
| Small-cohort topic produces noise or a de-anonymisable aggregate                               | High       | Medium   | `MIN_COHORT = 200` suppression, surfaced as "insufficient data" rather than published                                                                                     |
| Named list published about someone who never consented                                         | Low        | Critical | Phase 8 ships disabled; opt-in default false; ≥25-candidate publish guard; identity-reference-only storage with live render-time eligibility filter; restriction function check |
| **A privacy filter silently matches nobody because of RLS**                                    | Medium     | Critical | The originally-specified eligibility join on `builder_claims` would have returned zero rows for anonymous renders (`FORCE RLS`, app-only policies scoped to `app.user_id`) — indistinguishable from "correctly filtered everyone out". Redesigned to key on `published_builder_profiles`, whose app SELECT policy is `USING (true)`; the Phase 8 test asserts a *positive* case (30 candidates render 30 entries) as well as the negative ones, so a silently-empty filter fails |
| Missing grants break the worker silently against the real non-owner role                       | Certain (already true for `builder_embeddings` and `published_builder_profiles`) | High | Grants migration adds `SELECT` on `builder_embeddings` for `builderhunt_worker` (`0025:19` granted `builderhunt_app` only) and both a `SELECT` grant and a worker `SELECT` policy on `published_builder_profiles` (`0011` gave the app role only, under `FORCE RLS`), plus a `verify-api-isolation-local.mjs` extension covering **every** table the worker touches, pre-existing ones included |
| A boolean feature flag fails in the unsafe direction                                           | Medium     | Critical | `z.enum(['true','false']).default('false')` for the new flag, never `z.coerce.boolean()` (coercion is `Boolean(input)`, so `'false'` → `true` and an operator disabling named lists would enable them); matches every existing flag in `src/shared/lib/env.ts` |
| AI narrative invents or restates a number                                                      | Medium     | High     | No figures in the task input at all; output schema rejects any digit; `assertNoForbiddenClaim`; template fallback; human publish review                                    |
| Marketing digest sent without valid consent / no working unsubscribe                           | Low        | High     | Opt-in `user_consents` row required, `revoked_at` honoured, signed one-click unsubscribe + `List-Unsubscribe-Post`, send is a separate admin action from publish           |
| **`/reports` ships invisible to search engines and nobody notices**                            | High       | Medium   | `SEO_SURFACES` now fails closed to `noindex` and seeds new surfaces hidden (`surfaces.ts:60`, `drizzle/0083:31-33`). Accepted deliberately rather than special-cased: the flip is a named launch task in Phase 5 and spec.md §8 measures SEO from the flip date, not the deploy date |
| Aggregation query on a large index makes the worker slow or locks reads                        | Medium     | Low      | Monthly cadence, one transaction per topic, read-only aggregation over an indexed timestamp column, worker role only                                                       |
| Free reports cannibalize the insights tier                                                     | Medium     | Medium   | Deliberate split (latest period + ~10 topics free; full series, all topics, machine-readable paid) and a named success metric that treats zero conversions as a pricing signal, not a reason to paywall more |
| `STRIPE_BILLING_ENABLED=false` means nobody can buy the insights tier                          | Certain    | Low      | Gate is enforced from day one; entitlement granted by admin on `organization_entitlements`, same as every other paid capability today                                      |

## Rollback

- **Phases 1–3** are invisible: remove the two `OPERATIONAL_SCHEDULES` entries and re-run
  `POST /api/admin/operations/sync-schedules`, and the tables hold drafts nobody can reach.
  Dropping both new tables is a single additive revert; no existing table's data is touched.
- **Phase 4–5**: withdraw every report (`status='withdrawn'`) — pages go `noindex` and their sitemap
  entries disappear — or, faster and total, flip the `reports` surface to hidden in `/admin/content`,
  which noindexes the whole surface in one action without touching a row. Then remove the routes if
  desired. `/blog`, `/explore`, and the existing sitemap entries are untouched throughout.
- **Phase 6**: flip `MARKET_INSIGHTS_ACCESS` to all-false; the gated endpoints 403 for everyone
  and the public HTML surface is unaffected.
- **Phase 7**: stop calling the send endpoint; the consent rows and unsubscribe endpoint are
  harmless at rest. No subscriber state to unwind beyond that.
- **Phase 8**: `MARKET_REPORT_NAMED_LISTS_ENABLED=false` (its default) hides the opt-in toggle,
  stops generation, and makes any existing list unrenderable. The additive
  `include_in_public_rankings` column and `user_consents.revoked_at` stay — both are inert when
  unread, and dropping them is a later contract step, never part of a rollback.
- **AI**: `AI_DISABLED_TASKS=market-report-narrative` degrades every future report to the
  template narrative with no other effect.
