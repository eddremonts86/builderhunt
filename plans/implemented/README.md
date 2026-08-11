# Implemented plans

Every plan in this directory is **done and tested**. That is the only thing this folder means, and it
means exactly that — nothing here is aspirational, in progress, or "code-complete pending a review".

Split by phase, because plan numbers are unique only *within* a phase — phase 3 is numbered 01-13 and
twelve of those collide with phase 1's, so a flat archive could hold one phase and no more.

| | Plans | What it holds |
|---|---|---|
| `phase-1/` | 52 | every finished phase-1 plan, numbered 01-59 with gaps where a live plan still sits |
| `phase-3/` | 13 | all of phase 3 — the phase is complete |

Seven plans remain in `plans/phase-1/`: two with real open work (`55` waiting on cost-bearing
certification runs, `57` out of scope by decision) and five `superseded` ones that were never built.

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

| Plan | Status | Why it stayed |
|---|---|---|
| `55-load-1000-concurrent-users` | `pending` | 5 open + 2 partial — the cost-bearing certification runs |
| `57-ui-dashboard` | `pending` | 17 open + 9 partial |
| `11-sourcehut-integration` | `superseded` | retired 2026-08-04, not built |
| `16-hashnode-integration` | `superseded` | retired 2026-08-04, not built |
| `20-indiehackers-integration` | `superseded` | closed and skipped, not built |
| `31-pricing-and-billing` | `superseded` | replaced by `30-stripe-billing-platform` |
| `39-technical-sandbox` | `superseded` | replaced elsewhere |

The five `superseded` plans have no open tasks either, which is exactly why the move rule cannot be "zero
open tasks" alone: they were never built, and filing them as implemented would be the opposite of the
point. They are also not *pending*, so sitting beside live work is the second-best answer and one worth
revisiting.

`54-waitlist-launch` used to be on this list as `blocked`. It is now archived: all four of its own tasks
were done and its five remaining items moved to `plans/phase-5/` on 2026-08-05 — the same state as
`03`, `42`, `43`, `44` and `46`, every one of which said `implemented` and was archived. Treating it
differently was an inconsistency, not a distinction anybody had drawn.

## The numbers did not move

A plan's two-digit prefix is its position in the canonical build order recorded in
[`../_meta/phase-1-order.md`](../_meta/phase-1-order.md), and that order is a property of the work
rather than of where the file is filed. So `01-security-and-multitenancy` is still `01` in here, and
`plans/phase-1/` still holds `11`, `16`, `20`, `31`, `39`, `55` and `57`.

`scripts/check-plan-order.mjs` therefore reads the **union** of the two directories. Left pointed at
`plans/phase-1/` alone it would have passed vacuously — seven directories asked to be numbered 01-07,
and every dependency on a moved plan resolving to "not a plan directory". It now reports
`OK: 59 plans numbered 01-59, every dependency points backward`, which is the same guarantee as before
the split.

## Moving a plan in here

1. Close every task, including `- [~]` ones.
2. Set `> **Status**: `implemented`` in all three files, and add a dated note saying what changed.
3. Run `pnpm ci:local` and record the step count in the note.
4. `git mv plans/<phase>/NN-name plans/implemented/<phase>/NN-name`.
5. Fix the links, and verify them with a resolver rather than by eye. Three things change at once: a
   sibling still in the phase directory becomes `../../../<phase>/NN-name/`, a full path becomes
   `plans/implemented/<phase>/NN-name`, and — the one that is easy to miss — **the archive sits one level
   deeper**, so every `../../` aimed at the repository root needs another `../`. On 2026-08-11 that last
   category was 54 of the breaks, all of them links that had been correct minutes earlier.
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

It guards every phase the same way, archived or live, and it is what makes "finish a plan, move it" a rule
rather than a habit: a finished plan left in its phase directory fails with the `git mv` to run. Verified
against breakage in both directions — a `superseded` plan flipped to `implemented` is told to move, and a
`- [x]` flipped back to `- [ ]` inside the archive is told to move back.

`pnpm plans:check-order` runs beside it, and guards that a two-digit prefix is still a position in a
contiguous build order across both directories.

### Why the readiness gate is *not* pointed at this folder

`check-phase-readiness.mjs` asks "is this plan ready to be executed?" — no reserved migration numbers,
no placeholders, an exact three-file set. Those rules are about work that has not happened yet. Run over
these 48 plans it reports 52 failures, and 22 of them are task texts naming the migration the plan
*actually created*. Satisfying those would mean rewriting the record of what happened to please a
forward-looking lint. The position-contiguity half of that gate *was* fixed to read both directories,
because that part is about order rather than readiness.
