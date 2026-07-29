# Phase 5 — MVP/Beta to plain production

This phase is a gate, not a backlog. It holds the checks that cannot be performed until the product
has been deployed and has been running for a while — and nothing else.

| # | Plan | Open | What it waits on |
|--:|------|-----:|------------------|
| 01 | [`production-readiness-audit`](./01-production-readiness-audit/spec.md) | 8 | a live deployment, then elapsed time and three human decisions |

## Why this phase exists

Created 2026-07-29. The owner's bar for launch is that **everything in `phase-1` works 100%**, and
seven tasks in it made that unsatisfiable — not because they were unfinished, but because their
definitions contain the launch:

- a conversion baseline needs ≥14 days of real traffic and ≥1,000 eligible sessions;
- a seven-day canary needs seven days;
- performance and visual baselines have to be measured against a deployed release, since measuring
  them locally measures a laptop;
- turning removal enforcement on, source by source, is a maintainer's decision about timing.

Keeping them in phase-1 had two costs. It made "is phase-1 done?" permanently answerable only as "no",
which hides the difference between *work remaining* and *time remaining*. And it invited the wrong
fix — fabricate the baseline, shorten the canary, call a flag flip a rollout. Each of those is a lie
that ships.

So phase-1's bar is now honest and reachable: **every piece of work done, verified locally and in a
green `pnpm ci:local`**. This phase is what stands between that and dropping the Beta label.

## The rule for adding to this phase

A plan belongs here only if no amount of engineering effort can close it sooner — it needs production
to exist, or clock time to pass, or a person to decide. If a task could be closed by writing code, it
belongs to the phase-1 plan that owns the surface. "Hard" is not the criterion; "impossible before
launch" is.
