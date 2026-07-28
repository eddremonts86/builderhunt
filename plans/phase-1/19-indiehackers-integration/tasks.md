# Tasks: IndieHackers Integration

> **Status**: `closed — skipped`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Blocking decision made 2026-07-25 (product owner): option (a), skip
> permanently. IndieHackers has no official API and the SPA requires a logged-in headless
> browser session to read — a real ToS violation, not just a technical inconvenience. The
> "founder" signal this plan was meant to capture is covered instead by
> [`producthunt-integration`](../17-producthunt-integration/spec.md) (official API) and,
> optionally, a small user-tagging mini-plan (see below). No connector code will be
> written for this source.

- [x] **Make the blocking decision: skip / approve scraping / re-check** — decided 2026-07-25:
  **(a) skip permanently**, per this plan's own recommendation. Status headers updated in
  `spec.md`, `plan.md`, and this file to reflect the closure and point at the replacements.

- [ ] **(Optional follow-up, not part of this plan) Spec the "builder tags + founder
      filter" mini-plan** — only build if founder-filter demand is actually demonstrated
      later; tracked builders already own `builders.metadata`, so a namespaced
      `metadata.userTags` key + search filter would cover this with zero scraping. See
      `plan.md` for the pointer.

- [ ] **(Only under option (a), and only if founder-filter demand exists) Spec the
      "builder tags + founder filter" mini-plan**
  - Files: `plans/` (new directory, e.g. `plans/builder-tags/`)
  - Do: write spec/plan/tasks per `plans/_meta/conventions.md` for user-applied tags on
    tracked builders (namespaced `builders.metadata.userTags` key, filter UI in the search
    and tracked-builders views, plan-tier-neutral). This replaces IndieHackers as the
    "find founders" answer with zero scraping.
  - Verify: the new plan passes the conventions checklist (three files, status headers,
    Files/Do/Verify tasks) and is referenced from this directory's spec.
