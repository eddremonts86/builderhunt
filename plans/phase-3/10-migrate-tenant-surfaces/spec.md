# Specification — migrate the tenant and billing surfaces

> **Status**: `implemented`
> **Depends on**: [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Blocks**: [`11-migrate-search`](../11-migrate-search/spec.md), [`13-pagination-ci-gates`](../13-pagination-ci-gates/spec.md)
> **Reality check**: Six surfaces, each needing a new bounded read. The route
> `src/routes/_dashboard/admin/users.tsx` renders `src/modules/admin/users/AdminUsersPage.tsx`,
> where filtering is client-side over `listPlatformUsersWithPlans()`, which returns every user.
> Refunds, disputes, team settings, sprints and alerts also read their full sets.

## Problem

This is the group where the read paths are genuinely wrong, not merely inconsistent.
`listPlatformUsersWithPlans` is unbounded by name and by design, and the admin users page then
filters the result in the browser with `String.includes`. It works because the user count is small.

## Goal

Six surfaces on the shell with real keyset pagination behind each, and the unbounded reads deleted
rather than wrapped.

## Non-goals

- **Changing what any queue does.** A refund decision, a dispute record, an alert edit — same
  behaviour, same permissions.
- **Redesigning the organization-id entry** on the billing queues. It stays a filter input; making
  it a proper picker is a separate concern.
- **Search.** Plan 11, which depends on this one because it reuses the same patterns.

## Per-surface work

| Surface | Server work |
|---|---|
| `admin/users` | Delete `listPlatformUsersWithPlans`'s unbounded form. New platform-scoped capability with server-side search over name and email, replacing the client filter in `AdminUsersPage.tsx`. |
| `RefundQueue` | `listBillingRefunds` gains a cursor. The organization id becomes a filter dimension rather than a precondition for reading everything. |
| `DisputeQueue` | Same shape as refunds, over `listDisputes`. |
| `TeamSettingsPage` | `listOrganizationMembers` and `listPendingInvitations` gain cursors. Two grids, not one merged list. |
| `sprints/index` | `listSprints` gains a cursor; sortable by last-run and status. |
| `alerts` | `listOrganizationAlerts` gains a cursor. The existing `groupByAlert` helper (`alerts.tsx:100`) becomes the shell's grouping. |

## The inline edit row

`admin/users.tsx` edits a user's plan inline, swapping the row for a form. That moves into the
shell's `expansion` slot keyed by row id. The shell owns nothing about the form — the plan select,
the end date, the reason field and the PATCH stay in the surface.

This is the test of whether the `expansion` slot is a real extension point or a shell feature in
disguise.

## Success metrics

- `grep -rn 'listPlatformUsersWithPlans' src` shows no unbounded form remaining.
- `users.tsx` contains no client-side `.filter(` over the row set.
- `node scripts/check-unbounded-reads.mjs` count drops by at least six.
- All six in the shared e2e parameter list and passing.
- Billing regression coverage green — these surfaces move money, so a broken queue is not a
  cosmetic bug.

## Resolved edge cases

- **Searching users by email across pages.** Server-side `ILIKE` over the capability's `searchable`
  columns, so it searches all users rather than the loaded 50.
- **An organization with three members.** Page one is the last page.
- **A refund queue with a typed organization id and no results.** The filtered-empty state, naming
  the organization filter — distinct from "this organization has no refunds ever".
- **Alerts grouping.** The shell's group rows replace `groupByAlert`; the aggregate comes from the
  server so it counts the whole group, not the loaded part.
