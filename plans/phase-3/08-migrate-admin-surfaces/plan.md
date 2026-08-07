# Plan — migrate the admin and account surfaces

> **Status**: `implemented`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Seven UI files plus their capabilities. No new indexes expected; confirm per surface against plan 04's guard.

## Sequence

One surface per commit, hardest first within the group: `AbuseConsole` (a real `<table>` with the
most columns), then `admin/incidents` and `admin/plan-requests` (which have row actions and
selection), then the four small ones.

Hardest first, because if the shell cannot express `AbuseConsole` the group should stop and fix the
shell rather than migrate four easy surfaces and discover it on the fifth.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The shell needs a new slot for row actions or confirmations | Medium | Low — an additive shell change | Slots are the designed extension point; adding one is expected, adding an `if (table === …)` is not |
| A surface's existing e2e coverage breaks on changed markup | Medium | Medium | `rowTestId` preserves ids; run each surface's own spec per commit rather than once at the end |
| Migrating `HygieneCard` because it contains `<table>` | Medium | Low — wasted work on a summary card | Audited explicitly and recorded as out of scope if it is not a grid |
| A "small" list turns out to be unbounded | Low | Medium | The detector's count is checked after each commit and must not increase |

## Rollback

One commit per surface, so a regression reverts alone without touching the shell or the other six.
