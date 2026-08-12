# Plan — bound or batch the reads with no table UI

> **Status**: `implemented`
> **Depends on**: [`01-read-path-audit`](../01-read-path-audit/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: ~21 reads across `src/shared/lib/repositories/`, `shared/lib/billing/`, `shared/lib/auth/organization-lifecycle.ts`. No UI changes.

## Sequence

1. **Re-run the detector.** Plans 07–11 have already removed entries; work from the current list,
   not the audit's snapshot.
2. **Model-bounded first.** They are one-line changes with a comment, and clearing them shrinks the
   list so the batch work is easier to see.
3. **Batch reads second, one at a time**, deletion and export last and individually reviewed.
4. **Worker scans last** — a limit and a comment each.

Model-bounded before batch because the batch conversions are the ones that can introduce a data
bug, and doing them against a short list is safer than against a long one.

## Independence

This plan depends only on plan 01. It can run in parallel with 07–11 — it touches repository
internals, not the shell — which makes it useful filler while a UI migration is in review.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A batch read is converted to a page read and silently covers 50 rows | Medium | **High** — a partial deletion or an incomplete export, failing quietly | Every conversion names its consumer; deletion and export reviewed individually, never by name pattern; a test seeds past one batch and asserts full coverage |
| A `.limit(n)` literal is a guess dressed as a bound | Medium | Medium — the next reader cannot tell | Every limit carries a comment naming why n is the ceiling, and derives from the source of truth where one exists (`SEO_SURFACES.length`, not `3`) |
| A batch loop is not resumable and a mid-run failure leaves partial work | Low | Medium | Cursors derive from data rather than a counter, so a retry resumes; existing worker idempotency is unchanged |
| A shared read gets the wrong bound for one of its two callers | Medium | Medium | A read used by a worker and a request path takes the batch form, with the request path passing a page-sized limit |

## Rollback

Per-read commits. The riskiest three — deletion, export, credit-grant allocation — revert
independently of everything else.
