# Specification — bound or batch the reads with no table UI

> **Status**: `pending`
> **Depends on**: [`01-read-path-audit`](../01-read-path-audit/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Roughly 21 of the 50 unbounded reads feed no table. `getSurfaceDirectives` reads exactly three rows (one per `SEO_SURFACES` entry, seeded by `drizzle/0083`). `hardDeleteAccountSubject` and `getAccountingExport` must cover every row by definition. The 13 worker scans already lease-batch via columns like `enrichment_jobs_worker_scan_idx` but declare no explicit limit.

## Problem

Plans 07–11 fix the reads a person looks at. The rest are just as unbounded and less visible: an
export that materialises an organization's entire billing history, a deletion that loads every row
it is about to remove, a suppression check that reads every active suppression.

These cannot all be paginated. A deletion that stops after 50 rows is a data-integrity bug, and an
export that returns the first page is wrong in a way an auditor notices.

## Goal

Every remaining read declares a bound, using the mechanism that is correct for it — so plan 13's
gate can be switched on without exceptions.

## The three outcomes

**Model-bounded.** The maximum is fixed by the data model, so `.limit(n)` is the honest expression
of a fact rather than a truncation. The limit gets a comment naming *why* n is the ceiling —
otherwise the next reader cannot tell a real bound from a guess:

```ts
// SEO_SURFACES.length — one row per governed surface, seeded by drizzle/0083.
.limit(SEO_SURFACES.length)
```

Candidates: `getSurfaceDirectives`, `listSurfaceIndexingForAdmin`, `listMyOrganizations`,
`listInvitationsForEmail`, `listOwnedOrganizationsWithOtherMembers`,
`listAllocationsForReservation`, `listBusyRanges` (bounded by the requested window),
`syncScheduleRegistry`, `listScheduleRegistry`, `listPublicRadarSlugsForSavedQueryIds`,
`listSeatUsageForOrgDay`.

**Batch.** Must cover everything, so it becomes a chunked cursor loop that never holds the whole
set in memory. Candidates: `hardDeleteAccountSubject`, `getAccountingExport`,
`processPendingOrganizationDeletions`, `listActiveCreditGrantsByEarliestExpiry`,
`lockActiveCreditGrantsByEarliestExpiry`, `listExpiredButStillActiveGrants`,
`listPendingBillingRefundsWithoutProviderRefund`, `listPublishedPortfolioClaimIds`,
`listActiveSuppressions`, `listAllPublicRadarSlugs`.

**Worker batch.** The 13 worker scans already process in leased batches; they need an explicit
`.limit(BATCH)` and a comment, not a redesign.

## Non-goals

- **Paginating a deletion or an export.** Explicitly rejected: partial coverage is a bug, not a
  performance win.
- **Redesigning the worker pattern.** The HTTP-triggered idempotent worker stays
  (`plans/_meta/conventions.md` rule 7).
- **Touching scalar aggregates.** They return a number, not rows.

## Correctness risk

The one way this plan does damage is by classifying a batch read as a page read. A deletion that
silently covers 50 rows, or an export missing its tail, is worse than the unbounded read it
replaced — and both fail quietly.

So every read converted here names the caller that consumes it, and the deletion and export paths
are reviewed individually rather than by name pattern. Their existing tests must still pass, and
where a test does not exist for completeness, this plan adds one.

## Success metrics

- `node scripts/check-unbounded-reads.mjs` reports `{"unbounded":0}`.
- Every `.limit(` added in this plan has a comment naming why that number is the bound.
- `hardDeleteAccountSubject` removes every row for a subject with more rows than one batch —
  asserted by a test that seeds past the batch size.
- `getAccountingExport` output for a seeded organization is byte-identical before and after.
- `pnpm test` green.

## Resolved edge cases

- **A "model-bounded" read whose model bound later grows** (a fourth SEO surface). The limit is
  derived from the source of truth (`SEO_SURFACES.length`), not a literal, so it grows with it.
- **A batch loop that fails halfway.** Existing idempotency applies — the loop is resumable because
  the cursor is derived from data, not from a counter.
- **A read used by both a worker and a request path.** It gets the batch form, and the request path
  passes a page-sized limit. One function, two callers, one bound.
