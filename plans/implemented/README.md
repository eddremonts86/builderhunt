# Implemented plans

Every plan in this directory is **done and tested**. That is the only thing this folder means, and it
means exactly that — nothing here is aspirational, in progress, or "code-complete pending a review".

Moved here on 2026-08-11: **48 plans** (47 in the first pass, plus `59-personalized-invitations` once
its closing evidence was written).

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

Eleven plans stayed in `plans/phase-1/`, and the reason differs by plan:

| Plan | Status | Why it stayed |
|---|---|---|
| `55-load-1000-concurrent-users` | `pending` | 5 open + 2 partial — the cost-bearing certification runs |
| `57-ui-dashboard` | `pending` | 17 open + 9 partial |
| `07-responsive-mobile-design` | `partially-implemented` | sprint wizard steps 2-3 need a live check |
| `49-audit-performance-qa` | `partially-implemented` | Lighthouse and CI-gate tasks never attempted |
| `51-audit-conversion` | `partially-implemented` | baseline collection and staged rollout not started |
| `11-sourcehut-integration` | `superseded` | retired 2026-08-04, not built |
| `16-hashnode-integration` | `superseded` | retired 2026-08-04, not built |
| `20-indiehackers-integration` | `superseded` | closed and skipped, not built |
| `31-pricing-and-billing` | `superseded` | replaced by `30-stripe-billing-platform` |
| `39-technical-sandbox` | `superseded` | replaced elsewhere |
| `54-waitlist-launch` | `blocked` | its own tasks are done; the launch is phase-5 work |

The last six are not implemented and never will be under these numbers, which is why they are not in
here. They are also not *pending* — filing them with live work is the second-best option, and one worth
revisiting.

Three of them — `11`, `16` and `20` — used to say `retired` and `closed — skipped`, values `scripts/check-phase-readiness.mjs`
cannot read — it allows exactly `pending`, `partially-implemented`, `implemented`, `blocked` and
`superseded`. They now say `superseded` with the original word kept beside it as prose, because
"retired" and "superseded" are not the same story and the distinction was worth keeping. Every status
across both directories is now a value the gate can read.

## The numbers did not move

A plan's two-digit prefix is its position in the canonical build order recorded in
[`../_meta/phase-1-order.md`](../_meta/phase-1-order.md), and that order is a property of the work
rather than of where the file is filed. So `01-security-and-multitenancy` is still `01` in here, and
`plans/phase-1/` still holds `07`, `11`, `16`, `20`, `31`, `39`, `49`, `51`, `54`, `55` and `57`.

`scripts/check-plan-order.mjs` therefore reads the **union** of the two directories. Left pointed at
`plans/phase-1/` alone it would have passed vacuously — eleven directories asked to be numbered 01-11,
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
6. Run `pnpm plans:check-order` and `pnpm plans:check-implemented`.

## What keeps this folder honest

`pnpm plans:check-implemented` runs in `pnpm ci:local` and in CI's Quality job, and it asserts the two
claims this file makes — plus one more that is easy to forget:

1. Everything in here has zero open *and* zero partial tasks, and says `implemented` in every file that
   carries a Status header.
2. Nothing in `plans/phase-1/` has zero open tasks and `implemented` everywhere. A folder that
   *understates* what is done is as unusable as one that overstates it, because a reader then has to
   check both directories anyway.
3. No `- [x]` contradicts itself. A checked task whose own text says "not implemented", "not attempted",
   "skipped" or "deferred" must name the plan that owns the work now, and only a `plans/phase-5/` link
   counts. This is the rule the others could not see: on 2026-08-11 four checked tasks said the opposite
   of their own marker while every mechanical condition passed. Three were already built with stale
   titles; the fourth had genuinely moved to phase 5.
4. Every Status in either directory is one of the five values `check-phase-readiness.mjs` accepts. Eight
   unreadable values drifted across phase-1 for weeks because nothing looked.

Every rule was verified against deliberate breakage rather than assumed: a partial task inside the
folder, a `pending` status inside it, an invented status value, a finished plan left outside, and a
checked task admitting a gap both with and without a pointer. Each fails, and the last one passes once
the pointer is there.

`pnpm plans:check-order` runs beside it, and guards that a two-digit prefix is still a position in a
contiguous build order across both directories.

### Why the readiness gate is *not* pointed at this folder

`check-phase-readiness.mjs` asks "is this plan ready to be executed?" — no reserved migration numbers,
no placeholders, an exact three-file set. Those rules are about work that has not happened yet. Run over
these 48 plans it reports 52 failures, and 22 of them are task texts naming the migration the plan
*actually created*. Satisfying those would mean rewriting the record of what happened to please a
forward-looking lint. The position-contiguity half of that gate *was* fixed to read both directories,
because that part is about order rather than readiness.
