# Tasks — sprint results, end to end

> **Status**: `pending`
> **Depends on**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md), [`04-sort-indexes`](../04-sort-indexes/spec.md), [`05-table-shell`](../05-table-shell/spec.md), [`06-row-virtualization`](../06-row-virtualization/spec.md)
> **Blocks**: [`08-migrate-admin-surfaces`](../08-migrate-admin-surfaces/spec.md), [`09-migrate-platform-content`](../09-migrate-platform-content/spec.md), [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Reality check**: `sprint_results_sprint_created_idx` already exists, so no new index is needed here.

- [ ] **Declare the sprint-results capability**
  - Files: `src/shared/lib/table/capabilities/sprint-results.ts`
  - Do: `sortable` for score, created-at, source and country; `filterable` for source, country and
    tracked; `groupable` for source and country; `tiebreaker` the result `id`; `defaultSort`
    created-at descending, which `sprint_results_sprint_created_idx` already backs. Declare
    `country` as a facet dimension to preserve today's `computeLocationFacets` output.
  - Verify: `pnpm test tests/unit/shared/lib/table/capability-index.test.ts` passes with the new
    capability registered — proving the default sort is index-backed.

- [ ] **Replace the in-memory slice with a real keyset page**
  - Files: `src/routes/api/sprints/$sprintId/results.ts`, `src/lib/sprints/service.ts`
  - Do: delete `results.ts:82-85` (`filtered.slice(decodedCursor, …)`) and the base64-offset
    `encodeCursor`/decode pair. Route through `tablePageHandler` + `buildKeysetPage`.
    `listSprintResults` takes a cursor and limit rather than returning every row.
  - Verify: `grep -n 'slice(\|encodeCursor' src/routes/api/sprints/\$sprintId/results.ts` returns
    nothing; `curl` page 1, follow `nextCursor` to page 2, confirm no shared ids on a sprint with
    more than 50 results.

- [ ] **Keep the pure helpers honest**
  - Files: `src/lib/sprints/results.ts`, `tests/unit/**` (existing sprint-results tests)
  - Do: `sortSprintResults` and `filterSprintResults` leave the request path. Keep them and their
    tests where they still describe real behaviour (the worker, or client-side provisional
    ordering). Delete a test only with a written reason.
  - Verify: `pnpm test tests/unit` green; any deleted test is named in the commit message with its
    reason.

- [ ] **Migrate the sprint results UI onto the shell**
  - Files: `src/routes/_dashboard/sprints/$sprintId/index.tsx`
  - Do: `validateSearch: tableSearchSchema`, a `ColumnDef[]` for the result row, `DataTable` with
    `rowTestId`. Delete the local `filter` state (`index.tsx:56`) and any local sort. **Do not
    touch `sprint.cursor`** — that is sourcing progress feeding a progress bar, not pagination.
  - Verify: `pnpm dev`, open a sprint with more than 50 results; scroll to page 2, sort by score,
    group by source, select rows, navigate by keyboard.

- [ ] **Write the shared e2e spec every later migration reuses**
  - Files: `tests/e2e/data-tables.spec.ts`
  - Do: parameterise over migrated surfaces. Assert (a) **pagination stability** — insert a row via
    the worker's SQL handle between two page fetches, then no duplicate and no skipped id;
    (b) **virtualization** — 500+ seeded rows, rendered row count stays within the window while
    `aria-rowcount` reports the total; (c) **focus survival** — focus a cell, `PageDown` past the
    window, `PageUp` back, same cell focused; (d) sort, filter, group, select loaded;
    (e) all four states; (f) `aria-rowindex` on the last rendered row equals its absolute index.
    Use the per-worker harness in `tests/e2e/harness`.
  - Verify: `pnpm test:e2e tests/e2e/data-tables.spec.ts` green; run it twice to catch flakiness
    (`pnpm test:e2e:repeat` exists for this).

- [ ] **Freeze the contract**
  - Files: `02-table-query-contract/spec.md`
  - Do: record that the contract is now proven against a real surface and is frozen for plans
    08–12. If this plan changed it, note what changed and why, so the next reader knows the
    fixture-era shape is gone.
  - Verify: `pnpm test`, `pnpm test:e2e`, `pnpm test:a11y`, `pnpm security:boundaries` all green.
