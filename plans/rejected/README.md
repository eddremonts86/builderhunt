# Rejected plans

Every plan in this directory was **never built, and never will be under this number**. That is the only
thing this folder means.

It exists so that `plans/<phase>/` answers one question honestly: *what is left to do?* Until 2026-08-11
these five sat in `plans/phase-1/` beside the live work, so that directory listed seven entries when the
real answer was two. The commit that created `plans/implemented/` recorded filing them with live work as
"the second-best answer and worth revisiting"; this is the revisit.

Split by phase for the same reason the archive is: plan numbers are unique only *within* a phase — phase 3
is numbered 01-13 and twelve of those collide with phase 1's, so a flat root could hold one phase and no
more.

| | Plans | What it holds |
|---|---|---|
| `phase-1/` | 5 | plans closed without being built, keeping their build-order numbers |

## A plan's three possible homes

Decided by outcome, not by topic, and every one is enforced in both directions by
`pnpm plans:check-implemented`:

| Root | Means |
|---|---|
| `plans/<phase>/` | live work: open or partial tasks remain, or it is `blocked` and waiting on something |
| `plans/implemented/<phase>/` | done and tested |
| `plans/rejected/<phase>/` | `superseded`: never built |

**`blocked` is deliberately not rejected.** It means "waiting on something" — a decision, a dependency, a
phase that has not started — and that is live work whose visibility matters. Filing it here would quietly
write off work nobody cancelled. `54-waitlist-launch` was `blocked` for a while and is now archived; had a
rejected root existed then, moving it here would have been wrong at every point.

## What is in here

| Plan | Why it was closed |
|---|---|
| `11-sourcehut-integration` | retired 2026-08-04; the connector was never built |
| `16-hashnode-integration` | retired 2026-08-04; the legacy API it depended on is dead |
| `20-indiehackers-integration` | closed and skipped; no viable access path |
| `31-pricing-and-billing` | replaced by `30-stripe-billing-platform`, which shipped |
| `39-technical-sandbox` | merged into `38-work-sample`, which shipped |

## The rules this directory keeps

1. **Everything in here says `superseded` in every file that carries a Status header.** A `pending` or
   `implemented` plan in this root is a failure, the same way a `superseded` one in the archive is.
2. **A plan whose every file says `superseded` belongs in here.** Enforced, so the rule is not something
   anyone has to remember.
3. **No task-count condition**, unlike the archive. A rejected plan is usually abandoned mid-flight with
   tasks still unchecked, and requiring them to be closed first would mean editing a plan nobody intends to
   build just to be allowed to file it. The archive needs that condition because "finished" is a claim about
   the work; "rejected" is a claim about the decision.

## Moving a plan in here

```bash
git mv plans/<phase>/NN-name plans/rejected/<phase>/NN-name
```

Then fix the links, and verify rather than eyeballing it. This root sits one level deeper than a phase
directory, so every `../../docs/x` inside the plan becomes `../../../docs/x`, and every reference *to* the
plan from elsewhere has to be repointed. The move on 2026-08-11 broke 41 links across 20 files, and none of
them were visible by reading the diff.

```bash
pnpm plans:check-links      # every relative link under plans/ resolves
pnpm plans:check-order      # build order still contiguous 01..N across all three roots
pnpm plans:check-implemented
```

The numbers do not change when a plan moves. A two-digit prefix is the plan's position in the build order
recorded in [`_meta/phase-1-order.md`](../_meta/phase-1-order.md), not its address — so `11` is still `11`,
and `plans/phase-1/` keeps the gaps where a moved plan used to be.
