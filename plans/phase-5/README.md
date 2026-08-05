# Phase 5 — MVP/Beta to plain production

This phase is a gate, not a backlog. It holds the checks that cannot be performed until the product
has been deployed and has been running for a while — and nothing else.

| # | Plan | Open | What it waits on |
|--:|------|-----:|------------------|
| 01 | [`production-readiness-audit`](./01-production-readiness-audit/spec.md) | 17 | a live deployment, then elapsed time and the decisions the waiting was for |
| 02 | [`legal-and-commercial-approvals`](./02-legal-and-commercial-approvals/spec.md) | 4 | a signature, a licensed opinion, and prices a vendor has not quoted |
| 03 | [`launch-and-distribution`](./03-launch-and-distribution/spec.md) | 9 | the launch itself, then 30 days of it |
| 04 | [`post-launch-discovery`](./04-post-launch-discovery/spec.md) | 5 | fifteen real users willing to be interviewed |

**Phase-1 reached zero open tasks on 2026-08-05.** Plans 02 and 03 were created that day, and seven
further items were added to plan 01, when Edd's instruction — *the product launches when phase-5
finishes, so there is no point worrying about legal in phase-1* — was applied to all 21 tasks phase-1
still carried. Not one of them was engineering; the split into three plans is by **who owns the missing
input**: production evidence and clocks (01), signatures and prices (02), the launch (03).

**Phases 2-4 were reviewed the same day** under a second instruction — *move anything that stops me
building the app; it is always better to have the feature and disable it for legal reasons than not to have
it.* Six more items moved: five from `phase-2/01-investigacion-icp`, whose `Blocks:` header made fifteen
interviews with strangers a prerequisite for **five of phase-2's seven plans**, and one 21-day cohort
rollout from `phase-2/07`. Phase 3 was clean — thirteen plans of read-path and pagination engineering with
no approval gate in any of them. Phase 4 was clean too: no `Operator:` task anywhere in it, and the browser
extension's legal surface (host register, consent document, `/legal/extension` page) is implementable work
rather than a gate.

21 tasks left phase-1 and 20 arrived here: plan 54's "dev.to cross-post + X thread + LinkedIn + one
subreddit + Indie Hackers" and plan 46's "Cross-post + distribute posts 1-5" were the same work written
twice — once as a launch action, once as a per-post routine — and are one task now.

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
