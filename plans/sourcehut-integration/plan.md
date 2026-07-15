# Plan: SourceHut Integration

## Status: deferred

Honorable mention, not top priority. Execute only after GitLab integration proves valuable and the "open source forge" angle is validated with users.

## Phases (when ready)

### Phase 0: Research
Same as tasks.

### Phase 1: Data model
No changes.

### Phase 2-3: GraphQL client + wire
Pattern mirrors GitLab integration. Effort: 3-4 days.

### Phase 4-5: Scoring + verification
Standard.

## When to do it

- After GitLab launch and 30 days of data
- If we see EU/enterprise user growth (SourceHunt is small but signals a privacy-conscious user base)
- If we have capacity (1 engineer for 1 week)

## Risks (summary)

- Small user base (50k vs 100M+ on GitHub)
- GraphQL API in beta — could change
- Rate limit aggressive (60/h without auth)

## Decision: defer
