# Tasks — make the bound permanent

> **Status**: `implemented`
> **Depends on**: [`08-migrate-admin-surfaces`](../08-migrate-admin-surfaces/spec.md), [`09-migrate-platform-content`](../09-migrate-platform-content/spec.md), [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md), [`11-migrate-search`](../11-migrate-search/spec.md), [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md)
> **Blocks**: nothing
> **Reality check**: `scripts/check-route-coverage.mjs` is the wiring precedent in `scripts/ci/local-quality.sh` and `.github/workflows/quality.yml`.

- [x] **Confirm the count is zero before switching the gate on**
  - Files: none
  - Do: `node scripts/check-unbounded-reads.mjs`. If it is not zero, stop — the remaining entries
    belong to plan 12, not here.
  - Verify: output is `{"unbounded":0,...}`.
  - **Done: `{"unbounded":0,"aggregates":21,"exempted":3}`.** Plan 12 took it from 93.

- [x] **Turn the detector into a failing gate**
  - Files: `scripts/check-unbounded-reads.mjs`, `package.json`,
    `scripts/ci/local-quality.sh`, `.github/workflows/quality.yml`
  - Do: exit non-zero when `unbounded > 0`. Wire beside the existing `security:route-coverage` step
    in both the local script and the workflow. Keep the `// unbounded-read-ok: <reason>` escape
    hatch so a legitimate exception is visible in review rather than invisible in the code.
  - Verify: `pnpm ci:local` green; add a deliberate unbounded read, confirm the build fails, remove
    it, confirm it passes.
  - **Done, and deliberately not "above a committed baseline".** The script's own old comment proposed
    one; a baseline is a number someone raises. Arriving at zero is what makes the next unbounded read
    a build failure rather than a slightly larger figure in a file nobody reads. The escape hatch stays
    per-read — `// unbounded-read-ok: <reason>` — which forces the reason into the diff instead of into
    a total. The failure message names the four mechanisms rather than just refusing.

- [x] **Assert every default sort actually uses an index**
  - Files: `tests/e2e/data-tables.spec.ts`
  - Do: for each capability's `defaultSort`, run `EXPLAIN` against the seeded worker database and
    assert the plan contains an index scan and **no** `Sort` node above the limit. Plan 04's unit
    test proves an index was declared; only this proves the planner uses it — a `NULLS LAST`
    mismatch satisfies the first and fails this. Assert on plan shape, not exact text, so it does
    not break across Postgres versions. Exempt capabilities flagged non-SQL.
  - Verify: `pnpm test:e2e tests/e2e/data-tables.spec.ts` green; drop one of plan 04's indexes
    locally and confirm the assertion fails.
  - **Done — 55 assertions, and it lives in a unit test rather than the e2e file this task names.**
    Two reasons, both about coverage. It sweeps `TABLE_CAPABILITIES`, so a capability whose surface no
    e2e spec happens to visit is still checked — the same argument the barrel exists for. And it runs
    in `pnpm test`, so it gates every run rather than only the e2e job.

    It closes **both** blind spots plan 04 recorded against itself: every sortable column is explained
    in *both* directions (the `nullsLast`-plus-`DESC` hole is invisible until a URL asks for it), and
    every `groupable` id is explained as the composite `resolveSort` actually produces.

    **Three planner settings, and two of them were learned from failures.** `enable_seqscan = off` is
    the obvious one. Without `enable_bitmapscan = off` the planner answered `alert_triggers` with a
    bitmap index scan plus a sort — cheaper on an empty table, and it turned the assertion into a
    statement about the cost model; a bitmap scan returns rows in heap order and can never supply an
    ordering. `enable_sort = off` makes the remaining question the right one: a plan that *still*
    sorts is one no index could have served.

    **The `Sort Key:` trap again.** The first assertion matched that substring, which `Incremental
    Sort` emits too, so it failed on plans that were correct. It matches the node line now.

    **And the finding worth keeping.** The first version had nineteen failures that were all its own:
    a capability describes its columns but not the *scope* its surface always applies. `sprint_results`
    is only ever read for one sprint, and the refund and dispute queues only for one organization —
    which is why those indexes lead with a column the capability never mentions. Explaining without
    that predicate explains a query the product never issues. The test carries a `REQUIRED_SCOPE`
    ledger, and a ledger drifts; plan 03's deferred `capability.scope` is the fix that deletes it.

