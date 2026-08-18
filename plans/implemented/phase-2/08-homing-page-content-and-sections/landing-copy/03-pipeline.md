# Pipeline section copy

The three shipped surfaces that turn "search and look" into recurring work.

> **Verified 2026-08-18.** All three plans resolve, and all three are in
> `plans/implemented/phase-1/` — so all three are shipped. The earlier draft badged one of them
> "COMING SOON", which is the error this section can least afford.

## Section header

**Eyebrow**: PIPELINE
**Headline**: Three surfaces that turn a search into a system.
**Subhead**: Discovery is the entry point. Alerts, sprints and shared shortlists are what keep it
running without you clicking refresh.

## Three cards

### Card 1 — Keyword alerts

**Eyebrow**: SHIPPED
**Plan**: [`phase-1/34-smart-alerts`](../../../../implemented/phase-1/34-smart-alerts/spec.md)
**Copy**: Set the filter once. We tell you the moment a new builder matches.

Email delivery is a paid action; a free workspace gets the private feed link, which runs the same
query. The card says "we tell you" rather than naming a channel, so it stays true on both plans.

### Card 2 — AI sourcing sprints

**Eyebrow**: SHIPPED
**Plan**: [`phase-1/41-ai-sourcing-sprints`](../../../../implemented/phase-1/41-ai-sourcing-sprints/spec.md)
**Copy**: Give a role a deadline and let a sprint work the sources for you.

Concurrency is tier-gated by `SOURCING_SPRINT_LIMITS` in `src/shared/lib/billing-shared.ts` —
free 0, pro 3, pro_max 10, team 10. **Rendered from the constant if shown at all.** The earlier draft
typed "Free: 0. Pro: 3. Team: 10", which is right today, omits `pro_max`, and is the same
hand-written-number defect as the source count.

### Card 3 — Team shortlists

**Eyebrow**: SHIPPED
**Plan**: [`phase-1/28-shared-resources`](../../../../implemented/phase-1/28-shared-resources/spec.md)
**Copy**: Share saved searches and shortlists with your workspace, with private lists staying private.

## What the earlier draft got wrong

- **Card 3 was badged `COMING SOON`** and described as `pending — unblocked 2026-07-29`, with a link
  "to the plan, not to the feature". `28-shared-resources` is in `plans/implemented/phase-1/`. The
  page would have advertised a shipped feature as unavailable — the rare failure that costs sign-ups
  by being *too* modest, and the one no reviewer catches because nobody audits copy for underselling.
- Every card's eyebrow carried the plan path in shouting caps. Plan numbers are internal navigation;
  a visitor reading `PLAN PHASE-1/34-SMART-ALERTS` learns nothing and sees the seams.
- The acceptance block referred to "12 concurrent" sprint caps, a number matching nothing.

## Acceptance

- Every card cites a real plan path, and the path's location under `implemented/` or a phase
  directory is what decides the badge — not a hand-written status.
- No tier number appears as a literal; the sprint caps render from `SOURCING_SPRINT_LIMITS`.
- No card promises email alerts without the paid-plan qualifier.
