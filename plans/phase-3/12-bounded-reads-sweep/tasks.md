# Tasks — bound or batch the reads with no table UI

> **Status**: `pending`
> **Depends on**: [`01-read-path-audit`](../01-read-path-audit/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Work from a fresh detector run — plans 07–11 have already removed entries from the audit's snapshot.

- [x] **Re-run the detector and take the current list**
  - Files: none
  - Do: `node scripts/check-unbounded-reads.mjs`. Compare against plan 01's classification and note
    which entries earlier plans already closed.
  - Verify: the remaining list is fully covered by the tasks below; anything unaccounted for is added
    here rather than left over.
  - **Done. 93 at the start of this plan, and the first thing the fresh run produced was a defect in
    the detector rather than in the code.** `SearchPage.tsx` was counted for
    `inputRef.current?.select()` — the DOM method for selecting an input's text, matched by the same
    `\.select\(\)` that catches Drizzle's select-all. Harmless while the script only reported; a
    false positive in plan 13's gate is a component that cannot focus a text field without an
    exemption comment explaining it is not a query. The script now skips any file that cannot reach a
    database at all, which is checked before anything else. 93 → 92.

    Four entries the list contained that plan 01 had already predicted: `sumReservedUnitsSince`,
    `sumRefundedUnitsSince`, `sumSettledUnitsSince` and `findEarliestPaidGrantCreatedAt` are
    "aggregates that are not aggregates" — they read rows and reduce in JavaScript. They are handled
    as aggregates below rather than as list reads, which is what plan 01's note said they were.

    Two clusters the task's own file list did not anticipate, both counted here:
    - **Seven copies of `listWorkerOrganizationIds`**, one per worker repository, each reading the
      whole organizations table. The duplication is deliberate (tenant boundary), so the fix had to
      leave the query duplicated and share only the bound.
    - **Two operator registers** (`search_sources`, `solution_sources`) whose row count is a
      property of the migrations rather than of usage — a third outcome the spec's three do not
      name, and the one where a `.limit()` provably truncates nothing.

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
    `// one row per governed surface, seeded by drizzle/0083_public_surface_indexing_grants.sql`.
    A bare `.limit(3)` is a guess dressed as a bound.
  - Verify: every added limit has a comment; `pnpm test` green; the detector's count drops by the
    number of reads touched.
  - **In progress — 93 → 70.** `public-surface-indexing.ts` is the shape the task describes exactly:
    `.limit(SEO_SURFACES.length)`, a ceiling that grows with the list rather than with the table.

    The two operator registers needed a **fourth** outcome the spec does not name. There is no
    code-side count to derive from — `search_sources` holds thirteen implemented connectors plus two
    retired rows plus four external-link-only platforms, and `IMPLEMENTED_SEARCH_CONNECTORS.length`
    is none of those totals. What *is* true is that every row arrives by migration, so the count is a
    fact about the schema and a bounded read of it truncates nothing. Both registers therefore carry a
    declared ceiling **plus a guard that the ceiling still holds**, which reads one row past the limit
    on purpose: a check that fetches exactly as many rows as it expects to exist cannot notice the row
    that broke the assumption.

    Still open on this task: `organization-lifecycle.ts`, `account-privacy.ts`, `calendar.ts`,
    `platform-operations.ts`, `public-radars.ts`, `seat-usage.ts`.

- [ ] **Convert the credit-grant and refund reads to batch loops**
  - Files: `src/shared/lib/repositories/billing-ledger.ts`, `src/shared/lib/repositories/billing.ts`
  - Do: `listActiveCreditGrantsByEarliestExpiry`, `lockActiveCreditGrantsByEarliestExpiry`,
    `listExpiredButStillActiveGrants` and `listPendingBillingRefundsWithoutProviderRefund` become
    chunked cursor loops. The cursor derives from data (expiry plus id), not a counter, so a retry
    resumes rather than restarts.
  - Verify: existing billing ledger tests green; allocation over a fixture with more grants than one
    batch still allocates against every eligible grant.
  - **Done for the grant reads; the refund read is still open.** Five reads in the credit ledger
    fetched every row an organization had ever written and then filtered by the window in JavaScript.
    Three of them returned **one integer** after materialising a whole account history, and
    `getAvailableCreditBalance` did it on the reservation path — which every metered AI call goes
    through. The predicate that would have bounded them was sitting one step too late. They are SQL
    aggregates now, with every JS filter moved into the `WHERE` clause.

    The batch order is `(expires_at, id)`, and the trailing term is not decoration: a pack and a
    subscription window bought together expire in the same instant, and a batch boundary inside that
    tie hands the same grant out twice or skips it. That is money, not a display glitch.

    `drainActiveCreditGrants` holds the loop rather than each call site, because "take the first
    batch and call it the set" is the one way this change does damage and there are two callers. The
    allocation walk still stops the moment it has enough units, so the common case reads one batch and
    takes locks on nothing more than it used.

    `listPendingBillingRefundsWithoutProviderRefund` is **not** done.

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
  - **Partly done: `processPendingOrganizationDeletions` is still open; the every-organization scan
    it shares with six other workers is not.** Seven worker repositories each kept their own
    `listWorkerOrganizationIds`, and every one read the whole organizations table. The duplication is
    deliberate — the alternative is one module importing another's worker DB handle, and the tenant
    boundary is why those handles are separate — so the query stays duplicated and only the batch size
    and the drain loop are shared, in a module that imports nothing.

    They are batches, not pages, and all seventeen call sites drain them. A worker that processes the
    first five hundred organizations and stops has not failed: it has just not evaluated the alerts,
    reconciled the subscriptions or finalised the deletions for every tenant past that point, and
    nobody is waiting on the five-hundred-and-first to notice. The cursor is the organization id
    ascending — data rather than a counter — so a run that dies halfway resumes where it stopped.

- [ ] **Give the worker scans an explicit limit**
  - Files: the 13 worker reads named by the detector (`*-worker.ts`, `discovery`, `enrichment`,
    `reconciliation` paths)
  - Do: add `.limit(BATCH)` and a comment. These already lease-batch via columns like
    `enrichment_jobs_worker_scan_idx`; this makes the bound explicit rather than implied. Do not
    redesign the HTTP-triggered worker pattern (`plans/_meta/conventions.md` rule 7).
  - Verify: `node scripts/check-unbounded-reads.mjs` reports `{"unbounded":0}`; worker tests green.
