# Plan — migrate the platform content managers

> **Status**: `pending`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Three UI files plus `src/shared/lib/blog.ts`. No migration, no index — the blog is file-backed and changelog/roadmap are small.

## Sequence

1. **Capture the current test ids first.** Grep every `data-testid` out of the three files into a
   list before editing anything. That list is the contract for the rest of the plan.
2. **Changelog, then roadmap, then blog library**, one commit each, running the regression suite
   after each.
3. **Record the blog's non-SQL exemption** in plan 04's guard.

Capturing ids before editing means the check is a comparison rather than a memory test.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A `data-testid` changes and the regression suite goes red for markup reasons | **High** if not guarded | Medium — lost debugging time and a distrusted gate | Ids captured up front; the suite runs after each of the three commits, not once at the end; `git diff` checked for changed id literals |
| The blog's loader pagination is mistaken for a missing SQL implementation later | Medium | Low | The non-SQL exemption is explicit in the capability and in plan 04's guard output |
| Status/tag filter behaviour changes subtly | Medium | Medium — these surfaces are how content actually gets managed | Compare the filter chip counts before and after on the same content set |

## Rollback

One commit per surface. The regression suite is the tripwire, and it runs per commit, so a revert
is scoped to a single file.
