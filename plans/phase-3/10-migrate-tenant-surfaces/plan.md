# Plan — migrate the tenant and billing surfaces

> **Status**: `implemented`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`11-migrate-search`](../11-migrate-search/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Six surfaces plus their repository reads. Admin users, refunds and disputes
> are platform-scoped; team, sprints and alerts are tenant-scoped. The scope adapters from plan 03
> are mandatory, and plan 04's guard identifies any missing sort index.

## Sequence

1. **`admin/users` first.** It has the worst read (`listPlatformUsersWithPlans`, unbounded), the
   client-side filter, and the inline edit row. If the `expansion` slot cannot carry that form, the
   shell needs work before five more surfaces depend on it.
2. **The two billing queues**, which share a shape.
3. **Team settings, sprints index, alerts** — alerts last because it brings grouping and is the
   broadest tenant surface in this set.

Worst first again. The inline edit row is the single most likely thing to expose a shell
assumption, and it is cheaper to find that with one surface migrated than six.

## Index dependency

Server-side sorting by name, email, status or last-run may need indexes that plan 04 did not add,
because plan 04 only covered capabilities that existed then. Each surface here declares its
`sortable` set and plan 04's guard test will fail if an index is missing — treat that failure as
the signal to add the index in this plan, not as a reason to drop the sort.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| The `expansion` slot cannot carry the inline edit form | Medium | Medium — a shell change mid-group | Sequenced first; if the slot is wrong, fix the slot before migrating the other five |
| A billing queue regresses and a refund or dispute is mishandled | Low | **High** — real money | These surfaces keep their existing regression coverage; run the billing specs per commit; no change to decision logic, only to how rows are listed |
| A new sortable column has no index and ships a table scan | Medium | Medium | Plan 04's guard fails the build; the index is added here rather than the sort silently dropped |
| Deleting the unbounded `listPlatformUsersWithPlans` breaks another caller | Medium | Medium | `grep -rn 'listPlatformUsersWithPlans' src` before deleting; migrate or bound every caller found |
| Alerts' `groupByAlert` behaviour changes when grouping moves server-side | Medium | Medium | Compare group counts before and after on the same data; the server aggregate counts the whole group, which is a fix, not a regression — verify it reads as intended |

## Rollback

One commit per surface. The billing queues are the highest-stakes reverts and are independent of
each other and of the rest.
