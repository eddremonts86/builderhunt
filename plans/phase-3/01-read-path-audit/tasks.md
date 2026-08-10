# Tasks — read-path audit and unbounded-read detector

> **Status**: `implemented`
> **Depends on**: nothing
> **Blocks**: [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: `scripts/check-unbounded-reads.mjs` exists and is wired as `pnpm check:unbounded`. It reports `{"unbounded":97,"aggregates":16,"exempted":0}` as of 2026-08-07.

- [x] **Write the detector in report-only mode**
  - Files: `scripts/check-unbounded-reads.mjs`, `package.json`
  - Do: use the installed TypeScript compiler API to visit Drizzle list-query chains and `findMany`
    calls in exported functions, non-exported helpers and route-handler objects. Associate `.limit()`
    with the same query chain; exclude scalar aggregates structurally, not by file-wide regex. Honour
    `// unbounded-read-ok: <reason>` on the exact statement. Print commit SHA, counts and file/line/kind
    entries as JSON and **exit 0**.
  - Verify: `node scripts/check-unbounded-reads.mjs` prints the JSON and exits 0; add
    `"check:unbounded": "node scripts/check-unbounded-reads.mjs"` to `package.json`.
  - Done: runs in 0.14 s, exits 0, and `pnpm check:unbounded` is wired. Two accuracy fixes were
    needed before the output was worth classifying, both found by reading its own output:
    - **Concise arrow bodies.** `export const listX = () => db.select()…` has no braces, so
      "the next `{` in the file" attributed three `accountDb.insert` one-liners in
      `account-privacy.ts` to a read they do not contain, and hid the seven real concise-arrow
      reads (`listAccountConsents`, `listPlatformRoadmap`, …). The extractor now recognises the
      expression form and ends it at the first `;`/non-continuing newline outside all brackets.
    - **Prose that names a read.** `getPlatformUserBillingSummary` issues one raw
      `db.execute(sql…)` and *explains* in a comment why it is not a typed `.select()`. Matching
      ran over comments, so the explanation was counted as the read. Comments are now stripped
      before matching (strings are not — a `.limit(` there is still a bound worth seeing).

- [x] **Validate the detector against synthetic and historical cases**
  - Files: `scripts/check-unbounded-reads.mjs`
  - Do: add scratch fixtures for an exported repository function, nested route handler,
    non-exported helper, scalar aggregate, two queries in one function where only one is limited,
    and an approved comment. Compare the fresh output with the old survey and investigate every
    difference, but never force the count to match history.
  - Verify: each positive fixture increments exactly once, each negative fixture increments zero,
    scratch files are removed, and the committed classification records the current git SHA.
  - **Done 2026-08-10, and the fixtures are tests rather than scratch files.** All six shapes this task
    names live in `tests/unit/scripts/lib/unbounded-reads.test.ts` — 14 cases, run by `ci:local`.
    Deliberately not "scratch files are removed": three of the six were recorded below as cases the
    text detector got *wrong*, so deleting the fixtures would delete the only thing standing between
    the rewrite and that regression returning.

    Each positive fixture increments by exactly 1 and each negative by 0, including the three that used
    to score 0 — nested route handler, non-exported helper, and two-queries-one-limit. Both retired
    false positives (the DOM `.select()` and `Buffer.from`) have cases too, and are now excluded
    *structurally*: a Drizzle read is `select` **and** `from`, so the file-level `REACHES_DATABASE`
    regex and the `NON_DRIZZLE_FROM` strip list are deleted rather than maintained.

    The output carries the commit SHA in both modes, closing the last clause of the Verify line.

    **What the rewrite found: 45 reads the text version reported as zero.** Two shapes beyond the six
    fixtures turned up in the sweep — `selectDistinct`/`selectDistinctOn` were not recognised as list
    reads at all, and `listAccessRequests` was a *false positive*, bounded on both branches but built
    from a shared `const query = db.select().from(…)`. Both now have fixtures. All 45 are resolved and
    the count is zero again; see `spec.md` for the updated blind-spot list, where four of five are
    closed and one new one replaces them.

  - **Historical comparison, from the earlier revision of this task.** Three fixtures were run and behaved:
    an exported repository read incremented by exactly 1, an aggregate-only projection moved
    `aggregates` and not `unbounded`, and an `unbounded-read-ok` comment moved `exempted` and not
    `unbounded`. `Buffer.from(...)` produced nothing.

    **Three fixtures this revision adds would fail**, and that is the point of the revision: a
    nested route handler and a non-exported helper both increment by **0** because the text
    detector only sees exported function declarations, and the two-queries-one-limit case
    increments by 0 because any `.limit(` in the body counts as a bound. All three are recorded as
    blind spots in `spec.md`; the AST rewrite is what closes them.

    The output carries no `commit` SHA yet either.

    The historical comparison was done and is worth keeping: the detector reports far more than the
    old survey, and **the survey was the side that was wrong** — not noise, four specific things:

    | Why the survey was short | Count | Evidence |
    |---|---|---|
    | Subsystems the survey never walked | ≈29 | Nothing from `interviews.ts` (4), `solution-catalog.ts` (5), `builder-lists.ts` (2), `dashboard-overview.ts` (3), `search-sources.ts` (3), `calendar.ts` (2), `interview-documents.ts` (2), `enrichment.ts`, `access-requests.ts`, `status-subscribers.ts`, `public-feeds.ts`, `builder-profile-views.ts`, `dashboard-invitations.ts`, `solutions.ts`, `platform-content.ts`, `public-content.ts` appears in its list |
    | Reads written as concise arrows | 7 | `listAccountConsents`, `listAccountExportRequests`, `listExpiredPendingDeletionRequests`, `listPlatformRoadmap`, `listEnabledWorkerAlerts`, `listOwnAlertResultBuckets`, `listActiveFeedCapabilities` |
    | Names that have since changed | — | `listPlatformUsersWithPlans` is now `listPlatformUsers` (only its doc comment still says the old name); `listLegacySavedQueries` no longer exists, and `listVisibleSavedQueriesForPrincipal` does |
    | **Four "aggregates" that are not aggregates** | 4 | See below |

    The last row matters more than its size. The phase README exempts scalar aggregates "by
    nature — they return a number, not rows", and names `sumSettledUnitsSince` as an example.
    `sumSettledUnitsSince`, `sumReservedUnitsSince`, `sumRefundedUnitsSince` and
    `findEarliestPaidGrantCreatedAt` **return a number by loading every matching ledger row into
    Node and reducing in JavaScript** (`billing-ledger.ts:208-234, 442-470`). They are the worst
    shape in the audit, not the exempt one: they pay the full transfer cost and hide it behind a
    scalar return type. They are classified `batch` below, and the README's example should be
    changed to `getPlatformAccountMetrics`, which really is `count()` in SQL.

    Counting behaviour verified three ways, each by adding one function to a scratch file in
    `src/` and re-running: a plain unbounded read moved the count 97 → 98 → 97; an aggregate-only
    projection moved `aggregates` 16 → 17 and left `unbounded` alone; a `// unbounded-read-ok:`
    comment moved `exempted` 0 → 1 and left `unbounded` alone. `Buffer.from(...)` produced no
    entry at all, which is the false positive that inflated the first survey from 50 to 113.

- [x] **Classify every unbounded read**
  - Files: this file (the table below)
  - Do: assign **page**, **model-bounded** or **batch** to each entry, reading the caller to
    decide. A read whose consumer needs every row is `batch`, never `page`.
  - Verify: `unbounded` count equals page + model-bounded + batch rows; no remainder.
  - Done: **38 page + 26 model-bounded + 33 batch = 97**, matching `unbounded: 97` exactly, with
    no unclassified remainder. Snapshot taken 2026-08-07; plan 12 re-runs the script before
    trusting it.

### Page — 38

Feeds a list UI that grows with usage: keyset cursor, `LIMIT TABLE_PAGE_SIZE`, `PageResult`.

| Read | Consumer |
|---|---|
| `lib/sprints/service.ts:69` `listSprints` | sprint index |
| `lib/sprints/service.ts:204` `listSprintResults` | plan 07's first surface |
| `modules/search/components/SearchPage.tsx:126` `SearchPage` | plan 11 |
| `shared/lib/access-requests.ts:337` `listAccessRequests` | admin access-request queue |
| `shared/lib/auth/organization-lifecycle.ts:1075` `listOrganizationMembers` | team surface |
| `shared/lib/auth/organization-lifecycle.ts:1134` `listPendingInvitations` | team surface |
| `shared/lib/billing/seller-profile.ts:80` `listSellerProfileHistory` | seller-profile history |
| `repositories/account-privacy.ts:39` `listAccountConsents` | account privacy page |
| `repositories/account-privacy.ts:44` `listAccountExportRequests` | account privacy page |
| `repositories/billing-disputes.ts:65` `listDisputes` | disputes surface |
| `repositories/billing-ledger.ts:191` `listRecentGrantsBySource` | billing history |
| `repositories/billing-risk.ts:45` `listRecentRiskEvents` | risk surface |
| `repositories/billing-risk.ts:87` `listRiskExceptions` | risk surface |
| `repositories/billing.ts:503` `listBillingTermsAcceptances` | billing admin |
| `repositories/billing.ts:532` `listActiveBillingCreditGrants` | credits surface |
| `repositories/billing.ts:552` `listBillingCreditGrantsByState` | credits surface |
| `repositories/billing.ts:674` `listBillingRefunds` | refunds surface |
| `repositories/builder-claims.ts:368` `listVerifiedBuilderProfiles` | admin claims list |
| `repositories/builder-lists.ts:59` `listVisibleBuilderLists` | builder lists index |
| `repositories/builder-lists.ts:203` `listItemsForList` | one list's items |
| `repositories/calendar-worker.ts:169` `listRecentJobRuns` | operations job history |
| `repositories/enrichment.ts:137` `listEnrichmentEvidence` | enrichment evidence panel |
| `repositories/interview-documents.ts:581` `listSubmissionDocuments` | submission documents list — no per-submission cap constant exists, so it is not model-bounded |
| `repositories/interviews.ts:270` `listBriefVersions` | brief version history |
| `repositories/interviews.ts:627` `listSessionSegments` | transcript view |
| `repositories/interviews.ts:712` `listSuggestions` | suggestions panel |
| `repositories/interviews.ts:939` `listReportVersions` | report version history |
| `repositories/organization-alerts.ts:42` `listOrganizationAlerts` | alerts surface |
| `repositories/organization-alerts.ts:239` `listOwnAlertProjections` | alerts surface |
| `repositories/organization-builders.ts:636` `listOrganizationBuilderNotes` | builder notes |
| `repositories/platform-billing.ts:33` `listPlatformUsers` | admin users — returns every user in the system today |
| `repositories/platform-content.ts:27` `listPlatformRoadmap` | admin roadmap editor |
| `repositories/platform-operations.ts:349` `listJobRuns` | operations job history |
| `repositories/public-content.ts:66` `listPublicRoadmap` | public roadmap (plan 09) |
| `repositories/saved-queries.ts:28` `listSavedQueries` | saved queries |
| `repositories/saved-queries.ts:45` `listVisibleSavedQueriesForPrincipal` | saved queries |
| `repositories/solutions.ts:268` `listFeedback` | one run's feedback |
| `repositories/user-devices.ts:41` `listUserDevicesForUser` | account devices |

### Model-bounded — 26

Ceiling fixed by the data model, the requested window, or the caller's input array. `.limit(n)`
plus a comment naming why `n` is the ceiling.

| Read | Ceiling |
|---|---|
| `shared/lib/auth/organization-lifecycle.ts:1029` `listMyOrganizations` | organizations one user belongs to |
| `shared/lib/auth/organization-lifecycle.ts:1111` `resolveActorDisplayNames` | `actorUserIds.length` (deduped by the caller) |
| `shared/lib/auth/organization-lifecycle.ts:1178` `listInvitationsForEmail` | open invitations to one address |
| `repositories/billing-ledger.ts:405` `listAllocationsForReservation` | allocations of one reservation |
| `repositories/builder-profile-views.ts:67` `listBuilderProfileViewCounts` | one row per day in `[from, to]` |
| `repositories/calendar.ts:884` `listBusyRanges` | the requested window |
| `repositories/dashboard-invitations.ts:47` `getInvitationDistribution` | one row per invitation status |
| `repositories/dashboard-overview.ts:96` `getDashboardRecency` | `DASHBOARD_ROW_LIMITS.recencyBuckets` |
| `repositories/dashboard-overview.ts:158` `getDashboardDiscoveryTrend` | `DASHBOARD_ROW_LIMITS.recencyBuckets` |
| `repositories/dashboard-overview.ts:188` `getDashboardAlertVolume` | `DASHBOARD_ROW_LIMITS.recencyBuckets` |
| `repositories/organization-alerts.ts:274` `listOwnAlertResultBuckets` | one row per alert per day in range |
| `repositories/organization-builders.ts:668` `getOrganizationDashboardStats` | four scalars plus seven day buckets |
| `repositories/platform-operations.ts:41` `syncScheduleRegistry` | the registry is code-defined |
| `repositories/platform-operations.ts:161` `listScheduleRegistry` | the registry is code-defined |
| `repositories/public-radars.ts:61` `listPublicRadarSlugsForSavedQueryIds` | the input ids |
| `repositories/public-surface-indexing.ts:42` `getSurfaceDirectives` | `SEO_SURFACES.length`, seeded by `drizzle/0083` |
| `repositories/public-surface-indexing.ts:97` `listSurfaceIndexingForAdmin` | `SEO_SURFACES.length` |
| `repositories/search-sources.ts:48` `listSearchSources` | one row per registered connector |
| `repositories/search-sources.ts:74` `loadEnabledSearchSourceKeys` | one row per registered connector |
| `repositories/search-sources.ts:184` `assertSearchConnectorRegistryMatchesDatabase` | one row per registered connector |
| `repositories/seat-usage.ts:46` `listSeatUsageForOrgDay` | seats of one org-day |
| `repositories/solution-catalog.ts:67` `listSolutionSources` | one row per registered source |
| `repositories/solution-catalog.ts:78` `listEnabledSourceKeys` | one row per registered source |
| `repositories/solution-catalog.ts:614` `listComponentClaimSnippets` | the input `evidenceIds` |
| `repositories/solution-catalog.ts:690` `listAttributionsForEvidence` | the input `evidenceIds` |
| `lib/solutions/retrieval/lanes.ts:183` `loadCandidates` | the input `keys` |

### Batch — 33

Must cover every row. Chunked cursor loop, never materialising the set. The 13 worker scans
already lease-batch and need only an explicit `.limit(BATCH)`.

| Read | Why completeness is required |
|---|---|
| `lib/interviews/evidence.ts:55` `assembleBriefEvidence` | a brief built from partial evidence is wrong, not slow |
| `lib/solutions/indexing/project-components.ts:59` `projectComponents` | projection sweep must reach every stale component |
| `shared/lib/auth/organization-lifecycle.ts:1392` `processPendingOrganizationDeletions` | a skipped organization is never deleted |
| `shared/lib/billing/accounting-export.ts:91` `getAccountingExport` | an incomplete export is an accounting defect |
| `repositories/account-privacy.ts:292` `listExpiredPendingDeletionRequests` | a skipped request outlives its grace period |
| `repositories/account-privacy.ts:298` `hardDeleteAccountSubject` | a partial deletion leaves personal data behind |
| `repositories/alerts-worker.ts:10` `listWorkerOrganizationIds` | worker scan |
| `repositories/alerts-worker.ts:29` `listEnabledWorkerAlerts` | every enabled alert must run |
| `repositories/alerts-worker.ts:45` `listWorkerSeenSourceIds` | a missed id re-notifies the user about something already seen |
| `repositories/billing-ledger.ts:81` `listActiveCreditGrantsByEarliestExpiry` | consumption order depends on seeing every grant |
| `repositories/billing-ledger.ts:98` `lockActiveCreditGrantsByEarliestExpiry` | same, under `FOR UPDATE` |
| `repositories/billing-ledger.ts:208` `findEarliestPaidGrantCreatedAt` | **returns a scalar by loading every grant row and reducing in JS** |
| `repositories/billing-ledger.ts:221` `sumReservedUnitsSince` | **same shape — a partial sum is a wrong fraud cap** |
| `repositories/billing-ledger.ts:236` `listExpiredButStillActiveGrants` | expiry sweep must reach every grant |
| `repositories/billing-ledger.ts:442` `sumRefundedUnitsSince` | **same shape** |
| `repositories/billing-ledger.ts:457` `sumSettledUnitsSince` | **same shape — the README's "exempt by nature" example** |
| `repositories/billing-worker.ts:32` `listWorkerOrganizationIds` | worker scan |
| `repositories/billing-worker.ts:214` `listActiveAnnualBillingSubscriptions` | a skipped subscription is never renewed |
| `repositories/billing-worker.ts:240` `listGracePeriodBillingSubscriptions` | a skipped subscription never leaves grace |
| `repositories/billing.ts:778` `listPendingBillingRefundsWithoutProviderRefund` | a skipped refund is never paid out |
| `repositories/builder-claims.ts:548` `listPublishedPortfolioClaimIds` | sitemap completeness |
| `repositories/calendar-worker.ts:30` `listWorkerOrganizationIds` | worker scan |
| `repositories/calendar.ts:490` `listEventExceptions` | a missed exception renders a cancelled occurrence |
| `repositories/interview-documents.ts:51` `listWorkerOrganizationIds` | worker scan |
| `repositories/interview-web-imports.ts:33` `listWorkerOrganizationIds` | worker scan |
| `repositories/profile-removal.ts:150` `listActiveSuppressions` | a missed suppression republishes a removed profile |
| `repositories/profile-removal.ts:209` `getRemovalOperationsMetrics` | partial metrics understate an SLA breach |
| `repositories/profile-removal.ts:264` `listWorkerOrganizationIds` | worker scan |
| `repositories/public-feeds.ts:292` `listActiveFeedCapabilities` | every live feed token must be enumerated |
| `repositories/public-radars.ts:80` `listAllPublicRadarSlugs` | sitemap completeness |
| `repositories/solution-catalog.ts:492` `listTraversableEdges` | a missed edge silently truncates the graph walk |
| `repositories/sprints-worker.ts:12` `listWorkerOrganizationIds` | worker scan |
| `repositories/status-subscribers.ts:136` `listConfirmedActive` | a skipped subscriber never receives the incident notice |

- [x] **Record the detector's known blind spots**
  - Files: `01-read-path-audit/spec.md`
  - Do: list the read shapes the heuristic cannot see (raw `sql` templates, a read inside a
    non-exported helper, a wrapper that hides `.select`). Honesty here is what stops plan 13's
    gate from being trusted further than it deserves.
  - Verify: each blind spot names a real example path or is removed as speculative.
  - Done: five blind spots recorded in the spec, each with a path from this repository.
