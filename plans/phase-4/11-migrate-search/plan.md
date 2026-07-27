# Plan — migrate search onto the shell

> **Status**: `pending`
> **Depends on**: [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: One 1,731-line component and two API routes. Sequenced last because it is the only surface with all three problems at once — client sorting, its own infinite scroll, and a non-column ranking.

## Sequence

1. **Record a fixture of today's first page** for a fixed semantic query and a fixed keyword query,
   before changing anything. That fixture is how "ranking preserved" becomes checkable instead of
   asserted.
2. **Keyword mode first** — it is an ordinary `TableQuery`.
3. **Semantic mode second**, as a pre-filter pass-through.
4. **Delete the old scroll loop** only once both modes page correctly.

Recording the fixture first is the whole safety net. Migrating relevance-ranked search without a
before-image is how ranking regressions ship unnoticed.

## Why last

Sequenced after 08–10 so the shell has already absorbed sixteen other surfaces' requirements. Any
slot, renderer or capability feature search needs that does not exist yet is more likely to be a
real gap than a shell design mistake at that point.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Semantic ranking changes subtly and nobody notices | Medium | **High** — relevance is the product | A recorded fixture of today's first page, compared exactly; ranking is a pass-through, never translated into a sort |
| Passing a large ranked id set becomes the bottleneck | Medium | Medium | Measure it; if the set is large, record the limit reached rather than silently truncating |
| The 1,731-line component resists extraction and the change sprawls | High | Medium | Scope is the result list only; the filter panel, source toggles and semantic switch are explicitly out of scope |
| Removing the old `IntersectionObserver` loop breaks scroll behaviour people rely on | Medium | Medium | The shell's loop replaces it before the old one is deleted, so both are never absent at once |
| Sorting semantic results implies they are still relevance-ordered | Medium | Low — but misleading | The toolbar shows the active sort explicitly; relevance is a named sort option, not an implicit default that survives a column click |

## Rollback

One surface, one commit, two API routes. The recorded fixture also serves as the regression check
for a revert: if the reverted first page does not match the fixture, something else changed.
