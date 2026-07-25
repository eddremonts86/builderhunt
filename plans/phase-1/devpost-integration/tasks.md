# Tasks: Devpost Integration

> **Status**: `blocked`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Blocked on data access — Devpost has no official API and bot-challenges
> server-side requests (verified 2026-07-19). Only decision/probe tasks are valid; no
> connector code until unblocked.

- [ ] **Make the blocking decision: skip / approve scraping / re-check**
  - Files: `plans/devpost-integration/spec.md`, `plans/devpost-integration/plan.md`
  - Do: product owner picks option (a), (b), or (c) from the spec's "Blocking decision"
    section. On (a): update all three status headers to a final note and stop. On (b):
    replace this plan with the ingestion-worker plan outlined in `plan.md` (worker +
    durable storage + thin connector). On (c): keep `blocked` and schedule the probe task
    below.
  - Verify: the three status headers in this directory reflect the decision and agree
    with each other.

- [ ] **(Only under option (c)) Quarterly endpoint probe**
  - Files: none (operator check; log the result as a dated line in this file)
  - Do: run
    `curl -s -o /dev/null -w "%{http_code} %{content_type}\n" 'https://devpost.com/software/search?query=ai' -H 'Accept: application/json' -H 'X-Requested-With: XMLHttpRequest'`.
    `200` + `application/json` means the unofficial endpoint reopened -> flip status to
    `pending` and write the connector plan against the JSON shape.
    `202`/HTML means still blocked.
  - Verify: a dated result line is appended below (baseline 2026-07-19:
    `202 text/html; charset=UTF-8` — blocked).
