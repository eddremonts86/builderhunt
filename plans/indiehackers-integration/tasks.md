# Tasks: IndieHackers Integration

> **Status**: `blocked`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Blocked on data access — no official API exists and the SPA cannot be
> read by the plain-`fetch` connector pattern. Only decision tasks are valid; no connector
> code until unblocked.

- [ ] **Make the blocking decision: skip / approve scraping / re-check**
  - Files: `plans/indiehackers-integration/spec.md`,
    `plans/indiehackers-integration/plan.md`
  - Do: product owner picks option (a), (b), or (c) from the spec's "Blocking decision"
    section. On (a) — recommended — record the decision in all three headers, point at
    [`producthunt-integration`](../producthunt-integration/spec.md) and the optional
    tagging mini-plan as the replacements, and stop. On (b): rewrite this plan as a
    background-ingestion worker plan (per `plans/_meta/app-reality.md` constraint #3)
    before any code. On (c): keep `blocked` with a yearly re-check note.
  - Verify: the three status headers in this directory reflect the decision and agree
    with each other.

- [ ] **(Only under option (a), and only if founder-filter demand exists) Spec the
      "builder tags + founder filter" mini-plan**
  - Files: `plans/` (new directory, e.g. `plans/builder-tags/`)
  - Do: write spec/plan/tasks per `plans/_meta/conventions.md` for user-applied tags on
    tracked builders (namespaced `builders.metadata.userTags` key, filter UI in the search
    and tracked-builders views, plan-tier-neutral). This replaces IndieHackers as the
    "find founders" answer with zero scraping.
  - Verify: the new plan passes the conventions checklist (three files, status headers,
    Files/Do/Verify tasks) and is referenced from this directory's spec.
