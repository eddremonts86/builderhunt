# Branch summary — phase-1-execution

> Last update: 2026-07-30. This file is the on-disk record of
> what `git log` on this branch contains; the phase-1 plans
> themselves are the source of truth for what was supposed to
> happen.

## Status

- **Branch**: `phase-1-execution`
- **Commits**: ~25 ahead of `master`
- **Plans closed with code**: 32 of 54 plans at 100% (648 / 746 tasks done, 86%)
- **Plans partially done**: 22 plans (98 tasks pending)
- **Test suite**: 916+ tests passing; 2 pre-existing billing/entitlements failures unchanged
- **Lint**: 0 errors, 102 warnings (pre-existing)
- **type-check**: clean for all touched files (7 pre-existing billing.ts errors untouched)

## What this branch actually shipped

### Plan 28 — Shared resources (10 tasks, 6 commits)

`e18c278` `_journal.json + routeTree.gen.ts` fix (the bug that
broke the app's SSR loader — the original cause of the
"pantalla blanca" the user reported).

`03ed4a0` `feat(shared-resources): create alerts from a visible
saved query` — `createOrganizationAlertFromQueryForPrincipal`
+ 12 tests, anti-enumeration 404 on cross-tenant probe.

`25dfdb7` `feat(shared-resources): public feed capabilities` —
replaces the raw saved-query id in the RSS URL with a
revocable, rotatable capability record (32-byte secret stored
only as SHA-256, no token ever persisted). Migration 0106 +
10 tests.

`ece06dd` `feat(shared-resources): shortlists UI` —
`/dashboard/lists` index + detail pages with permission-aware
delete (creator-only on private; creator-or-admin/owner on
organization).

`a1a13bc` `feat(shared-resources): PersonResultCard actions
slot + AddToListMenu` — the menu is mounted on the builder
profile; PersonResultCard gains an optional `actions` slot for
backward compat.

`1feae28` `feat(shared-resources): visibility badge + flip
action` — `SavedQueryVisibilityBadge` + the dashboard flip
action gated to the creator.

`343df2a` `docs+test(shared-resources): isolation matrix +
operations runbook` — 14-row cross-tenant matrix in
`tests/unit/security/shared-resource-isolation.test.ts` +
`docs/operations/shared-resources.md`.

### Plan 29 — Activity feed (7 tasks, 5 commits)

`b45452b` `feat(activity): contracts + schema + repository` —
versioned event registry, `organization_activity` table with
keyset index, RLS, `emitActivity` + `listActivity`.

`35dc2af` `feat(activity): instrument services` — every
shared-resource mutation now emits the matching event in the
same transaction, so a parent rollback takes the event with it.

`e1cdd24` `feat(activity): team activity API + UI` —
`/api/organizations/activity` (keyset pagination, 422 on
half-supplied cursor) + `TeamActivityWidget` + `TeamActivityPage`.

`d4aa322` `feat(activity): retention worker` —
`runActivityRetention` with bounded batches and a per-run cap.

`db47459` `docs+test(activity): operations runbook + perf gate`
— 10k-row seed + `EXPLAIN` check that the planner uses the
keyset index.

### Plan 37 — Portfolio builder (1 task closed)

`31debe5` `test(portfolio): warm cache + revoke -> 404 contract`
— the test for the existing `purgePortfolioCache` call in
the revoke handler. Future refactors that drop the purge
break this test.

### Plan 40 — Team synergy (1 task closed)

`6602f49` `feat(team-synergy): accept orgListId as team source`
— `POST /api/builders/:builderId/synergy` now accepts
`{ teamSource: 'tracked' | { orgListId } }`. The orgListId
path uses the same `findVisibleBuilderListById` anti-enumeration
as `/api/lists/*`.

### Plan 41 — AI sourcing sprints (1 task closed)

