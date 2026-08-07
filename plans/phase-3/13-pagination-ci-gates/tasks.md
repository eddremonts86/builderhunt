# Tasks — make the bound permanent

> **Status**: `pending`
> **Depends on**: [`08-migrate-admin-surfaces`](../08-migrate-admin-surfaces/spec.md), [`09-migrate-platform-content`](../09-migrate-platform-content/spec.md), [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md), [`11-migrate-search`](../11-migrate-search/spec.md), [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md)
> **Blocks**: nothing
> **Reality check**: `scripts/check-route-coverage.mjs` is the wiring precedent in `scripts/ci/local-quality.sh` and `.github/workflows/quality.yml`.

- [ ] **Confirm the count is zero before switching the gate on**
  - Files: none
  - Do: `node scripts/check-unbounded-reads.mjs`. If it is not zero, stop — the remaining entries
    belong to plan 12, not here.
  - Verify: output is `{"unbounded":0,...}`.

- [ ] **Turn the detector into a failing gate**
  - Files: `scripts/check-unbounded-reads.mjs`, `package.json`,
    `scripts/ci/local-quality.sh`, `.github/workflows/quality.yml`
  - Do: exit non-zero when `unbounded > 0`. Wire beside the existing `security:route-coverage` step
    in both the local script and the workflow. Keep the `// unbounded-read-ok: <reason>` escape
    hatch so a legitimate exception is visible in review rather than invisible in the code.
  - Verify: `pnpm ci:local` green; add a deliberate unbounded read, confirm the build fails, remove
    it, confirm it passes.

- [ ] **Assert every default sort actually uses an index**
  - Files: `tests/e2e/data-tables.spec.ts`
  - Do: for each capability's `defaultSort`, run `EXPLAIN` against the seeded worker database and
    assert the plan contains an index scan and **no** `Sort` node above the limit. Plan 04's unit
    test proves an index was declared; only this proves the planner uses it — a `NULLS LAST`
    mismatch satisfies the first and fails this. Assert on plan shape, not exact text, so it does
    not break across Postgres versions. Exempt capabilities flagged non-SQL.
  - Verify: `pnpm test:e2e tests/e2e/data-tables.spec.ts` green; drop one of plan 04's indexes
    locally and confirm the assertion fails.

- [ ] **Register every data-grid and semantic table surface**
  - Files: `scripts/check-table-surfaces.mjs`, `package.json`,
    `scripts/ci/local-quality.sh`, `.github/workflows/quality.yml`
  - Do: inventory every `<table>` and every `DataTable` consumer. Data grids name a registered
    capability; exemptions carry a non-empty reason and are limited to semantic prose/email/chart/
    summary/third-party markup. Also reject offset/page-number pagination in BuilderHunt-owned SQL
    list routes while allowing bounded provider pages only inside the plan-11 search adapter and
    source connectors.
  - Verify: `pnpm check:table-surfaces` passes; an unregistered scratch grid fails; a provider-style
    page parameter in a SQL route fails; both pass again after scratch changes are removed.

- [ ] **Document the table system**
  - Files: `DESIGN.md`, `docs/visual-system.md`
  - Do: add the table section — row heights per density, numeric alignment via
    `font-variant-numeric: tabular-nums` and **not** `font-mono` (`DESIGN.md:221`), the two distinct
    empty states, and the ARIA-grid-instead-of-`<table>` decision with its rationale so it is not
    re-litigated per surface. Describe what shipped: `docs/visual-system.md` states the code wins
    when the two disagree.
  - Verify: the section names the real row-height values and the real role attributes used by
    `DataTable`.

- [ ] **Record the authorization surface and the how-to**
  - Files: `docs/architecture/data-classification.md`, `README.md`
  - Do: in `data-classification.md`, note that sortable and filterable column allowlists are an
    authorization surface, because they decide which columns a client can reach. In `README.md`, one
    line on adding a table: write a `ColumnDef[]` and a capability.
  - Verify: `pnpm ci:local` green; a reader can follow `README.md` plus one existing capability to
    add a table without reading any plan.
