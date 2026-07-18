# Plan: Shared Saved Searches & Builder Lists

**Status:** Not yet implemented. **Depends on [`team-accounts`](../team-accounts/plan.md)** —
this plan assumes `organizations` / `organization_members` already exist.

## Goal recap

Let members of the same team (org) see and reuse each other's saved searches and
builder collections, so the "Shared saved searches & builder lists" line item in the
Team pricing tier (`billing-shared.ts`) is a real, working feature instead of a bullet
point on the pricing page.

## Why this is a valuable addition

1. **This is the actual reason a company buys Team over 3× Pro seats.** Without
   sharing, a "team" plan is just individual Pro accounts with a shared invoice — no
   collaboration value, no reason to pay the Team premium.
2. **Avoids duplicated sourcing work.** Today, if two teammates both search
   "rust backend engineer", they build two separate shortlists with zero visibility
   into each other's progress or who's already been contacted.
3. **Matches the existing product mental model.** `saved_queries` and `builder_notes`
   are already first-class dashboard objects (`_dashboard/search`, `_dashboard/dashboard`)
   — this plan extends their visibility, it doesn't invent a new concept.

## Current-state constraints this plan must work around

- `saved_queries.userId` and `builder_notes.userId` are `NOT NULL` single-owner
  columns (`src/shared/lib/db/schema.ts`) with no sharing/visibility flag today.
- The dashboard's "saved searches" and per-builder notes UI (`_dashboard/dashboard`,
  `_dashboard/builder/$builderId`) currently query strictly by `userId` — every read
  path that should include shared org resources needs an explicit update, not just
  the write path.
- Alerts (`alerts` / `alert_triggers`) are keyed off `saved_queries.id` via `queryId` —
  sharing a search has knock-on implications for who gets notified (see Phase 4).

## Phases

### Phase 1: Schema
- Add nullable `organizationId` + `visibility` (`'private' | 'team'`, default
  `'private'`) to `saved_queries`.
- Introduce `builder_lists` (`id`, `organizationId`, `userId` as creator, `name`,
  `visibility`) and `builder_list_items` (`listId`, `builderId`, `addedByUserId`,
  `addedAt`) rather than overloading `builder_notes` — notes stay private/per-user,
  lists are the shareable "who's in our shortlist" object.

### Phase 2: Access control
- Every read query that lists saved searches or builder collections (dashboard
  "Saved searches" card, `/search` page's saved-search picker) becomes: *mine* ∪
  *`visibility = 'team'` AND same `organizationId`*.
- Write/delete stays restricted to the resource's creator (or an org `admin`/`owner`)
  to avoid a teammate silently deleting another's shared search.
- Explicit test: a user in Org A must never see a `visibility: 'team'` resource
  belonging to Org B.

### Phase 3: UI
- "Share with team" toggle on the save-search dialog (`_dashboard/search`) and on a
  new "Create list" action — hidden entirely for non-team accounts, so this ships
  with zero UI change for 95%+ of users.
- Saved-searches view gains a **Mine / Team** split (tabs or a section divider), each
  shared item showing a small avatar + name for "shared by".
- Builder profile page (`_dashboard/builder/$builderId`) gains an "Add to list"
  action alongside the existing private-notes box.

### Phase 4: Alerts implications
- Decide and document: a shared search's alert still triggers **per subscribing
  user** (each teammate opts in individually via `alert_triggers`), not automatically
  for the whole org — avoids surprise emails and matches how `smart-alerts` already
  works today. Sharing a search shares the *definition*, not a forced subscription.

### Phase 5: Verification
- Cross-org isolation test (the one above) is non-negotiable given this handles
  what is effectively other companies' candidate pipelines.
- Migration safety: every existing `saved_queries`/future `builder_lists` row
  defaults to `visibility: 'private'`, so shipping this causes zero behavior change
  for every current non-team user.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Cross-org data leakage** | Low | Critical | Every shared-resource query filters by `organizationId` server-side, never trusts a client-supplied org id; covered by an explicit isolation test in Phase 5. |
| **Silent deletion of a shared search by the wrong teammate** | Medium | Medium | Restrict delete/edit to creator + org `admin`/`owner`, matching the role model from `team-accounts`. |
| **Alert spam once sharing is live** | Medium | Low | Sharing never auto-subscribes teammates to alerts (Phase 4) — each person opts in explicitly, same as today. |

## Rollback plan

- `visibility` defaults to `'private'` and the sharing UI only renders for
  `organizationId != null` accounts — disabling `team-accounts` (or simply having no
  orgs yet) makes this plan's code fully inert without needing its own separate flag.
