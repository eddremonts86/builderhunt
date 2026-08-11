# Implemented plans

Every plan in this directory is **done and tested**. That is the only thing this folder means, and it
means exactly that — nothing here is aspirational, in progress, or "code-complete pending a review".

Moved here on 2026-08-11: **47 plans**.

## What a plan had to satisfy to be in here

Three conditions, all checked mechanically rather than judged:

1. **Zero open and zero partial tasks.** `- [ ]` and `- [~]` both count as not done. The partial
   marker is the one that hides: every status report in this repository greps for `- [ ]` alone, and
   nine real tasks were once invisible for exactly that reason.
2. **`> **Status**: `implemented`` in all three of `spec.md`, `plan.md` and `tasks.md`.** Twenty plans
   had `tasks.md` saying `implemented` while `spec.md` and `plan.md` still said `pending` — a folder
   built on one file would have inherited that.
3. **`pnpm ci:local` green.** 34/34 steps, 6,543 unit tests and 996 e2e tests, on commit `90527722e`.

Each plan's `tasks.md` carries a dated **Status reconciliation** note saying what its status was before
and why it changed, so the claim is auditable rather than asserted.

## What is deliberately *not* in here

Twelve plans stayed in `plans/phase-1/`, and the reason differs by plan:

| Plan | Status | Why it stayed |
|---|---|---|
| `55-load-1000-concurrent-users` | `pending` | 5 open + 2 partial — the cost-bearing certification runs |
| `57-ui-dashboard` | `pending` | 17 open + 9 partial |
| `59-personalized-invitations` | `pending` | 1 partial — a human still has to look at the screenshots |
| `07-responsive-mobile-design` | `partially-implemented` | sprint wizard steps 2-3 need a live check |
| `49-audit-performance-qa` | `partially-implemented` | Lighthouse and CI-gate tasks never attempted |
| `51-audit-conversion` | `partially-implemented` | baseline collection and staged rollout not started |
| `11-sourcehut-integration` | `retired` | not built, by decision |
| `16-hashnode-integration` | `retired` | not built, by decision |
| `20-indiehackers-integration` | `closed — skipped` | not built, by decision |
| `31-pricing-and-billing` | `superseded` | replaced by `30-stripe-billing-platform` |
| `39-technical-sandbox` | `superseded` | replaced elsewhere |
| `54-waitlist-launch` | `blocked` | its own tasks are done; the launch is phase-5 work |

The last six are not implemented and never will be under these numbers, which is why they are not in
here. They are also not *pending* — filing them with live work is the second-best option, and one worth
revisiting.

Three of those statuses — `retired` twice and `closed — skipped` once — are values
`scripts/check-phase-readiness.mjs` cannot read. It allows exactly `pending`,
`partially-implemented`, `implemented`, `blocked` and `superseded`. Choosing between `superseded` and
widening that set is a product decision, so those three were left as they are.

## The numbers did not move

A plan's two-digit prefix is its position in the canonical build order recorded in
[`../_meta/phase-1-order.md`](../_meta/phase-1-order.md), and that order is a property of the work
rather than of where the file is filed. So `01-security-and-multitenancy` is still `01` in here, and
`plans/phase-1/` still holds `07`, `11`, `16`, `20`, `31`, `39`, `49`, `51`, `54`, `55`, `57` and `59`.

`scripts/check-plan-order.mjs` therefore reads the **union** of the two directories. Left pointed at
`plans/phase-1/` alone it would have passed vacuously — twelve directories asked to be numbered 01-12,
and every dependency on a moved plan resolving to "not a plan directory". It now reports
`OK: 59 plans numbered 01-59, every dependency points backward`, which is the same guarantee as before
the split.

## Moving a plan in here

1. Close every task, including `- [~]` ones.
2. Set `> **Status**: `implemented`` in all three files, and add a dated note saying what changed.
3. Run `pnpm ci:local` and record the step count in the note.
4. `git mv plans/phase-1/NN-name plans/implemented/NN-name`.
5. Fix the links: a moved plan's siblings resolve as `../NN-name/`, but anything still in
   `plans/phase-1/` becomes `../../phase-1/NN-name/`, and references from outside `plans/` change from
   `plans/phase-1/NN-name` to `plans/implemented/NN-name`. The move on 2026-08-11 rewrote 370 relative
   links and 252 full-path references across 170 files; it also fixed 20 depth bugs that predated it,
   taking the repository from 37 broken relative links inside `plans/` down to 2 — both of which are the
   `../other-plan/spec.md` placeholder in `_meta/conventions.md`, which is illustrative prose.
6. Run `node scripts/check-plan-order.mjs`.
