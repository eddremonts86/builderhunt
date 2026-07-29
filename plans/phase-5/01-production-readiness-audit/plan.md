# Production Readiness Audit (plan)

> **Status**: `blocked` — waiting on a production deployment, then on time passing
> **Depends on**: all of `plans/phase-1/`, plus that phase deployed to production
> **Blocks**: dropping the Beta label
> **Reality check**: no code. The sequencing below is about what must be *observed* before what, and
> the longest pole is fourteen days of real traffic that cannot start before launch.

## Phases

### Phase 1 — the day of the deployment

Runs once phase-1 is live. Both are measurements, not changes.

- The read-only production smoke and the performance baseline (from `49`).
- The visual comparison against the deployed release (from `50`).

Neither can be done earlier: a laptop's numbers describe the laptop. Both are quick — the gate is
having something deployed, not the work.

### Phase 2 — turn the counters on, then wait

- Deploy with `CONVERSION_EVENTS_ENABLED=true` and let it run. The clock starts here.
- Deploy enrichment dark (`ENRICHMENT_ENABLED=false`) and get the legal sign-off recorded, so the
  canary can start as soon as the approval exists.

### Phase 3 — the waiting, in parallel

Two independent clocks, so they overlap rather than queue:

- The seven-day enrichment canary (from `42`), which needs its approval first.
- The ≥14-day conversion collection (from `51`), which needs ≥1,000 eligible sessions — so on thin
  traffic the session count, not the calendar, is the binding constraint.

### Phase 4 — the decisions the waiting was for

- Approve the canary result, then enable manual customer refresh (from `42`).
- Approve the conversion baseline and run the staged rollout, recording keep-or-revert (from `51`).
- Decide `PROFILE_REMOVAL_ENABLED` and roll it out source by source (from `52`).

### Phase 5 — close it

Check the last box and drop the Beta label in the same change. Not before: the label is the honest
statement that this plan is open.

## Risks and controls

| Risk | Control |
|------|---------|
| A baseline gets measured over 3 days because waiting is uncomfortable | The task states ≥14 days **and** ≥1,000 sessions, and §Non-goals says a short measurement is the plan skipped, not done |
| The canary gets shortened after a quiet first two days | Seven days is the number; a quiet canary is evidence about traffic, not about safety |
| Numbers from staging get recorded as production numbers | Each task's Verify names production explicitly; the `Operator` line says an agent cannot produce them |
| The Beta label comes off while boxes are open | Dropping it is the last task, in the same change |
| Someone re-adds these to phase-1 to make it look finished | Each origin plan carries a pointer here, and `pnpm plans:check-tasks` fails on a checkbox under a scope heading |

## Rollback

Nothing to roll back — the plan changes no code. If a gate fails, the corresponding feature flag goes
back to `false` and the phase-1 plan that owns it reopens. The canary and the conversion rollout both
have their own revert paths in their origin plans.
