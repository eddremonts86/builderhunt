# Tasks: IndieHackers Integration

> **Status**: `closed — skipped`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Blocking decision made 2026-07-25 (product owner): option (a), skip
> permanently. IndieHackers has no official API and the SPA requires a logged-in headless
> browser session to read — a real ToS violation, not just a technical inconvenience. The
> "founder" signal this plan was meant to capture is covered instead by
> [`producthunt-integration`](../18-producthunt-integration/spec.md) (official API) and,
> optionally, a small user-tagging mini-plan (see below). No connector code will be
> written for this source.

- [x] **Make the blocking decision: skip / approve scraping / re-check** — decided 2026-07-25:
  **(a) skip permanently**, per this plan's own recommendation. Status headers updated in
  `spec.md`, `plan.md`, and this file to reflect the closure and point at the replacements.

Not a task, and deliberately not a checkbox: the same mini-plan appears as an executable task
below, and this paragraph is only the rationale for why it exists at all. Tracked builders already
own `builders.metadata`, so a namespaced `metadata.userTags` key plus a search filter would cover
the founder-filter idea with zero scraping — but only build it if that demand is actually
demonstrated. See `plan.md` for the pointer.

- [~] **(Only under option (a), and only if founder-filter demand exists) Spec the
      "builder tags + founder filter" mini-plan** — closed as won't-do 2026-08-04
  - Files: `plans/` (new directory, e.g. `plans/builder-tags/`)
  - Do: write spec/plan/tasks per `plans/_meta/conventions.md` for user-applied tags on
    tracked builders (namespaced `builders.metadata.userTags` key, filter UI in the search
    and tracked-builders views, plan-tier-neutral). This replaces IndieHackers as the
    "find founders" answer with zero scraping.
  - Verify: the new plan passes the conventions checklist (three files, status headers,
    Files/Do/Verify tasks) and is referenced from this directory's spec.
  - **Closed as won't-do, 2026-08-04.** Approved by the product owner.

    The task gates itself on a condition its own title states: *"only if founder-filter demand exists."* That
    condition is not merely unmet — it is currently **unmeetable**. There are no users, so no usage signal can
    exist to demonstrate demand, and the plan header already records that the founder signal itself is covered by
    `producthunt-integration` through an official API.

    Writing the spec anyway would produce a plan for a feature nobody has asked for, which is exactly what the
    conditional was put there to prevent. Left as `[~]` rather than `[x]`: nothing was built, and a checked box
    would read as delivery.

    **What would reopen it:** a real request for "show me only founders" from someone using the product, or
    aggregate search data showing people filtering for it by hand. At that point the shape is already decided and
    cheap — a namespaced `builders.metadata.userTags` key plus a filter in the search and tracked-builders views,
    with no scraping and no new source.
