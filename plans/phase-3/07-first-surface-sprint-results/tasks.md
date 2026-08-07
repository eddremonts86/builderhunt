# Tasks — sprint results, end to end

> **Status**: `implemented`
> **Depends on**: [`03-keyset-pagination`](../03-keyset-pagination/spec.md), [`04-sort-indexes`](../04-sort-indexes/spec.md), [`05-table-shell`](../05-table-shell/spec.md), [`06-row-virtualization`](../06-row-virtualization/spec.md)
> **Blocks**: [`08-migrate-admin-surfaces`](../08-migrate-admin-surfaces/spec.md), [`09-migrate-platform-content`](../09-migrate-platform-content/spec.md), [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md)
> **Reality check**: The in-memory slice and the base64 offset are gone. `tests/e2e/data-tables.spec.ts` runs 9 assertions against a real browser and a real Postgres (1 skipped — this surface does not enable selection). Verified by hand at 214 rows in the isolated worktree database.

- [x] **Declare the sprint-results capability**
  - Files: `src/shared/lib/table/capabilities/sprint-results.ts`
  - Do: `sortable` for score, created-at, source and country; `filterable` for source, country and
    tracked; `groupable` for source and country; `tiebreaker` the result `id`; `defaultSort`
    created-at descending, which `sprint_results_sprint_created_idx` already backs. Declare
    `country` as a facet dimension to preserve today's `computeLocationFacets` output.
  - Verify: `pnpm test tests/unit/shared/lib/table/capability-index.test.ts` passes with the new
    capability registered — proving the default sort is index-backed.
  - Done, with two departures from the text, both forced by reality:

    **`country` is filterable and groupable, not sortable.** It is `profile->>'country'`, a key
    inside a jsonb document, and `PgColumn` cannot name it. `ColumnRef` was added to the contract so
    the location facet survives — dropping it would have been a feature regression wearing a
    migration's clothes. Sorting is refused because a sortable expression needs an expression index,
    and `capability-index.ts` matches by column name: it would have reported the sort as backed when
    nothing backed it, walking into the exact failure plan 04 exists to prevent, through the one door
    the guard cannot watch.

    **`tracked` is not filterable.** It is not a column at all — it is the viewer's own state,
    computed per request from `getTrackedKeySet`. Filtering on it would mean either persisting a
    per-viewer column or filtering after the page boundary, and the second is the in-memory slice
    this plan removes.

    **The index the reality-check line names does not work.** `sprint_results_sprint_created_idx`
    leads with `sprint_id`, and RLS puts `organization_id` in every query, so the planner cannot walk
    it; it also has no trailing tiebreaker. Plan 04 added
    `sprint_results_org_sprint_created_id_idx`. The guard passes with the capability registered.

- [x] **Replace the in-memory slice with a real keyset page**
  - Files: `src/routes/api/sprints/$sprintId/results.ts`, `src/lib/sprints/service.ts`
  - Do: delete `results.ts:82-85` (`filtered.slice(decodedCursor, …)`) and the base64-offset
    `encodeCursor`/decode pair. Route through `tablePageHandler` + `buildKeysetPage`.
    `listSprintResults` takes a cursor and limit rather than returning every row.
  - Verify: `grep -n 'slice(\|encodeCursor' src/routes/api/sprints/\$sprintId/results.ts` returns
    nothing; `curl` page 1, follow `nextCursor` to page 2, confirm no shared ids on a sprint with
    more than 50 results.
  - Done. `listSprintResults` is gone entirely rather than reshaped — `pageSprintResults` replaces
    it, and it was the only caller. The unbounded-read count went 97 → 96.

    Verified against 214 seeded rows in a browser: five pages, **214 unique ids, zero overlap
    between any two pages**, `aria-rowcount` 215 while 50 rows are loaded. An unknown sort id
    answers 400 with `Unknown sort column: nope`; a tampered cursor answers 400.

    Two route-level gates needed updating, both because the guard moved rather than disappeared:
    `check-route-coverage.mjs` gained `tablePageHandler` as a recognised guard pattern (the same
    call `withCapabilityRequest` got), and `service.test.ts`'s two boundary assertions now accept
    `tablePageHandler` and `buildKeysetPage` as the mechanisms — the reasons are written at both
    sites. `buildKeysetPage` is the *stricter* form: it reads `app.organization_id` back out of the
    transaction, so the tenant id never passes through the function's signature to be got wrong.

