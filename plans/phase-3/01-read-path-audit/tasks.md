# Tasks — read-path audit and unbounded-read detector

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: New script only. `scripts/check-route-coverage.mjs` is the shape to follow.

- [ ] **Write the detector in report-only mode**
  - Files: `scripts/check-unbounded-reads.mjs`, `package.json`
  - Do: walk `src/**/*.{ts,tsx}`; flag exported functions whose body has a Drizzle list read
    (`.select({`, `.select()`, `db.select`, `tx.select`, `findMany(`) and no `.limit(`. Strip
    `(Buffer|Array|Object|Set|Map).from(` before matching. Exclude scalar aggregates (`count(`,
    `sum(`, `` sql`count ``). Honour `// unbounded-read-ok: <reason>`. Print
    `{"unbounded":N,"aggregates":M,"exempted":K}` and **exit 0**.
  - Verify: `node scripts/check-unbounded-reads.mjs` prints the JSON and exits 0; add
    `"check:unbounded": "node scripts/check-unbounded-reads.mjs"` to `package.json`.

- [ ] **Validate the detector against the survey baseline**
  - Files: `scripts/check-unbounded-reads.mjs`
  - Do: the survey found ≈50 request-serving reads, 13 worker scans and 11 aggregates. If the
    detector reports a materially different number, find out which side is wrong before
    continuing. Add a deliberate unbounded read to a scratch file and confirm the count rises
    by 1, then remove it.
  - Verify: count is within a couple of entries of 50 and every difference is explained in the
    commit message, not averaged away.

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
    `listSurfaceIndexingForAdmin` — exactly `SEO_SURFACES.length`, seeded by `drizzle/0083`) ·
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
    plus the 13 worker scans, which already lease-batch and need only an explicit `.limit(BATCH)`

- [ ] **Record the detector's known blind spots**
  - Files: `01-read-path-audit/spec.md`
  - Do: list the read shapes the heuristic cannot see (raw `sql` templates, a read inside a
    non-exported helper, a wrapper that hides `.select`). Honesty here is what stops plan 13's
    gate from being trusted further than it deserves.
  - Verify: each blind spot names a real example path or is removed as speculative.
