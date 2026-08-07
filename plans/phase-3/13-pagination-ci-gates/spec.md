# Specification — make the bound permanent

> **Status**: `pending`
> **Depends on**: [`08-migrate-admin-surfaces`](../08-migrate-admin-surfaces/spec.md), [`09-migrate-platform-content`](../09-migrate-platform-content/spec.md), [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md), [`11-migrate-search`](../11-migrate-search/spec.md), [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md)
> **Blocks**: nothing
> **Reality check**: `scripts/check-unbounded-reads.mjs` exists in report-only mode from plan 01. `scripts/check-route-coverage.mjs` and `scripts/check-tenant-boundaries.mjs` are already wired into `pnpm ci:local` and `.github/workflows/quality.yml` — this plan follows them. `docs/visual-system.md` documents the token contract and explicitly lists its own known gaps.

## Problem

Twelve plans of work decay the moment someone adds an unbounded read, a sortable column with no
index, or a nineteenth table that reinvents a header. The work is only finished when the repository
defends it.

## Goal

Three gates and the documentation that explains them, so the next contributor is stopped by a
failing build rather than a code review.

## The gates

**1. No unbounded read.** Flip `scripts/check-unbounded-reads.mjs` to exit non-zero when
`unbounded > 0`. A new list read must declare page, model-bounded or batch — or carry an
`// unbounded-read-ok: <reason>` comment, which makes the exception visible in review instead of
invisible in the code.

This can only be switched on once plan 12 reports zero. Turning it on earlier means a red build
that everyone learns to ignore, which is worse than no gate.

**2. Every sort uses an index.** For each capability's `defaultSort`, run `EXPLAIN` against the
seeded e2e database and assert the plan contains an index scan and no `Sort` node above the limit.
Plan 04's unit test proves an index was *declared*; only `EXPLAIN` proves the planner *uses* it —
a `NULLS LAST` mismatch satisfies the first and fails the second.

**3. Every data-grid surface is registered.** `scripts/check-table-surfaces.mjs` owns an explicit
inventory of data grids and semantic non-grid `<table>` uses. A data grid must name its capability
and `DataTable` consumer; a semantic exemption must name why it is not an interactive row collection
(pricing/cookies prose, email markup, chart geometry, summary cards, third-party calendar markup).
Raw grep is evidence for updating the inventory, not the gate itself.

## Documentation

- `DESIGN.md` and `docs/visual-system.md`: the table section — row heights per density, numeric
  alignment via `font-variant-numeric: tabular-nums` and **not** `font-mono` (`DESIGN.md:221`), the
  two distinct empty states, and the ARIA-grid-instead-of-`<table>` decision with its rationale, so
  it is not re-litigated per surface.
- `docs/architecture/data-classification.md`: a note that sortable and filterable column allowlists
  are an authorization surface, since they decide which columns a client can reach.
- `README.md`: one line on how to add a table — write a `ColumnDef[]` and a capability.

`docs/visual-system.md` states that the code is the source of truth when the two disagree, so the
table section describes what shipped, not what was planned.

## Success metrics

- `pnpm ci:local` green with all three gates active.
- Adding a deliberate unbounded read fails the build; removing it passes.
- Adding a sortable column with no index fails plan 04's unit test **and** the `EXPLAIN` assertion.
- SQL-owned list routes contain no offset/page-number pagination; provider-backed connectors may
  retain bounded upstream page parameters only behind plan 11's signed continuation adapter.
- A new contributor can add a table by reading `README.md` and one existing capability.

## Resolved edge cases

- **A legitimate complete-set read added later.** Prefer an explicit model bound or batch loop. The
  `unbounded-read-ok` comment is reserved for cases that truly cannot be bounded and must name the
  reviewed maximum/cardinality reason; it is not a generic escape hatch.
- **`EXPLAIN` output differing between Postgres versions.** Assert on the presence of an index scan
  and the absence of a sort node, not on exact plan text.
- **A capability with no `defaultSort` reachable in e2e** (the file-backed blog). Exempt via the
  same declared non-SQL flag plan 09 introduced.
- **The gate blocking an unrelated PR because the detector misfires.** Plan 01's blind-spot list is
  the first place to look, and the comment escape hatch unblocks immediately while the heuristic is
  fixed.
