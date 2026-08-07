# Plan — migrate the admin and account surfaces

> **Status**: `implemented`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Nine UI surfaces plus their capabilities. `/admin/plan-requests` is deleted;
> integrations, metrics, and operations are the live replacements in this inventory. Confirm indexes
> and read bounds per surface against plans 01 and 04.

## Sequence

One surface per commit, hardest first within the group: `AbuseConsole`, integrations, metrics and
operations (the real `<table>` users), then incidents, then the four small account surfaces.

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
