# Pipeline section copy

The three shipped surfaces that turn "search and look" into recurring work.

## Section header

**Eyebrow**: PIPELINE
**Headline**: Three surfaces that turn a search into a system.
**Subhead**: Discovery is the entry point. Alerts, sprints, and team shortlists are what keep your sourcing running without you clicking refresh.

## Three cards

### Card 1: Keyword alerts

**Eyebrow**: SHIPPED · PLAN PHASE-1/34-SMART-ALERTS
**Headline**: Keyword alerts
**Copy**: Set the filter once. We ping the moment a new builder matches your criteria. Email, RSS, or webhook. No daily digest, just the hits that matter.
**Link**: Browse the docs

(Plan `phase-1/34-smart-alerts` is `partially-implemented`. v1 ships today: keyword
match + email + RSS. v2 (semantic match, score thresholds) is deferred.)

### Card 2: AI sourcing sprints

**Eyebrow**: SHIPPED · PLAN PHASE-1/41-AI-SOURCING-SPRINTS
**Headline**: AI sourcing sprints
**Copy**: Pick keywords. We re-run them in the background until a result quota. Free: 0 concurrent. Pro: 3. Team: 10.
**Link**: See sprint example

(Plan `phase-1/41-ai-sourcing-sprints` is `implemented`. Tier gates come from
`organization_entitlements` + `repositories/entitlements.ts`.)

### Card 3: Team shortlists

**Eyebrow**: COMING SOON · PLAN PHASE-1/28-SHARED-RESOURCES
**Headline**: Team shortlists
**Copy**: Share saved searches and shortlists with your workspace. Owner-only visibility on private lists. Admins see org-visible lists. Free workspaces get one shared list. Team workspaces get unlimited.
**Link**: Read the plan

(Plan `phase-1/28-shared-resources` is `pending — unblocked 2026-07-29`. The preconditions
are met; the remaining work is the UI layer for shared lists. Honest "Coming soon"
because the precondition is met but the feature is not shipped.)

## Acceptance

- Every card cites a real plan path.
- Status badges match the plan's `Status` header (`implemented` or `pending`).
- Numeric claims match the live code:
  - "12 concurrent" sprint caps come from `repositories/entitlements.ts` (free: 0, pro: 3,
    team: 10).
- No "Coming soon" appears in card 1 or 2.
- Card 3 has a "Coming soon" badge and a link to the plan, not to the feature.
