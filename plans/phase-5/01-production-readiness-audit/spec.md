# Production Readiness Audit — the gates that need real production (spec)

> **Status**: `blocked` — by design, and not by anything a session can unblock. Every task here needs
> a live deployment plus elapsed time or a human approval. Nothing in it is code.
> **Depends on**: all of `plans/phase-1/` reaching its own definition of done, and a production
> deployment carrying it
> **Blocks**: the move from MVP/Beta to plain production. This plan *is* that gate.
> **Reality check**: these seven tasks were carried in `phase-1` until 2026-07-29, where they made
> "phase-1 works 100% at MVP launch" unsatisfiable: a conversion baseline needs ≥14 days of real
> traffic and ≥1,000 sessions, and a canary needs seven days to elapse. Both start counting *after*
> launch. They were not incomplete work — they were work whose definition contains the launch.

## Problem

Phase 1 mixes two kinds of unfinished. Most of it is work: write the code, run the test, see it pass.
Seven items are different — they ask production to have existed for a while:

- a conversion baseline needs a fortnight of real sessions;
- a seven-day canary needs seven days;
- a performance and a visual baseline need numbers measured against a deployed release, because
  measuring them locally is measuring a laptop;
- turning removal enforcement on, source by source, needs a maintainer to decide it is time.

Leaving them in phase-1 had a concrete cost: it made the phase permanently 7 tasks short of done, so
"is phase-1 finished?" could never be answered yes, and the honest answer — "finished except for
things that require having launched" — had nowhere to live. Worse, it invited the wrong fix: fabricate
a baseline from local data, shorten the canary, declare a rollout done because the flag flipped. Every
one of those is a lie that ships.

## Goal

One plan that is explicitly the **exit gate from MVP/Beta to production**, holding only the checks
that need a real deployment. It closes when each has real recorded evidence, and until then it is the
honest reason the product is still labelled Beta.

## Non-goals

- **No code.** If a task here turns out to need code, that code belongs to the phase-1 plan that owns
  the surface, and this plan waits for it.
- **Not a substitute for the release audits.** `48`–`53` in phase-1 remain the per-release gates. This
  plan is the one-time crossing.
- **No shortening.** A shortened canary or a baseline measured over 3 days is not this plan completed;
  it is this plan skipped. Record the real number or leave the box unchecked.

## Where each task came from

Moved verbatim on 2026-07-29, with the origin plan keeping a pointer so nobody re-adds it:

| From | Task | What it waits on |
|------|------|------------------|
| `42-stealth-scraping` | Approve and run seven-day canary | human approval + 7 days |
| `42-stealth-scraping` | Enable manual customer refresh | the canary's approval |
| `49-audit-performance-qa` | Read-only production smoke and baseline | a deployed release |
| `50-audit-visual-system` | Verify production and close the audit | a deployed release |
| `51-audit-conversion` | Collect and approve the real baseline | ≥14 days, ≥1,000 sessions |
| `51-audit-conversion` | Controlled rollout and record the decision | the baseline above |
| `52-audit-trust` | Roll out source by source | maintainer decision on `PROFILE_REMOVAL_ENABLED` |

## Success

- Every task checked, each against evidence dated after the production deployment.
- No number in this plan came from a local run, a staging environment, or an estimate.
- The Beta label comes off in the same change that checks the last box, and not before.
