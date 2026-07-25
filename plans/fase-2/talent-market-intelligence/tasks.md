# Talent Market Intelligence Reports (tasks)

> **Status**: `pending`
> **Depends on**: [`proactive-discovery`](../../proactive-discovery/spec.md) (the global index breadth every aggregate is computed from — already shipped); [`public-landing-pages`](../../public-landing-pages/spec.md) (public page shell, SEO, and OG image plumbing — already shipped); [`content-marketing`](../../content-marketing/spec.md) (the blog/content surface these reports extend). Enhanced by [`smart-alerts`](../../smart-alerts/spec.md) (digest email delivery; not required).
> **Blocks**: nothing
> **Reality check**: Extends `src/lib/discovery/matrix.ts`, `src/shared/lib/db/schema.ts`, `src/routes/sitemap[.]xml.ts`, `src/routes/api/og/explore.tsx` (clone target), `src/routes/api/admin/alerts/run-worker.ts` (clone target), `src/shared/lib/repositories/platform-content.ts`, `src/shared/lib/email.ts`, `src/routes/api/consent/index.ts`, `src/routes/_dashboard/me/index.tsx`, `scripts/db/verify-api-isolation-local.mjs`. Two new tables; additive columns only on existing ones.

Ordered so the app ships cleanly after every checkbox.

## Phase 1 — Metric contract as pure, tested code

- [ ] **Export the topic frame from the discovery matrix**
  - Files: `src/lib/discovery/matrix.ts`, `src/lib/discovery/matrix.test.ts`
  - Do: Add `export const DISCOVERY_TOPIC_SLUGS: string[]` (the distinct `TOPICS[].slug` values,
    order-stable) and `export const DISCOVERY_TOPIC_KEYWORDS: Record<string, string[]>`. Do not
    change `DISCOVERY_MATRIX` or `cellAt` — the discovery worker's behaviour must be byte-identical.
  - Verify: `pnpm test matrix` — existing assertions still pass, new test asserts 30 unique slugs
    and that every slug's keywords are non-empty.

- [ ] **Define the report zod schemas**
  - Files: `src/shared/lib/market-reports/schema.ts` (new)
  - Do: Export `reportMetricsSchema` and `reportCoverageSchema` exactly per spec.md §3, plus
    `export type ReportMetrics` / `ReportCoverage`. Pure module — no DB, no env, no I/O, importable
    from client and server.
  - Verify: `pnpm type-check`.

- [ ] **Implement the deterministic topic matcher**
  - Files: `src/shared/lib/market-reports/topics.ts` (new)
  - Do: `matchesTopic(profile: { topics: string[]; language?: string | null }, topicSlug: string): boolean`
    — case-insensitive match of `DISCOVERY_TOPIC_KEYWORDS[topicSlug]` against `profile.topics` and
    `profile.language` only. Never against free-text `document` (a bio saying "I don't write Rust"
    would match). No LLM, no regex over prose.
  - Verify: `pnpm test market-reports/topics` — `{topics:['rust']}` matches `rust`; `{language:'Go'}`
    matches `go`; a bio-only mention does not match; unknown slug returns false.

- [ ] **Implement the metric math and the defensibility guards**
  - Files: `src/shared/lib/market-reports/metrics.ts` (new), `src/shared/lib/market-reports/metrics.test.ts` (new)
  - Do: Export `MIN_COHORT = 200`, `MIN_PERIODS = 2`; `compositionShare({ topicCount, indexedTotal })`;
    `shareDelta({ current, prior, comparableFrame })` → `{ deltaPp: number | null, reason:
    'ok'|'coverage_changed'|'no_prior_period'|'insufficient_cohort' }` (always percentage points,
    never a relative percentage); `cohortActivityRate({ cohortSize, changedInNextPeriod })`;
    `rankCoOccurrence(counts, indexedTotal, limit = 8)`; `matrixVersionHash(cellKeys)` (sha256 of the
    sorted joined keys); `assertNoForbiddenClaim(text)` throwing on
    `/developers?\s+(grew|increased|declined)/i`, `/\bmarket\s+(size|growth|demand)\b/i`,
    `/there are \d/i`, and `/[+-]?\d+(\.\d+)?\s*%\s*(growth|increase|more|fewer)/i`.
  - Verify: `pnpm test market-reports/metrics` — asserts `comparableFrame: false` ⇒
    `'coverage_changed'`, no prior ⇒ `'no_prior_period'`, cohort < `MIN_COHORT` ⇒
    `'insufficient_cohort'`, the module exports **no** function taking two raw index counts and
    returning a growth ratio, and `assertNoForbiddenClaim('Rust developers grew 18% this quarter')`
    throws while `'Rust holds 6.1% of indexed profiles'` does not.

