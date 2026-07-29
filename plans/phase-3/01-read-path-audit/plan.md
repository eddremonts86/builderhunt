# Plan — read-path audit and unbounded-read detector

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: [`12-bounded-reads-sweep`](../12-bounded-reads-sweep/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: New script only (`scripts/check-unbounded-reads.mjs`). No `src/` file changes.

## Sequence

1. **Write the detector against the known survey result.** The survey's 50/13/11 split is the
   fixture: a detector that reports wildly different numbers is wrong, and one that reports the
   same numbers has been validated against a hand-checked baseline.
2. **Walk the output and classify each entry.** This is reading code, not writing it. The output
   is the table in `tasks.md`.
3. **Wire it as a reportable script**, not a gate.

Doing it in this order means the classification is produced *from* the detector's output, so the
two cannot disagree — which is the property plan 13 relies on when it turns the script red.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The heuristic misses a read shape (raw `sql` template, a helper that wraps `select`) | Medium | Medium — a real unbounded read survives the phase | Cross-check the count against `grep -c '\.select(' src -r`; record known blind spots in the spec rather than pretending coverage is total |
| A read is classified `page` when it must cover every row | Medium | High — plan 12 would introduce a data bug (partial deletion, incomplete export) | Every `batch` and `page` decision names the caller that consumes it; deletion and export paths are reviewed explicitly, not by name pattern |
| The classification goes stale before plan 12 runs | Low | Low | The detector is the source of truth; the table is a snapshot with a date, and plan 12 re-runs the script first |

## Rollback

One new untracked script and one plan file. Deleting the script is the rollback; nothing imports
it and no runtime path changes.
