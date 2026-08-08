# Tasks — bound or batch the reads with no table UI

> **Status**: `implemented`
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

- [x] **Bound the model-bounded reads with a stated reason**
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

    **Done — `{"unbounded":0}`.** Every file the task names is bounded, plus the thirty others the
    fresh detector run turned up.

    The bulk needed a **fourth** category the spec's three do not describe: a read with no derivable
    model ceiling, feeding a surface that renders it whole. `db/read-bounds.ts` names five of those —
    `ENTITY_DETAIL_LIMIT`, `USER_SCOPED_LIMIT`, `OPERATOR_LIST_LIMIT`, `ANALYTICS_WINDOW_LIMIT`,
    `SWEEP_BATCH` — and each carries the argument for why it is a bound rather than a truncation. The
    spec's warning is about `.limit(3)` with nothing said; the answer is not to avoid policy ceilings
    but to state what each one claims. `USER_SCOPED_LIMIT`, for instance, claims the set grows one row
    per deliberate human act, so an account past it is the abuse system's problem and not the pager's.

    Where a real source of truth existed it was used, and several were hiding in plain sight:
    `SEO_SURFACES.length`, `OPERATIONAL_SCHEDULES.length`, `INVITATION_STATUSES.length`,
    `Object.keys(SUBSCRIPTION_CATALOG).length + Object.keys(PACK_CATALOG).length`, `schedules.length`
    for the registry it is reconciling, and — for four reads — the caller's own `inArray` list, which
    is the tightest bound available and needs no constant at all.

- [x] **Convert the credit-grant and refund reads to batch loops**
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

    `listPendingBillingRefundsWithoutProviderRefund` is done too: a batch of 200 that its caller
    drains, because every row in that queue is a refund the operator approved and Stripe never
    received. Stopping at a boundary leaves money owed to a customer.

- [x] **Convert the export path, preserving completeness**
  - Files: `src/shared/lib/billing/accounting-export.ts`
  - Do: stream or chunk rather than materialising the whole export. Output must be **identical**, not
    merely similar — an export missing its tail is a finding an auditor makes, not a bug a user
    reports.
  - Verify: export a seeded organization before and after; the two outputs are byte-identical.
  - **Done, and the evidence is arithmetic rather than a snapshot.** A snapshot would agree with a
    truncated export the day someone re-recorded it, so the new test seeds **120 refunds and 120
    disputes** with known amounts and asserts the export's totals equal the sums — and it was run
    green against the *unbounded* implementation first, so it is a before-image in the only sense
    that matters.

    Three of the export's five reads per organization were unfiltered: every refund, every dispute
    and every active grant the organization had ever had, with the window applied afterwards in a
    `for` loop. They are SQL aggregates now. Two of them were `listBillingRefunds` and
    `listActiveBillingCreditGrants` — reads plan 10 deliberately left unbounded *because this caller
    needed all of them*. It never needed the rows; it needed the totals.

    The two revenue reads stay row-shaped but `GROUP BY` first: their amounts come from the catalog in
    code rather than from a column, so SQL can only supply the counts per key. One row per distinct
    catalog key is bounded by the catalog.

- [x] **Convert the deletion path, proving full coverage**
  - Files: `src/shared/lib/repositories/account-privacy.ts`,
    `tests/unit/shared/lib/repositories/account-privacy.test.ts`
  - Do: `hardDeleteAccountSubject` becomes a chunked loop that keeps going until nothing remains.
    Partial deletion is the failure mode; the loop's exit condition is "no rows left", never a page
    count.
  - Verify: seed a subject with more rows than one batch, run the deletion, assert **zero** rows
    remain in every affected table.
  - **Done, with the batch size as a parameter and a stated reason.** The unbounded read here was the
    subject's *membership* list — the deletes themselves are `DELETE … WHERE` statements, which are
    set-based and already covered by the FK-order test beside the new one. A membership missed is the
    subject's private data surviving in an organization while the compliance row says `completed`.

    The loop resumes from the membership's own `organization_id` rather than an offset, because it
    deletes as it goes and an offset would shift under its own writes.

    The new test proves the loop — every membership past the boundary visited exactly once, and the
    walk terminates — and says plainly what it does not prove: unit tests connect as a superuser, so
    `withTenantContext`'s per-organization policy is inert here and evidence for the tenant boundary
    still has to come from e2e or `pnpm test:rls:local`. The batch size is a parameter so this stays a
    fast unit test of the termination condition instead of a fixture with fifty-one organizations.

    One thing the change broke and the suite caught: `legal.test.ts` mocks the whole repository module
    and did not export `DELETION_BATCH`, so the loop's `due.length < DELETION_BATCH` became
    `n < undefined` — false — and the worker asked the mock for another batch forever.

