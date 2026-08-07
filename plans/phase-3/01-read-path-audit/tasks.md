# Tasks — read-path audit and unbounded-read detector

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: New script only. `scripts/check-route-coverage.mjs` is the shape to follow.

- [ ] **Write the detector in report-only mode**
  - Files: `scripts/check-unbounded-reads.mjs`, `package.json`
  - Do: use the installed TypeScript compiler API to visit Drizzle list-query chains and `findMany`
    calls in exported functions, non-exported helpers and route-handler objects. Associate `.limit()`
    with the same query chain; exclude scalar aggregates structurally, not by file-wide regex. Honour
    `// unbounded-read-ok: <reason>` on the exact statement. Print commit SHA, counts and file/line/kind
    entries as JSON and **exit 0**.
  - Verify: `node scripts/check-unbounded-reads.mjs` prints the JSON and exits 0; add
    `"check:unbounded": "node scripts/check-unbounded-reads.mjs"` to `package.json`.

- [ ] **Validate the detector against synthetic and historical cases**
  - Files: `scripts/check-unbounded-reads.mjs`
  - Do: add scratch fixtures for an exported repository function, nested route handler,
    non-exported helper, scalar aggregate, two queries in one function where only one is limited,
    and an approved comment. Compare the fresh output with the old survey and investigate every
    difference, but never force the count to match history.
  - Verify: each positive fixture increments exactly once, each negative fixture increments zero,
    scratch files are removed, and the committed classification records the current git SHA.

- [ ] **Classify every unbounded read**
  - Files: this file (the table below)
  - Do: assign **page**, **model-bounded** or **batch** to each entry, reading the caller to
    decide. A read whose consumer needs every row is `batch`, never `page`.
  - Verify: `unbounded` count equals page + model-bounded + batch rows; no remainder.

    **Page** — feeds a list UI that grows with usage:
    `lib/sprints/service.ts` (`listSprints`, `listSprintResults`) ·
    `shared/lib/auth/organization-lifecycle.ts` (`listOrganizationMembers`, `listPendingInvitations`) ·
    `shared/lib/billing/seller-profile.ts` (`listSellerProfileHistory`) ·
    `repositories/billing-disputes.ts` (`listDisputes`) ·
    `repositories/billing-ledger.ts` (`listRecentGrantsBySource`) ·
    `repositories/billing-risk.ts` (`listRecentRiskEvents`, `listRiskExceptions`) ·
    `repositories/billing.ts` (`listBillingTermsAcceptances`, `listActiveBillingCreditGrants`,
    `listBillingCreditGrantsByState`, `listBillingRefunds`) ·
    `repositories/builder-claims.ts` (`listVerifiedBuilderProfiles`) ·
    `repositories/organization-alerts.ts` (`listOrganizationAlerts`, `listOwnAlertProjections`) ·
    `repositories/organization-builders.ts` (`listOrganizationBuilderNotes`) ·
    `repositories/platform-billing.ts` (`listPlatformUsersWithPlans`) ·
    `repositories/platform-operations.ts` (`listJobRuns`) ·
    `repositories/saved-queries.ts` (`listSavedQueries`, `listLegacySavedQueries`) ·
    `repositories/user-devices.ts` (`listUserDevicesForUser`) ·
    `modules/search/components/SearchPage.tsx`

    **Model-bounded** — ceiling fixed by the data model; `.limit(n)` plus a comment naming why:
    `repositories/public-surface-indexing.ts` (`getSurfaceDirectives`,
    `listSurfaceIndexingForAdmin` — exactly `SEO_SURFACES.length`, seeded by
    `drizzle/0083_public_surface_indexing_grants.sql`) ·
    `organization-lifecycle.ts` (`listMyOrganizations`, `listInvitationsForEmail`) ·
    `repositories/account-privacy.ts` (`listOwnedOrganizationsWithOtherMembers`) ·
    `repositories/billing-ledger.ts` (`listAllocationsForReservation`) ·
    `repositories/calendar.ts` (`listBusyRanges` — bounded by the requested window) ·
    `repositories/platform-operations.ts` (`syncScheduleRegistry`, `listScheduleRegistry` —
    the registry is code-defined) · `repositories/public-radars.ts`
    (`listPublicRadarSlugsForSavedQueryIds` — bounded by the input ids) ·
    `repositories/seat-usage.ts` (`listSeatUsageForOrgDay`)

    **Batch** — must cover every row; chunked cursor loop:
    `repositories/account-privacy.ts` (`hardDeleteAccountSubject`) ·
    `shared/lib/billing/accounting-export.ts` (`getAccountingExport`) ·
    `organization-lifecycle.ts` (`processPendingOrganizationDeletions`) ·
    `repositories/billing-ledger.ts` (`listActiveCreditGrantsByEarliestExpiry`,
    `lockActiveCreditGrantsByEarliestExpiry`, `listExpiredButStillActiveGrants`) ·
    `repositories/billing.ts` (`listPendingBillingRefundsWithoutProviderRefund`) ·
    `repositories/builder-claims.ts` (`listPublishedPortfolioClaimIds`) ·
    `repositories/profile-removal.ts` (`listActiveSuppressions`) ·
    `repositories/public-radars.ts` (`listAllPublicRadarSlugs`) ·
    plus every worker scan in the fresh inventory; lease-batched scans need an explicit
    `.limit(BATCH)` rather than a redesign

- [ ] **Record the detector's known blind spots**
  - Files: `01-read-path-audit/spec.md`
  - Do: list the read shapes the heuristic cannot see (raw `sql` templates, a read inside a
    non-exported helper, a wrapper that hides `.select`). Honesty here is what stops plan 13's
    gate from being trusted further than it deserves.
  - Verify: each blind spot names a real example path or is removed as speculative.
