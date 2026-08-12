# Tasks: IndieHackers Integration

> **Status**: `superseded` — closed and skipped, not built
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Blocking decision made 2026-07-25 (product owner): option (a), skip
> permanently. IndieHackers has no official API and the SPA requires a logged-in headless
> browser session to read — a real ToS violation, not just a technical inconvenience. The
> "founder" signal this plan was meant to capture is covered instead by
> [`producthunt-integration`](../../../implemented/phase-1/18-producthunt-integration/spec.md) (official API) and,
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

### Builder tags + founder filter — closed as won't-do

**Decided 2026-08-04, approved by the product owner.** Not moved to phase-5 and not left as a partial: it
is not waiting on anything. The option it was conditional on ("only under option (a), and only if
founder-filter demand exists") was not chosen, and no demand was observed.

Recorded as prose rather than `[~]` because a tilde reads as "half done" to anyone walking this file, and
this is "not doing". The scope survives in the spec if demand ever appears.