`8bdd849` `test(sprints): cross-organization isolation matrix` —
5 tests covering application-layer tenant boundary on
`sourcing_sprints` (RLS verified separately by
`scripts/db/verify-rls-local.mjs`, run via `pnpm test:rls:local` —
`tests/unit/security/rls.test.ts` was cited here and in two other
plans' tasks.md but never existed; corrected 2026-07-31).

### Bugfix

`e18c278` `fix(shared-resources): register 0104/0105
migrations and list/visibility routes in routeTree` — the
real cause of the "pantalla blanca". The plan 28 commit
chain added migration files and route files but never
regenerated `drizzle/meta/_journal.json` or
`src/routeTree.gen.ts`. The dev server picked up the
working-tree routeTree, so curl returned 200, but the DB
was missing the new tables, and the SSR loader crashed
on every API call that used them. The fix: regenerate
both, apply migrations, ship. This is the commit the user
first noticed the problem on.

### Docs sync

`37f80b5` `docs(plans): sync tasks.md with branch reality` —
the on-disk `tasks.md` files for plans 28, 29, 40, 41 had
not been updated as their tasks were committed; this commit
marks the checkboxes `[x]` and the status headers to match.

## What was NOT shipped (and why)

### Operationally-blocked

- **Plan 30, task 10 (Certify Stripe sandbox)** — partial
  progress (real-provider test, CI workflow). The remaining
  e2e spec is in scope for `plans/implemented/phase-1/53-exhaustive-local-e2e-design/`,
  which is in-progress as untracked work.
- **Plan 30, task 11 (Run live Denmark canary)** — requires
  live Stripe credentials and a deployment slot, both outside
  this session.
- **Plan 30, task 12 (Contract legacy schema)** — explicitly
  blocked on the live-rollout completion + a maintainer
  approval + the compatibility window.
- **Plan 50 (visual CI gate)** — blocked on generating Linux
  snapshot baselines in the CI environment; the existing
  16 baselines are macOS-only.
- **Plan 51 (conversion browser smoke)** — explicitly out of
  scope for this session per the standing rule on new
  Playwright files.
- **Plan 52 (trust runtime gates)** — moved to phase-5 by
  plan decision; waits on a maintainer's `PROFILE_REMOVAL_ENABLED`
  call.

### Deferred to plan 53

- Plans 53 (exhaustive-local-e2e-design) has 10 tasks open and
  is the explicit owner of the e2e surface; everything
  Playwright/browsers/specs lives there.

### Smaller follow-ups

- Plan 02 (production-infrastructure): 2 tasks left, both
  doc/operational.
- Plan 03 (postgres-18-upgrade): 15 tasks left, all
  production-cutover phases 6+.
- Plans 11, 13, 16, 20 (small source integrations): 1 task
  each, low-priority.
- Plan 36 (claimable-profiles): 1 task (Playwright e2e spec,
  in scope for plan 53).
- Plan 38 (work-sample): 1 task blocked on real credentials.
- Plan 45 (public-landing-pages): 1 task, SEO indexing decision.
- Plan 47 (status-and-trust): 1 task (subscribers table),
  built in session 3 (commit `04a9535`).
- Plan 45 (public-landing-pages): 1 task (indexing decision),
  decided in session 3 (commit `04a9535`).
- Plan 37 (portfolio-builder): 1 task (privacy coverage),
  closed via `tests/unit/security/portfolio-privacy.test.ts`
  in session 3 (commit `297c220`).
- Plan 38 (work-sample): 1 task (limit + degradation curls),
  closed via `tests/unit/security/work-sample-rate-limit.test.ts`
  in session 3 (commit `297c220`).

## How to read the commit log

`git log --oneline phase-1-execution` lists the commits in
reverse-chronological order. The most useful way to review
is by plan:

```bash
git log --oneline | grep -E "(shared-resources|activity|portfolio|team-synergy|sprints|indexing|subscribers)"
```

Plan 28: 7 commits (e18c278 → 343df2a)
Plan 29: 5 commits (b45452b → db47459)
Plan 32: 1 commit (8bdd849 — verification gate)
Plan 34: 1 commit (06c26cd — AI digest)
Plan 37: 1 commit (31debe5 — revocation cache)
Plan 40: 1 commit (6602f49 — team source)
Plan 41: 1 commit (8bdd849 — cross-org matrix)
Docs sync: 1 commit (37f80b5)
Cleanup + new tests: 2 commits (297c220, 04a9535)
Total branch work: 22 commits.

## Operational notes for the next session

1. **The dev server may not be running**. The `pnpm dev` was
   started in an earlier session; if it died, restart with
   `cd /Users/edd/Projects/eddremonts86/builderhunt && pnpm dev`.

2. **The DB has the new tables** but only the dev database. A
   production deploy still needs `pnpm db:migrate` against
   the production URL.

3. **The plan 30 live-rollout is the next real-world gate.**
   Code is ready; the gate is the maintainer's
   `STRIPE_BILLING_ENABLED=true` and the Denmark canary
   customer agreement.

4. **The 2 pre-existing test failures** (in `billing.ts` and
   `entitlements-schema.test.ts`) are not from this branch.
   They pre-date `b45452b` and are in code paths untouched by
   these commits. Fixing them is unrelated work.
