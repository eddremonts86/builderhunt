# Plan — sprint results, end to end

> **Status**: `implemented`
> **Depends on**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md), [`04-sort-indexes`](../04-sort-indexes/spec.md), [`05-table-shell`](../05-table-shell/spec.md), [`06-row-virtualization`](../06-row-virtualization/spec.md)
> **Blocks**: [`08-migrate-admin-surfaces`](../08-migrate-admin-surfaces/spec.md), [`09-migrate-platform-content`](../09-migrate-platform-content/spec.md), [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Reality check**: Two files change (`src/routes/api/sprints/$sprintId/results.ts`, `src/routes/_dashboard/sprints/$sprintId/index.tsx`) plus `src/lib/sprints/service.ts`. One new e2e spec.

## Sequence

1. **Server first.** Replace the in-memory slice, keep the response shape close enough that the
   existing UI still renders. Verify with `curl` before touching React.
2. **Client second.** Swap in the shell.
3. **The shared e2e spec last**, because it needs the real endpoint and the real component to
   assert against.

Server before client means a broken step is unambiguous: if `curl` shows two pages sharing an id,
the bug is in the keyset builder, not the renderer.

## The contract may still change here

Plans 02–06 were written against fixtures. This plan is explicitly allowed to change the contract
if a real surface shows it wrong — that is what it is for. After this plan the contract is frozen,
because 08–12 depend on it.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The contract turns out wrong and plans 03/05 need rework | Medium | Medium — that is the intended cost of finding out here rather than after 18 migrations | Sequenced deliberately as the first real surface; only two files revert |
| Removing `sortSprintResults`/`filterSprintResults` from the request path orphans their unit tests | High | Low | Keep the pure helpers and their tests where they still describe real behaviour; delete a test only with a stated reason |
| `sprint.cursor` conflated with the pagination cursor | Medium | Medium — a broken progress bar or a broken page loop | Named explicitly in the spec's edge cases; the diff keeps the two identifiers distinct |
| The e2e insert-mid-pagination test is flaky | Medium | Medium — a distrusted gate is worse than none | Insert through the worker's own SQL handle inside the test, not a parallel client, so ordering is deterministic |
| Location facets regress when `computeLocationFacets` moves into the capability | Medium | Low | `country` declared as a facet dimension, with the existing facet output compared before and after |

## Rollback

Revert the two route files and `service.ts`; the previous in-memory implementation is one commit
back. Indexes from plan 04 stay, harmlessly. The shell and virtualizer keep working against
fixtures with no consumer.