- [x] **Keep the pure helpers honest**
  - Files: `src/lib/sprints/results.ts`, `tests/unit/**` (existing sprint-results tests)
  - Do: `sortSprintResults` and `filterSprintResults` leave the request path. Keep them and their
    tests where they still describe real behaviour (the worker, or client-side provisional
    ordering). Delete a test only with a written reason.
  - Verify: `pnpm test tests/unit` green; any deleted test is named in the commit message with its
    reason.
  - Done: **no test was deleted.** `sortSprintResults`, `filterSprintResults` and
    `computeLocationFacets` are untouched and still tested; they left the request path but the
    worker and the pure-model tests still describe real behaviour. `annotateTrackedResults` is still
    used by the route, on the page rather than on every row.

- [x] **Migrate the sprint results UI onto the shell**
  - Files: `src/routes/_dashboard/sprints/$sprintId/index.tsx`
  - Do: `validateSearch: tableSearchSchema`, a `ColumnDef[]` for the result row, `DataTable` with
    `rowTestId`. Delete the local `filter` state (`index.tsx:58`) and any local sort. **Do not
    touch `sprint.cursor`** — that is sourcing progress feeding a progress bar, not pagination.
  - Verify: `pnpm dev`, open a sprint with more than 50 results; scroll to page 2, sort by score,
    group by source, select rows, navigate by keyboard.
  - Done, and verified by hand in a browser against the worktree's isolated database.
    `sprint.cursor` is untouched and its comment now says which cursor it is.

    **`validateSearch` could not be `tableSearchSchema`.** TanStack Router re-serializes whatever
    `validateSearch` returns, so returning the parsed `TableSearch` put a JSON blob in the address
    bar where `?sort=score:desc&filter.source=github` belonged. The route returns the flat params
    (`pickTableSearchParams`) and the component parses them. Recorded in plan 02's freeze note.

    **Grouping was unusable until the server was fixed.** Grouping by `source` while sorting by
    `score` rendered **36 group headers for 50 rows** — the renderer starts a group wherever the
    value changes, and an unrelated sort interleaves them. Technically it obeyed "grouping never
    changes which rows a page contains"; practically it was noise. `planKeysetPage` now leads the
    `ORDER BY` with the group column when that column is sortable: 36 headers became 1. This does
    change which rows land on page one, and that is the point — a group split across five pages is
    not a group.

    Two behaviour changes worth naming rather than burying:
    - **The Locations sidebar is gone.** Its content is the `country` facet chips, which carry the
      same server counts and are clickable. The panel was a read-only copy of them.
    - **Multi-keyword OR search is not reproduced.** The AI refiner returns a keyword list; the
      contract carries one search term, and they are joined. Recorded in plan 02's freeze note.

    `minFollowers` survived as a surface-owned parameter with its own control, validated by the
    route with zod and reaching SQL as a bound parameter in a `scope` predicate. `TableQuery` models
    set membership, not ranges, and growing the shared contract a range operator for one table is
    how a contract ends up shaped by its first caller.

- [x] **Write the shared e2e spec every later migration reuses**
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
  - Done: **9 passed, 1 skipped, 25.1 s.** 500 seeded rows, the per-worker disposable database and
    Redis namespace. The skip is honest rather than a hole — sprint results does not enable
    selection, and the test says so instead of asserting nothing.

    Every listed property is covered except two, and both are named here rather than quietly
    dropped:
    - **Grouping** is asserted in the unit suite (`DataTable.test.tsx`, `useTableVirtual.test.tsx`)
      and by hand in the browser, not in this spec. Adding it is a small follow-up; it is listed so
      the gap is visible.
    - **All four states**: filtered-empty is asserted here; loading, blank and error are asserted in
      `DataTable.test.tsx`, because reproducing a server error in an e2e run means breaking the
      server on purpose.

    Later plans add an entry to `SURFACES` rather than writing a spec.

- [x] **Freeze the contract**
  - Files: `02-table-query-contract/spec.md`
  - Do: record that the contract is now proven against a real surface and is frozen for plans
    08–12. If this plan changed it, note what changed and why, so the next reader knows the
    fixture-era shape is gone.
  - Verify: `pnpm test`, `pnpm test:e2e`, `pnpm test:a11y`, `pnpm security:boundaries` all green.
  - Done: "Frozen after plan 07" in `02-table-query-contract/spec.md` lists the three changes the
    first caller forced and the two gaps left open deliberately.