- [x] **Register every data-grid and semantic table surface**
  - Files: `scripts/check-table-surfaces.mjs`, `package.json`,
    `scripts/ci/local-quality.sh`, `.github/workflows/quality.yml`
  - Do: inventory every `<table>` and every `DataTable` consumer. Data grids name a registered
    capability; exemptions carry a non-empty reason and are limited to semantic prose/email/chart/
    summary/third-party markup. Also reject offset/page-number pagination in BuilderHunt-owned SQL
    list routes while allowing bounded provider pages only inside the plan-11 search adapter and
    source connectors.
  - Verify: `pnpm check:table-surfaces` passes; an unregistered scratch grid fails; a provider-style
    page parameter in a SQL route fails; both pass again after scratch changes are removed.
  - **Done: 23 surfaces — 9 capability-backed, 9 bounded, 5 exempt.** All three negative cases were
    run and each failed for its own reason: a capability name that is not exported from the barrel, a
    `?page=` parameter in a route under `src/routes/api/`, and an unmarked `<table>`. Clean again after
    removal.

    **The task's two states were not enough, and the third is the honest one.** It says data grids name
    a capability and exemptions are "limited to semantic prose/email/chart/summary/third-party markup".
    Six surfaces are neither: the blog library reads the filesystem, the changelog is one row per
    release, a person's own sessions and consents are their own. `table-surface-bounded: <reason>` is
    what they carry — the claim being *there is no cursor because there is no second page*, which
    `check-unbounded-reads.mjs` is what keeps true. A capability for those would exist only to satisfy
    this script.

    **It also surfaced plan 08's open task, which is what a gate is for.** `integrations`, `metrics`
    and `operations` still render `<table>` markup rather than the shell. Their reads are bounded, so
    they carry `table-surface-bounded` with a pointer to plan 08 — because what is still outstanding
    there is UI consistency, not pagination correctness, and this gate is about the second.

- [x] **Document the table system**
  - Files: `DESIGN.md`, `docs/visual-system.md`
  - Do: add the table section — row heights per density, numeric alignment via
    `font-variant-numeric: tabular-nums` and **not** `font-mono` (`DESIGN.md:221`), the two distinct
    empty states, and the ARIA-grid-instead-of-`<table>` decision with its rationale so it is not
    re-litigated per surface. Describe what shipped: `docs/visual-system.md` states the code wins
    when the two disagree.
  - Verify: the section names the real row-height values and the real role attributes used by
    `DataTable`.
  - **Done.** `DESIGN.md` gets the decisions and their reasons — why row height is the table's concept
    and not the dashboard's, why numbers are `tabular-nums` and not `font-mono`, why there are two
    empty states rather than one, and why `role="grid"` over divs was worth owning the ARIA indices
    for. `docs/visual-system.md` gets the table of what actually shipped, with the file each value
    lives in, under its own "the code wins when the two disagree" rule.

- [x] **Record the authorization surface and the how-to**
  - Files: `docs/architecture/data-classification.md`, `README.md`
  - Do: in `data-classification.md`, note that sortable and filterable column allowlists are an
    authorization surface, because they decide which columns a client can reach. In `README.md`, one
    line on adding a table: write a `ColumnDef[]` and a capability.
  - Verify: `pnpm ci:local` green; a reader can follow `README.md` plus one existing capability to
    add a table without reading any plan.
  - **Done.** `data-classification.md` says why a capability is an authorization surface rather than a
    config file — there is no path from a request to an `ORDER BY` that does not go through `sortable`
    — and spells out the two consequences of adding an entry, including that `searchable` puts a
    column's contents behind a free-text box. `README.md` gets "Adding a table": two files, no
    pagination code, plus the two gate commands that will tell you what you forgot.
