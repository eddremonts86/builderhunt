# Tasks — bound or batch the reads with no table UI

> **Status**: `pending`
> **Depends on**: [`01-read-path-audit`](../01-read-path-audit/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Work from a fresh detector run — plans 07–11 have already removed entries from the audit's snapshot.

- [ ] **Re-run the detector and take the current list**
  - Files: none
  - Do: `node scripts/check-unbounded-reads.mjs`. Compare against plan 01's classification and note
    which entries earlier plans already closed.
  - Verify: the remaining list is fully covered by the tasks below; anything unaccounted for is added
    here rather than left over.

- [ ] **Bound the model-bounded reads with a stated reason**
  - Files: `src/shared/lib/repositories/public-surface-indexing.ts`,
    `src/shared/lib/auth/organization-lifecycle.ts`,
    `src/shared/lib/repositories/account-privacy.ts`,
    `src/shared/lib/repositories/billing-ledger.ts`,
    `src/shared/lib/repositories/calendar.ts`,
    `src/shared/lib/repositories/platform-operations.ts`,
    `src/shared/lib/repositories/public-radars.ts`,
    `src/shared/lib/repositories/seat-usage.ts`
  - Do: add `.limit(n)` where n is derived from the source of truth rather than a literal — e.g.
    `.limit(SEO_SURFACES.length)` with the comment
    `// one row per governed surface, seeded by drizzle/0083`. A bare `.limit(3)` is a guess dressed
    as a bound.
  - Verify: every added limit has a comment; `pnpm test` green; the detector's count drops by the
    number of reads touched.

- [ ] **Convert the credit-grant and refund reads to batch loops**
  - Files: `src/shared/lib/repositories/billing-ledger.ts`, `src/shared/lib/repositories/billing.ts`
  - Do: `listActiveCreditGrantsByEarliestExpiry`, `lockActiveCreditGrantsByEarliestExpiry`,
    `listExpiredButStillActiveGrants` and `listPendingBillingRefundsWithoutProviderRefund` become
    chunked cursor loops. The cursor derives from data (expiry plus id), not a counter, so a retry
    resumes rather than restarts.
  - Verify: existing billing ledger tests green; allocation over a fixture with more grants than one
    batch still allocates against every eligible grant.

- [ ] **Convert the export path, preserving completeness**
  - Files: `src/shared/lib/billing/accounting-export.ts`
  - Do: stream or chunk rather than materialising the whole export. Output must be **identical**, not
    merely similar — an export missing its tail is a finding an auditor makes, not a bug a user
    reports.
  - Verify: export a seeded organization before and after; the two outputs are byte-identical.

- [ ] **Convert the deletion path, proving full coverage**
  - Files: `src/shared/lib/repositories/account-privacy.ts`,
    `tests/unit/shared/lib/repositories/account-privacy.test.ts`
  - Do: `hardDeleteAccountSubject` becomes a chunked loop that keeps going until nothing remains.
    Partial deletion is the failure mode; the loop's exit condition is "no rows left", never a page
    count.
  - Verify: seed a subject with more rows than one batch, run the deletion, assert **zero** rows
    remain in every affected table.

- [ ] **Bound the remaining batch reads**
  - Files: `src/shared/lib/auth/organization-lifecycle.ts`,
    `src/shared/lib/repositories/builder-claims.ts`,
    `src/shared/lib/repositories/profile-removal.ts`,
    `src/shared/lib/repositories/public-radars.ts`
  - Do: `processPendingOrganizationDeletions`, `listPublishedPortfolioClaimIds`,
    `listActiveSuppressions` and `listAllPublicRadarSlugs` become chunked loops. The sitemap and
    suppression consumers need every row, so the loop must complete, not stop at a page.
  - Verify: `/sitemap.xml` lists the same slug set as before; a suppressed profile is still
    suppressed.

- [ ] **Give the worker scans an explicit limit**
  - Files: the 13 worker reads named by the detector (`*-worker.ts`, `discovery`, `enrichment`,
    `reconciliation` paths)
  - Do: add `.limit(BATCH)` and a comment. These already lease-batch via columns like
    `enrichment_jobs_worker_scan_idx`; this makes the bound explicit rather than implied. Do not
    redesign the HTTP-triggered worker pattern (`plans/_meta/conventions.md` rule 7).
  - Verify: `node scripts/check-unbounded-reads.mjs` reports `{"unbounded":0}`; worker tests green.
