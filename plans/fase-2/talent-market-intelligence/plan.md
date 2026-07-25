# Talent Market Intelligence Reports (plan)

> **Status**: `pending`
> **Depends on**: [`proactive-discovery`](../../proactive-discovery/spec.md) (the global index breadth every aggregate is computed from — already shipped); [`public-landing-pages`](../../public-landing-pages/spec.md) (public page shell, SEO, and OG image plumbing — already shipped); [`content-marketing`](../../content-marketing/spec.md) (the blog/content surface these reports extend). Enhanced by [`smart-alerts`](../../smart-alerts/spec.md) (digest email delivery; not required).
> **Blocks**: nothing
> **Reality check**: Builds on `src/lib/discovery/matrix.ts` (topic frame + coverage witness), `builder_embeddings` (the only usable time dimension), `src/routes/api/admin/alerts/run-worker.ts` (worker pattern), `src/shared/lib/repositories/platform-content.ts` (admin-published public content), `src/routes/api/og/explore.tsx` + `src/routes/sitemap[.]xml.ts` (SEO plumbing), `src/shared/lib/email.ts` (Resend). Two new global-public tables; one additive column each on `user_consents` and `published_builder_profiles`.

## Phases (dependency order — shippable after each)

### Phase 1 — Metric contract as pure, tested code (no DB, no UI)

The whole plan rests on metrics that survive an adversarial read, so they are built and tested
first. `src/shared/lib/market-reports/metrics.ts`: composition share, like-for-like share delta
in percentage points with `shareDeltaReason`, cohort activity rate, co-occurrence ranking,
`MIN_COHORT`/`MIN_PERIODS` suppression, `matrixVersionHash()`, and
`assertNoForbiddenClaim(text)`. `schema.ts` holds the zod `ReportMetrics`/`ReportCoverage`.
`topics.ts` exports the deterministic `matchesTopic(profile, topic)` keyword matcher. Ships as
dead code with a full test suite — including tests that assert a raw index-growth ratio is *not*
expressible through the public API of this module.

### Phase 2 — Snapshot tables, grants, data classification

`market_report_snapshots` + `market_report_list_entries` in `schema.ts`; `pnpm db:generate`; a
a second grants migration minted with `drizzle-kit generate --custom` (a hand-created `.sql` is
never journaled, so `drizzle-kit migrate` skips it and `scripts/db/verify-migration-integrity.mjs`
fails): global public, no RLS, same shape as `drizzle/0025_public_tables_app_grants.sql` — `SELECT`
to `builderhunt_app`, `SELECT/INSERT/UPDATE` to `builderhunt_worker`, `SELECT/UPDATE` to
`builderhunt_platform`, no `DELETE` anywhere — **plus `GRANT SELECT ON TABLE builder_embeddings TO
builderhunt_worker`**, which `0025:19` never granted and without which the Phase 3 worker cannot
read the index it aggregates. Additive `published_builder_profiles.include_in_public_rankings` and
`user_consents.revoked_at`. `docs/architecture/data-classification.md` updated. No behaviour change.

### Phase 3 — Aggregate computation + generation worker (drafts only)

`src/shared/lib/repositories/market-reports.ts` (all SQL, DTO allowlists; aggregation **and** draft
writes on `workerDb` in one transaction, `publicDb` for public reads — deliberately not the app-role
path `src/lib/discovery/worker.ts` uses, since that would mean granting the web-serving role write
access to published report rows) and `src/lib/market-reports/worker.ts` composing repository SQL
with Phase 1's pure math.
`POST /api/admin/market-reports/run-worker` cloned from the alerts worker, monthly cron,
per-report transaction, idempotent, `?force` limited to drafts. Nothing is public yet: the
worker produces drafts only, which makes this phase safe to run in production before any page
exists.

### Phase 4 — Admin review, publish, correct, withdraw

Platform-admin list/detail/publish/withdraw endpoints and
`src/routes/_dashboard/admin/market-reports.tsx`, following the changelog admin CRUD precedent.
Publish is the human review gate and the only writer of `status='published'`. Corrections create
`version+1` and mark the prior version `superseded`. Every mutation audited.

### Phase 5 — Public pages + SEO