- [ ] **Build the template narrative generator (the AI fallback, built first)**
  - Files: `src/shared/lib/market-reports/narrative-template.ts` (new), `src/shared/lib/market-reports/narrative-template.test.ts` (new)
  - Do: `buildTemplateNarrative(metrics: ReportMetrics, coverage: ReportCoverage, topicLabel: string)`
    → `{ headline, paragraphs, caveat }`, interpolating numbers from `metrics` into fixed sentences
    that always carry the "of BuilderHunt's indexed profiles" qualifier, and printing "baseline
    period — no comparison available" when `shareDeltaPp` is null. Ends by calling
    `assertNoForbiddenClaim` on its own output.
  - Verify: `pnpm test narrative-template` — null delta yields the baseline sentence; output passes
    its own claim guard.

## Phase 2 — Tables, grants, classification

- [ ] **Add the two report tables and the two additive columns**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Add `marketReportSnapshots` and `marketReportListEntries` exactly per spec.md §3, with a
    section comment stating: global public, no `organization_id`, no RLS, same class as `changelog`;
    import `ReportMetrics`/`ReportCoverage` from `~/shared/lib/market-reports/schema`. Then add
    `publishedBuilderProfiles.includeInPublicRankings: boolean('include_in_public_rankings').notNull().default(false)`
    and `userConsents.revokedAt: timestamp('revoked_at', { withTimezone: true })` (nullable) —
    expand-only, no existing column changed, no backfill (the defaults are correct for every row).
  - Verify: `pnpm type-check`.

- [ ] **Generate the schema migration**
  - Files: `drizzle/` (new migration from `pnpm db:generate`), `drizzle/meta/*`, `drizzle/migration-hashes.json`
  - Do: Run `pnpm db:generate`; review the emitted SQL for any unexpected drop/rename (there must
    be none — two `CREATE TABLE`s and two `ADD COLUMN`s only). Regenerate the hash manifest
    (`node scripts/db/verify-migration-integrity.mjs --write`) and commit `drizzle/meta/_journal.json`
    + the new `drizzle/meta/NNNN_snapshot.json` alongside the SQL.
  - Verify: `pnpm db:migrate` on a fresh DB succeeds; `pnpm exec drizzle-kit check` and
    `pnpm test:migration-integrity` pass.