- [x] **Bound the remaining batch reads**
  - Files: `src/shared/lib/auth/organization-lifecycle.ts`,
    `src/shared/lib/repositories/builder-claims.ts`,
    `src/shared/lib/repositories/profile-removal.ts`,
    `src/shared/lib/repositories/public-radars.ts`
  - Do: `processPendingOrganizationDeletions`, `listPublishedPortfolioClaimIds`,
    `listActiveSuppressions` and `listAllPublicRadarSlugs` become chunked loops. The sitemap and
    suppression consumers need every row, so the loop must complete, not stop at a page.
  - Verify: `/sitemap.xml` lists the same slug set as before; a suppressed profile is still
    suppressed.
  - **Done.** `drainSweep` in `db/read-bounds.ts` holds the loop for the four reads whose caller needs
    every row, and the four call sites use it: the sitemap's radar slugs and portfolio claims, the
    suppression filter, and the incident routes' subscriber list. Each of those is silent when it is
    wrong — a page that stops being indexed, a profile still shown after someone had it removed, a
    subscriber who asked to be told about incidents and was not.

    `listPublishedPortfolioClaimIds` kept its JavaScript filter deliberately. The `published` flag
    lives inside a jsonb document and `parsePortfolioSettings` is the one place that knows its shape,
    including its defaults; duplicating that as a jsonb path expression would be two sources of truth
    for "is this published". What moved is the bound, not the predicate.

    `listWorkerSeenSourceIds` is the fifth, and the most important one to get right: it is a radar's
    dedup memory, so a row missing from it is a match the user is shown **again**. It drains, even
    though the set grows for the lifetime of the radar.
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

- [x] **Give the worker scans an explicit limit**
  - Files: the 13 worker reads named by the detector (`*-worker.ts`, `discovery`, `enrichment`,
    `reconciliation` paths)
  - Do: add `.limit(BATCH)` and a comment. These already lease-batch via columns like
    `enrichment_jobs_worker_scan_idx`; this makes the bound explicit rather than implied. Do not
    redesign the HTTP-triggered worker pattern (`plans/_meta/conventions.md` rule 7).
  - Verify: `node scripts/check-unbounded-reads.mjs` reports `{"unbounded":0}`; worker tests green.
  - **Done, and the last one standing was the one plan 10 had deliberately kept.**
    `listSprints` fed the dashboard's action queue, whose rules filter by status — which is exactly why
    plan 10 refused to put a naive `.limit()` on it: the nudge for a stalled sprint could be sitting
    past the boundary. The fix is not a bigger limit. `listActionQueueSprints` moves **both** rules'
    predicates into SQL, so what comes back is only rows that will produce an item: `completed` with a
    `having count(...) > 0`, or `paused`, or `active` with a last run before the stall cutoff. The
    `resultCount > 0` test was a JavaScript filter over every sprint the organization had ever run, and
    it is the whole reason the read could not be bounded.

    `sprintStalledBefore` is exported from `action-rules.ts` so the SQL predicate and the rule cannot
    drift: one of them calling a sprint stalled while the other does not would either show a nudge for
    a row the read excluded, or hide one it returned.