`src/routes/_landing/reports/{index,$slug}.tsx` with `createServerFn` loaders in
`src/shared/lib/reports-data.ts` (SSR — not the changelog's client-fetch pattern),
`<ReportMethodology>` rendered from `coverage`, `Dataset`/`BreadcrumbList` JSON-LD,
`src/routes/api/og/report.tsx`, sitemap entries with a fail-soft DB read, footer link. No canonical
tag is added — `src/routes/__root.tsx:62` already emits a query-free one for every route; the phase
verifies that rather than duplicating it.
This is the phase that produces the SEO surface.

### Phase 6 — Insights-tier gated data API

`MARKET_INSIGHTS_ACCESS` in `billing-shared.ts`, `GET /api/reports/$slug/data` and
`GET /api/reports/series`, entitlement-gated via `resolveLegacyPlanTier`, rate-limited, CSV +
JSON. `PLAN_PRICING.team.features` bullet. Free HTML surface unchanged.

### Phase 7 — Monthly digest email (consent + unsubscribe)

`market_digest` consent document, revoke path, signed one-click unsubscribe endpoint,
`sendMarketDigestEmail` in `email.ts` (copying `sendAlertDigestEmail`), and
`POST /api/admin/market-reports/send-digest` with `digest_sent_at` idempotency.

### Phase 8 — Named-list content type (capability only, ships disabled)

Subject opt-in toggle in the claimed-profile editor, eligibility query (published + claimed +
opted-in + not restricted), `market_report_list_entries` generation, and the render-time live
eligibility filter. Feature-flagged off by `MARKET_REPORT_NAMED_LISTS_ENABLED=false` and blocked
by a `>= 25 eligible candidates` publish guard, so no named list can be published at launch.
Shipping it as code with the guard is deliberate: it makes the policy testable rather than
aspirational.

## Risks

| Risk                                                                                          | Likelihood | Impact   | Mitigation                                                                                                                                                              |
| --------------------------------------------------------------------------------------------- | ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A published report is read as a claim about the real developer market                          | High       | Critical | Non-relative pp deltas, mandatory non-collapsible methodology block rendered from `coverage`, the literal disclaimer sentence in page + OG image + email + JSON-LD, `assertNoForbiddenClaim` in CI |
| Crawl-coverage change silently corrupts a delta                                                | Medium     | High     | `matrixVersion` hash stored per period; any mismatch forces `shareDeltaPp: null` with `reason: 'coverage_changed'` — no delta is ever computed across an incomparable frame |
| Small-cohort topic produces noise or a de-anonymisable aggregate                               | High       | Medium   | `MIN_COHORT = 200` suppression, surfaced as "insufficient data" rather than published                                                                                     |
| Named list published about someone who never consented                                         | Low        | Critical | Phase 8 ships disabled; opt-in default false; ≥25-candidate publish guard; identity-reference-only storage with live render-time eligibility filter; restriction function check |
| Missing grants break the worker silently against the real non-owner role                       | Certain (already true for `builder_embeddings`) | High | Grants migration adds the missing `SELECT` on `builder_embeddings` for `builderhunt_worker` (`0025:19` granted `builderhunt_app` only) + a `verify-api-isolation-local.mjs` extension covering **every** table the worker touches, pre-existing ones included, not just the new tables |
| A boolean feature flag fails in the unsafe direction                                           | Medium     | Critical | `z.enum(['true','false']).default('false')` for both new flags, never `z.coerce.boolean()` (coercion is `Boolean(input)`, so `'false'` → `true` and an operator disabling named lists would enable them); matches every existing flag in `src/shared/lib/env.ts` |
| AI narrative invents or restates a number                                                      | Medium     | High     | No figures in the task input at all; output schema rejects any digit; `assertNoForbiddenClaim`; template fallback; human publish review                                    |
| Marketing digest sent without valid consent / no working unsubscribe                           | Low        | High     | Opt-in `user_consents` row required, `revoked_at` honoured, signed one-click unsubscribe + `List-Unsubscribe-Post`, send is a separate admin action from publish           |
| Aggregation query on a large index makes the worker slow or locks reads                        | Medium     | Low      | Monthly cadence, one transaction per topic, read-only aggregation over an indexed timestamp column, worker role only                                                       |
| Free reports cannibalize the insights tier                                                     | Medium     | Medium   | Deliberate split (latest period + ~10 topics free; full series, all topics, machine-readable paid) and a named success metric that treats zero conversions as a pricing signal, not a reason to paywall more |
| `STRIPE_BILLING_ENABLED=false` means nobody can buy the insights tier                          | Certain    | Low      | Gate is enforced from day one; entitlement granted by admin on `organization_entitlements`, same as every other paid capability today                                      |

## Rollback

- **Phases 1–3** are invisible: stop the monthly cron and the tables hold drafts nobody can
  reach. Dropping both new tables is a single additive revert; no existing table's data is touched.
- **Phase 4–5**: withdraw every report (`status='withdrawn'`) — pages go `noindex` and their sitemap
  entries disappear — then remove the routes if desired. `/blog`, `/explore`, and the existing
  sitemap entries are untouched throughout.
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
