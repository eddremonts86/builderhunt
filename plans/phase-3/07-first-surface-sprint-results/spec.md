# Specification — sprint results, end to end

> **Status**: `implemented`
> **Depends on**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md), [`04-sort-indexes`](../04-sort-indexes/spec.md), [`05-table-shell`](../05-table-shell/spec.md), [`06-row-virtualization`](../06-row-virtualization/spec.md)
> **Blocks**: [`08-migrate-admin-surfaces`](../08-migrate-admin-surfaces/spec.md), [`09-migrate-platform-content`](../09-migrate-platform-content/spec.md), [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Reality check**: `src/routes/api/sprints/$sprintId/results.ts:82-85` reads every result via `listSprintResults`, then filters, sorts and slices in memory, returning a base64 *offset* as `nextCursor`. `sprint_results_sprint_created_idx` already exists. `src/lib/sprints/results.ts` holds pure filter/sort helpers with their own unit tests. In `src/routes/_dashboard/sprints/$sprintId/index.tsx`, `sprint.cursor` is the sprint's **progress** cursor feeding a progress bar — unrelated to pagination.

## Problem

Plans 02–06 are unproven. The contract, the keyset builder, the shell and the virtualizer have
only met fixtures. The shell's API is wrong in ways only a real surface reveals, and finding that
out after 18 migrations is expensive.

## Goal

One surface migrated completely — real keyset pagination in SQL, the shell, virtualization — plus
the shared e2e spec that every later migration reuses by adding itself to a parameter list.

## Why sprint results first

- It already has a cursor-shaped API to replace, so the client contract barely moves.
- `sprint_results_sprint_created_idx` already backs its default sort, so it needs no new index.
- It is the one surface where the data genuinely grows with usage, so pagination is not theoretical.
- Its filter/sort helpers are already pure and tested, so the diff is about *where* they run.

## Scope

**Server.** Delete the in-memory path (`results.ts:82-85`) and the base64-offset codec. Route
through `tablePageHandler` + `buildKeysetPage`. `listSprintResults` takes a cursor and a limit
instead of returning everything. Preserve the location facet behaviour that
`computeLocationFacets` provides today by declaring `country` as a facet dimension.

**Client.** `validateSearch: tableSearchSchema`, a `ColumnDef[]` for the result row, `DataTable`
with `rowTestId`. Delete the local filter and sort state. Do not touch `sprint.cursor`.

**Tests.** `tests/e2e/data-tables.spec.ts`, parameterised, asserting the properties every table
must have.

## The shared e2e spec

This is the durable deliverable — later plans add a surface to its parameter list rather than
writing their own.

1. **Pagination stability.** Insert a row via SQL *between* two page fetches, then assert no id
   appears twice and none is skipped. This is what proves the tiebreaker works; without it, tied
   sort values silently duplicate rows.
2. **Virtualization.** Seed 500+ rows, scroll, assert the rendered row count stays within the
   window while `aria-rowcount` reports the full total.
3. **Focus survival.** Focus a cell, `PageDown` past the render window, `PageUp` back, assert the
   same cell holds focus.
4. **Interaction.** Sort, filter, group, select loaded rows.
5. **States.** All four render.
6. **Accessibility.** axe clean, plus `aria-rowindex` on the last rendered row equals its absolute
   index.

It uses the existing per-worker disposable database and Redis namespace under `tests/e2e/harness`.

## Success metrics

- `grep -n 'slice(' src/routes/api/sprints/\$sprintId/results.ts` returns nothing.
- Page 1 and page 2 share no ids, verified against a sprint with more than 50 results.
- The pure helpers in `src/lib/sprints/results.ts` keep their existing unit tests passing, or the
  reason each removed test is obsolete is stated.
- `pnpm test:e2e tests/e2e/data-tables.spec.ts` and `pnpm test:a11y` green.

## Resolved edge cases

- **A sprint with fewer than 50 results.** Same code path; page one is also the last,
  `nextCursor` is null, the footer reads "23 of 23".
- **Sorting mid-scroll.** The cursor is dropped and the list refetches from page one, because a
  cursor minted for the previous sort is rejected by signature.
- **The two meanings of "cursor" in this file.** `sprint.cursor` is sourcing progress;
  `PageRequest.cursor` is pagination. Keep the names distinct in the diff so a later reader does
  not conflate them.
