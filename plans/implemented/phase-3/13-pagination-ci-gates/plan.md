# Plan — make the bound permanent

> **Status**: `implemented`
> **Depends on**: [`08-migrate-admin-surfaces`](../08-migrate-admin-surfaces/spec.md), [`09-migrate-platform-content`](../09-migrate-platform-content/spec.md), [`10-migrate-tenant-surfaces`](../10-migrate-tenant-surfaces/spec.md), [`11-migrate-search`](../11-migrate-search/spec.md), [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md)
> **Blocks**: nothing
> **Reality check**: One script flag, one e2e assertion, four documentation files. No `src/` behaviour changes.

## Sequence

1. **Confirm the detector reports zero** before flipping it. A gate switched on against a non-zero
   count is a red build people learn to ignore.
2. **Flip it and wire it** into `pnpm ci:local` and `.github/workflows/quality.yml`, beside the
   existing `security:route-coverage` step.
3. **Add the `EXPLAIN` assertion**, which needs the seeded e2e database.
4. **Add the table-surface inventory gate**, classifying every current raw `<table>` use and every
   migrated `DataTable` consumer.
5. **Documentation last**, describing what shipped rather than what was planned —
   `docs/visual-system.md` states that the code wins when the two disagree.

## Prove each gate can fail

A gate never seen red is a gate nobody trusts. Each of the three is deliberately tripped once —
an unbounded read added and removed, a sortable column without an index, an unregistered data grid —
and the failure is confirmed before the plan closes.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The gate is switched on while entries remain and becomes noise people bypass | Medium | Medium — a gate that is ignored is worse than none | Step 1 is a hard precondition: the detector must report zero first |
| The detector's heuristic blocks a legitimate PR | Medium | Low | The `unbounded-read-ok: <reason>` comment unblocks immediately; plan 01's blind-spot list is where to look |
| `EXPLAIN` assertions are brittle across Postgres versions | Medium | Medium — a flaky gate | Assert on the presence of an index scan and the absence of a sort node, never on exact plan text |
| Documentation drifts from what shipped | High over time | Low | `docs/visual-system.md` already establishes that the code is the source of truth; the table section describes the shipped behaviour |

## Rollback

The gates are a script flag and workflow wiring. Reverting the workflow lines unblocks CI while an
offending read is fixed properly; the documentation is additive.