- [ ] **Mint the grants migration as a journaled custom migration**
  - Files: `drizzle/NNNN_market_reports_grants.sql` (new — **must** be created with
    `pnpm exec drizzle-kit generate --custom`, matching `drizzle/0028`/`0044`'s provenance), `drizzle/meta/*`, `drizzle/migration-hashes.json`
  - Do: Do **not** hand-create the `.sql`: `scripts/db/verify-migration-integrity.mjs:12-15,27-30`
    hard-fails unless the SQL set exactly equals `_journal.json`'s tags, a matching
    `NNNN_snapshot.json` exists, and `migration-hashes.json` is regenerated — and `drizzle-kit
    migrate` never applies an un-journaled file. Mint it with `--custom`, then fill in the body,
    mirroring `drizzle/0025_public_tables_app_grants.sql`'s reasoning comment:
    `GRANT SELECT ON TABLE market_report_snapshots, market_report_list_entries TO builderhunt_app;` /
    `GRANT SELECT, INSERT, UPDATE ON … TO builderhunt_worker;` /
    `GRANT SELECT, UPDATE ON … TO builderhunt_platform;` **plus
    `GRANT SELECT ON TABLE builder_embeddings TO builderhunt_worker;`** — `drizzle/0025:19` granted
    that table to `builderhunt_app` only, so without this line the generation worker cannot read the
    index it aggregates (see the repository task below for why the worker role, not the app role,
    owns aggregation). No `DELETE` to any runtime role (published rows are immutable). No RLS —
    document why (global public, no owning subject). Then re-run the hash manifest with `--write`.
  - Verify: `pnpm db:migrate` and `pnpm test:migration-integrity` pass; as `builderhunt_app`,
    `INSERT` into `market_report_snapshots` fails with permission denied while `SELECT` succeeds; as
    `builderhunt_worker`, `SELECT count(*) FROM builder_embeddings` succeeds.

- [ ] **Record the data classification**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: Add both tables as **global public** with the publication policy (draft rows are not public;
    filtered by `status` in the public repository) and the per-role grant matrix. Add the two new
    columns under their existing tables' rows.
  - Verify: Both tables appear; no code change.

## Phase 3 — Aggregate computation + generation worker

- [ ] **Write the report repository (all SQL lives here)**
  - Files: `src/shared/lib/repositories/market-reports.ts` (new)
  - Do: Using `workerDb` for aggregation **and** report writes, `publicDb` for public reads. The
    aggregation reads `builder_embeddings`, which `drizzle/0025:19` grants to `builderhunt_app` only,
    so the grants task above adds `SELECT` for `builderhunt_worker`. Deliberately **not** the
    app-role path that `src/lib/discovery/worker.ts` uses (it imports `publicDb`, which is
    `runtimeDb` — the app role): aggregation and draft insertion happen in one transaction, so
    running it as the app role would require granting the web-serving role `INSERT`/`UPDATE` on
    published report rows — exactly the privilege split `drizzle/0044` avoids for signal tables.
    Read-only `SELECT` for the worker on an already-public index is the smaller privilege.
    Functions: `countIndexedProfiles(periodEnd)`, `countTopicProfiles(topicSlug, periodEnd)` (SQL predicate
    built from `DISCOVERY_TOPIC_KEYWORDS` against `profile->'topics'` and `profile->>'language'`,
    mirroring `matchesTopic`), `countCohortActivity(periodStart, periodEnd)` (identities with
    `created_at` in the prior period whose `updated_at` falls in this one),
    `coOccurrenceCounts(topicSlug, periodEnd)`, `insertReportDraft(row)` with
    `onConflictDoNothing` on `(slug, version)`, `findLatestPublished(slug)`,
    `listPublishedReports(limit)`, `findPriorPeriodReport(topicSlug, periodStart)`. Every public
    read returns an explicit field allowlist — never `select()` of the whole row.
  - Verify: `pnpm type-check`; a manual `tsx` script prints non-zero `countIndexedProfiles` against
    the local DB.

- [ ] **Compose the generation worker**
  - Files: `src/lib/market-reports/worker.ts` (new)
  - Do: `runMarketReportWorker({ periodEnd, force })`: derive `periodStart` (first day of the
    previous UTC month) and the coverage envelope (`matrixVersionHash(DISCOVERY_MATRIX.map(c => c.key))`,
    `env.DISCOVERY_DAILY_STUB_CAP`, newly-indexed count, discovery-attributed share, `MIN_COHORT`);
    for each `DISCOVERY_TOPIC_SLUGS` entry, in **its own transaction**, compute metrics via Phase 1's
    pure functions, mark `suppressed` under `MIN_COHORT`, build the template narrative, and insert a
    `status: 'draft'` row. A topic that throws is logged and skipped — never aborts the run. Return
    `{ periodStart, periodEnd, generated, skippedExisting, insufficientData, failed }`.
  - Verify: `pnpm test market-reports/worker` (pure parts with a stubbed repository); running it
    twice inserts nothing the second time.

- [ ] **Add the run-worker endpoint**
  - Files: `src/routes/api/admin/market-reports/run-worker.ts` (new)
  - Do: Clone `src/routes/api/admin/alerts/run-worker.ts` verbatim in structure:
    `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`, call
    `runMarketReportWorker`, `auditPlatformAdminAction({ action: 'admin.worker.run', targetType:
    'worker', targetId: 'market-reports' })`, `platformAdminErrorResponse(err)` fallback. Accept
    `?force=true` (drafts only — refuse with 409 if the target slug already has a published row)
    and `?periodEnd=YYYY-MM-DD` for backfilling one period. Doc-comment the monthly cron (1st,
    03:00 UTC) next to the existing worker crontab note.
  - Verify: `curl -X POST -H "X-Cron-Secret: $CRON_SECRET" .../api/admin/market-reports/run-worker`
    returns `generated > 0`; immediate re-run returns `skippedExisting > 0, generated: 0`;
    unauthenticated returns 401/403.

- [ ] **Prove the worker works as the real non-owner role**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Cover **every table the worker touches, not just the new ones** — the `drizzle/0025` failure
    was a missing grant on a *pre-existing* table, so a guard limited to new tables would have missed
    it too. Assert: `builderhunt_worker` can `SELECT` `builder_embeddings` (the aggregation source)
    and insert/update `market_report_snapshots`/`market_report_list_entries`; `builderhunt_app` can
    `SELECT` the report tables but not `INSERT` them; no role can `DELETE` any of the three. Add a
    standing check that enumerates every table named in `repositories/market-reports.ts` and asserts
    a grant exists for the role that connection uses, so a future added table cannot slip through.
  - Verify: `pnpm test:api-isolation:local` — all checks pass, count increased.

## Phase 4 — Admin review, publish, correct, withdraw

- [ ] **Add platform-admin report repository functions**
  - Files: `src/shared/lib/repositories/platform-content.ts`
  - Do: Add `listPlatformMarketReports()`, `findPlatformMarketReport(id)`,
    `publishPlatformMarketReport(id, userId)` (sets `status='published'`, `published_at`,
    `published_by_user_id`; only from `draft`), `withdrawPlatformMarketReport(id)`,
    `supersedePlatformMarketReport(id)` — all via `platformDb`, following the file's existing style.
    No function may `UPDATE` `metrics`, `coverage`, or `narrative` on a published row.
  - Verify: `pnpm test platform-content` — a publish call on an already-published row is a no-op;
    no exported function mutates a published row's numbers.

- [ ] **Add the admin report endpoints**
  - Files: `src/routes/api/admin/market-reports/index.ts` (new), `src/routes/api/admin/market-reports/$id/publish.ts` (new), `src/routes/api/admin/market-reports/$id/withdraw.ts` (new)
  - Do: Follow `src/routes/api/admin/changelog/index.ts` exactly (`requirePlatformAdminPrincipal`,
    zod body, `auditPlatformAdminAction`, `platformAdminErrorResponse`). Publish runs
    `assertNoForbiddenClaim(narrative)` and rejects with 422 on failure — the last gate before a
    number becomes public. Withdraw requires a `reason` string, recorded in the audit entry.
  - Verify: Authed admin publish flips `status`; a draft whose narrative contains "developers grew"
    422s; a non-admin gets 403; a second publish is idempotent.

- [ ] **Add the correction path**
  - Files: `src/routes/api/admin/market-reports/$id/correct.ts` (new), `src/lib/market-reports/worker.ts`
  - Do: `POST …/correct` with `{ correctionNote: string(min 10) }` recomputes the same period for
    the same topic, inserts `version = max(version) + 1` with the note and `supersedesVersion`, and
    marks the prior published row `superseded`. The published row itself is never mutated except its
    `status`.
  - Verify: After a correction, `SELECT version, status FROM market_report_snapshots WHERE slug=…`
    shows `1/superseded` and `2/draft`; `/reports/$slug?v=1` still resolves after v2 publishes.

- [ ] **Build the admin review page**
  - Files: `src/routes/_dashboard/admin/market-reports.tsx` (new)
  - Do: Follow `src/routes/_dashboard/admin/changelog.tsx`'s structure. Table of drafts and
    published reports; detail panel showing metrics, the full coverage envelope, the narrative and
    its `narrativeSource`; publish / withdraw / correct actions with a confirmation. Publish button
    disabled until the reviewer ticks "I read the numbers and the methodology block".
  - Verify: An admin can publish a draft end-to-end from the UI; a non-admin cannot reach the page.

## Phase 5 — Public pages + SEO

- [ ] **Add the public report server functions**
  - Files: `src/shared/lib/reports-data.ts` (new)
  - Do: `createServerFn` loaders mirroring `src/shared/lib/blog-data.ts`: `getPublishedReports()`
    (index) and `getReportPage({ slug, version? })` returning `{ report, priorVersion, related }`
    with a DTO allowlist and `status='published'` (or the requested superseded version) enforced in
    the repository. Zod-validate the slug (`/^[a-z0-9-]{1,160}$/`) like `blog-data.ts` does.
  - Verify: `pnpm type-check`; a draft slug returns null.

- [ ] **Build the methodology block component**
  - Files: `src/modules/landing/components/ReportMethodology.tsx` (new)
  - Do: Render entirely from `coverage` + `metrics` (never from prose): period, "BuilderHunt's own
    index — a convenience sample assembled by a crawler and by user searches, not a census", metric
    definitions, cells covered, matrix version, daily cap, newly indexed, discovery-attributed
    share, suppression threshold, and the literal sentence "These figures describe BuilderHunt's
    index. They are not a measurement of the global developer population." Not collapsible, not
    behind a "details" toggle.
  - Verify: `pnpm test ReportMethodology` — the disclaimer sentence renders for any coverage shape,
    including one with an empty `cellsCoveredInPeriod`.

- [ ] **Build the public report routes**
  - Files: `src/routes/_landing/reports/index.tsx` (new), `src/routes/_landing/reports/$slug.tsx` (new)
  - Do: SSR loaders (not the `useEffect` fetch pattern in `_landing/changelog/$slug.tsx` — that is
    invisible to crawlers). `$slug` renders headline share, delta in pp or the explicit
    "not comparable" note, cohort activity, co-occurrence list, narrative, `<ReportMethodology>`,
    a superseded/correction banner when applicable, and a `/explore` CTA. `head()` emits title,
    description and `og:image` → `/api/og/report?slug=…`. **Do not emit a `rel="canonical"` link** —
    `src/routes/__root.tsx:62` already emits one for every route from the leaf `pathname` (lines
    14–16), which is already query-free and therefore already correct for `?v=N`; a second tag would
    conflict. Withdrawn slugs, and any explicitly requested superseded version, add
    `{ name: 'robots', content: 'noindex, follow' }`.
    Emit JSON-LD `@type: 'Dataset'` (`name`, `description`, `temporalCoverage` as an ISO interval of
    `periodStart/periodEnd`, `measurementTechnique` = the metric definitions, `variableMeasured`,
    `creator`) plus `BreadcrumbList` — deliberately not `Article`, because this is data.
  - Verify: `curl -s /reports/rust-2026-07 | grep -c "not a measurement of the global developer"`
    returns 1 (server-rendered); `curl -s '/reports/rust-2026-07?v=1' | grep -c 'rel="canonical"'`
    returns exactly 1 and its href has no `?v=`; the superseded version shows the banner and
    `noindex`; the rendered JSON-LD passes Google's Rich Results test.

- [ ] **Add the report OG image endpoint**
  - Files: `src/routes/api/og/report.tsx` (new)
  - Do: Clone `src/routes/api/og/explore.tsx` (1200×630 SVG → `@resvg/resvg-js` PNG, same
    `escapeXml`/`truncate` helpers, same fallback-to-SVG on rasterize failure, same
    `Cache-Control: public, max-age=3600, s-maxage=3600`). Render topic label, period, the share
    figure, and the qualifier "of BuilderHunt's indexed profiles" **inside the image** so a shared
    card cannot lose the caveat.
  - Verify: `curl -sI '/api/og/report?slug=rust-2026-07'` returns `image/png`; the rendered PNG
    contains the qualifier text.

- [ ] **Add reports to the sitemap and footer**
  - Files: `src/routes/sitemap[.]xml.ts`, `src/shared/components/Footer.tsx`
  - Do: Add `${SITE}/reports` (weekly, 0.8) plus one entry per published report slug
    (`lastmod = published_at`, monthly, 0.7) from a single indexed query, wrapped in try/catch so a
    DB failure degrades to today's static entries instead of a 500. Footer gains a `/reports` link
    beside `/blog`, with `data-testid="footer-reports"`.
  - Verify: `curl -s /sitemap.xml | grep -c '/reports/'` equals the published-report count; with the
    DB stopped the sitemap still returns 200.

## Phase 6 — Insights-tier gated data API

- [ ] **Add the entitlement constant and pricing copy**
  - Files: `src/shared/lib/billing-shared.ts`
  - Do: `export const MARKET_INSIGHTS_ACCESS: Record<PlanTier, boolean> = { free: false, pro: false, team: true }`
    next to `SOURCING_SPRINT_LIMITS`, with the same doc-comment convention (evaluated against the
    organization entitlement via `resolveLegacyPlanTier`, so `pro_max` maps to `team`). Add
    "Market intelligence data API" to `PLAN_PRICING.team.features`.
  - Verify: `pnpm test billing-shared` / `pnpm test pricing` — the pricing page test still passes
    with the new bullet.

- [ ] **Add the gated data endpoints**
  - Files: `src/routes/api/reports/$slug/data.ts` (new), `src/routes/api/reports/series.ts` (new)
  - Do: `requireTenantPrincipal` → `withTenantContext` → `getOrganizationEntitlement` →
    `resolveEntitlementPolicy`; deny with `403 { error: 'plan', upgradeUrl: '/pricing' }` when
    `MARKET_INSIGHTS_ACCESS[resolveLegacyPlanTier(tier)]` is false. `rateLimit('reports-data',
    userId, 60, 60)`. `/data` returns the full `metrics` + `coverage` for one report; `/series`
    returns every period for `?topic=` (all `DISCOVERY_TOPIC_SLUGS`, not just the curated set) as
    JSON or `?format=csv`. Both are read-only, no tenant data in the response.
    Then extend `scripts/db/verify-api-isolation-local.mjs` with tenant A/B checks: free-tier denied,
    team-tier allowed, and a client-supplied `organizationId` in the query string never changing the
    outcome.
  - Verify: Team-tier org gets 200 with a `coverage` object; free/pro org gets 403 with
    `upgradeUrl`; unauthenticated gets 401; 61st request in a minute gets 429;
    `pnpm test:api-isolation:local` passes with the added checks.

## Phase 7 — Monthly digest email

- [ ] **Add the digest consent document and revoke path**
  - Files: `src/routes/api/consent/index.ts`, `src/shared/lib/repositories/account-privacy.ts`
  - Do: Add `market_digest` to the `ConsentBody` document enum (and **not** to
    `CURRENT_VERSIONS`/`needsAcceptance` — it is optional marketing, never a blocking consent). Add
    `revokeAccountConsent(userId, document)` setting `revoked_at = now()` on the latest matching row
    and `listActiveDigestConsents()` (rows where `document='market_digest' AND revoked_at IS NULL`).
    Support `DELETE` on the route to revoke.
  - Verify: `pnpm test account-privacy`; POST then DELETE leaves the user unsubscribed; the
    `needsAcceptance` payload is unchanged for every existing document.

- [ ] **Add the signed one-click unsubscribe endpoint**
  - Files: `src/routes/api/reports/digest/unsubscribe.ts` (new), `src/shared/lib/market-reports/unsubscribe-token.ts` (new + `.test.ts`)
  - Do: Pure `signUnsubscribeToken(userId)` / `verifyUnsubscribeToken(token)` using HMAC-SHA256 over
    `market-digest:v1:<userId>` with `BETTER_AUTH_SECRET`, constant-time compare (mirror
    `src/shared/lib/auth/cron.ts`'s `secretsMatch`). The route accepts `GET` and `POST` (RFC 8058
    one-click), needs no session, revokes the consent, and always returns a plain confirmation page.
  - Verify: `pnpm test unsubscribe-token`; a tampered token returns 400 and revokes nothing; a valid
    `POST` revokes and returns 200.

- [ ] **Add the digest email sender**
  - Files: `src/shared/lib/email.ts`
  - Do: `sendMarketDigestEmail(to, { reports, unsubscribeUrl })` copying `sendAlertDigestEmail`'s
    structure (E2E outbox short-circuit first, then Resend, then dev-log). Include
    `List-Unsubscribe: <url>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, the
    methodology sentence verbatim, and a visible unsubscribe link. Never include a named list.
  - Verify: With `E2E_MODE=true` the outbox captures the message and its headers; with
    `RESEND_API_KEY` unset it dev-logs instead of throwing.

- [ ] **Add the digest send endpoint**
  - Files: `src/routes/api/admin/market-reports/send-digest.ts` (new)
  - Do: Same auth pattern as the run-worker (`tryCronPrincipal ?? requirePlatformAdminPrincipal`).
    Selects reports published since the last send, refuses any report whose `digest_sent_at` is
    already set unless `?force=true`, iterates `listActiveDigestConsents()` with a per-recipient
    try/catch, sets `digest_sent_at` once, and audits the action with the recipient **count** only
    (never addresses). Returns `{ reports, recipients, sent, failed }`.
  - Verify: Second call returns `sent: 0`; a single failing recipient does not abort the run; no
    email address appears in any log line.

## Phase 8 — Named-list content type (ships disabled)

- [ ] **Add the feature flag**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: `MARKET_REPORT_NAMED_LISTS_ENABLED: z.enum(['true', 'false']).default('false')` and
    `MARKET_REPORT_NAMED_LIST_MIN_CANDIDATES: z.coerce.number().int().positive().default(25)`.
    **Never `z.coerce.boolean()`** — coercion is `Boolean(input)`, so `'false'` parses to `true` and
    an operator explicitly disabling the flag would *enable* the feature guarding the plan's biggest
    privacy risk. `z.enum(['true','false'])` is the pattern every real boolean flag uses
    (`src/shared/lib/env.ts:50,58,70,98,99`: `AI_DISABLED`, `ENRICHMENT_ENABLED`,
    `STRIPE_BILLING_ENABLED`, `SIGNUP_*`). Compare with `=== 'true'` at call sites. The numeric var
    keeps `z.coerce.number()`, matching `DISCOVERY_CELLS_PER_RUN` — numeric coercion is safe and
    rejects non-numeric input. Names/placeholders only in `.env.example`.
  - Verify: `pnpm test env` — parsing `'false'` yields the string `'false'` and the feature stays
    off; a non-`true|false` value fails validation rather than silently enabling; the worker skips
    named lists when the var is unset.

- [ ] **Add the subject opt-in control**
  - Files: `src/routes/api/me/builder/$builderId.ts`, `src/shared/lib/repositories/builder-claims.ts`, `src/routes/_dashboard/me/index.tsx`
  - Do: Extend the `PATCH` body with `includeInPublicRankings: z.boolean().optional()` and
    `updateVerifiedBuilderProfile` to persist it (same claim-ownership check it already performs).
    In the profile editor add a default-off checkbox with copy that states plainly: "Allow
    BuilderHunt to include my name in public ranked lists. Off by default; you can turn it off at
    any time and you will be removed from every list immediately."
  - Verify: Toggling persists; a user cannot set the flag on an identity they have not verified
    (404/403, asserted in `pnpm test builder-claims`).

- [ ] **Add the eligibility query**
  - Files: `src/shared/lib/repositories/market-reports.ts`
  - Do: `listNamedListCandidates(topicSlug, limit)` — join `builder_claims` (status `verified`) ×
    `published_builder_profiles` (`include_in_public_rankings = true`) × `builder_identities`,
    excluding anyone where `is_builder_processing_restricted(builder_identity_id)` is true (the
    existing SQL function used by the enrichment paths), ordered by first-party signals only
    (`followersCount`, profile-change activity). Also
    `listRenderableListEntries(reportId)` applying the **same** filter live at render time.
  - Verify: `pnpm test market-reports` — a restricted identity is absent from both functions; an
    opted-out identity is absent; ordering never consults an AI score.

- [ ] **Generate and render named lists behind the guard**
  - Files: `src/lib/market-reports/worker.ts`, `src/routes/_landing/reports/$slug.tsx`
  - Do: When the flag is on, generate `kind: 'named_list'` drafts storing only
    `(reportId, builderIdentityId, rank, basis)`; refuse to generate (and refuse to publish) when
    candidates < `MARKET_REPORT_NAMED_LIST_MIN_CANDIDATES`. The page renders from
    `listRenderableListEntries` — so a withdrawal takes effect on the next pageview with no
    regeneration — links each entry to `/builders/$builderId`, and emits `ItemList` JSON-LD built
    from the filtered entries only. Ranks are renumbered densely after filtering.
  - Verify: With the flag off, no named-list draft is created and `/reports/<named-slug>` 404s. With
    the flag on and 5 candidates, generation reports `insufficientData`. With 30 candidates,
    revoking one subject's opt-in removes them from the rendered page on the next request without
    touching the DB row.

- [ ] **Register the AI narrative task**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/ai/tasks.test.ts`
  - Do: Add `market-report-narrative`: tier `server-only`; input
    `z.object({ topicLabel: z.string(), direction: z.enum(['rose','flat','fell','unknown']), comparable: z.boolean(), coOccurringTopicLabels: z.array(z.string()).max(8) })`
    — **no figures**; output per spec.md §5 with a `.superRefine` rejecting any `/\d/` in any field;
    `cacheTtlSeconds: 2592000`; `allowances: { free: 0, pro: 0, team: 0 }`; `maxOutputTokens: 700`;
    system prompt forbidding numbers, percentages, growth claims, and any statement about the world
    outside BuilderHunt's index. Extend the registry test.
  - Verify: `pnpm test tasks.test` — the output schema rejects `{ headline: 'Rust up 18%' }`; the
    registry entry's allowances are all zero.

- [ ] **Wire the narrative into the worker with the digit guard**
  - Files: `src/lib/market-reports/worker.ts`
  - Do: When `MINIMAX_API_KEY` is set and the task is not disabled, call `minimaxChat` with the
    registry definition (as `src/lib/semantic/semantic-search.ts` does), capped at
    `NARRATIVE_MAX_PER_RUN = 12` per run, cached via the AI cache. Run `assertNoForbiddenClaim` on
    the result; on any failure (parse, digits, forbidden claim, provider error) fall back to
    `buildTemplateNarrative` and set `narrativeSource: 'template'`.
  - Verify: With `AI_DISABLED=true` every draft has `narrative_source = 'template'`; with a stubbed
    provider returning a digit-bearing narrative, the draft still falls back to template.

- [ ] **Full verification pass**
  - Files: none
  - Do: `pnpm test && pnpm type-check && pnpm lint && pnpm test:api-isolation:local`. Manual e2e:
    run the worker for two consecutive periods → publish → `/reports/<slug>` server-renders the
    methodology sentence and a pp delta; edit `DISCOVERY_MATRIX` and regenerate → the delta becomes
    "not comparable"; withdraw → page 410s and leaves the sitemap; subscribe, send digest,
    one-click unsubscribe.
  - Verify: All green; every published page carries the disclaimer; no report contains a relative
    percentage growth claim.
