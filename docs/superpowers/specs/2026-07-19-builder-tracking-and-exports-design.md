# Builder tracking & the `/exports` page — design

## Problem

`/exports` currently renders a single "Download CSV" button that calls
`GET /api/export/builders`, which exports rows from the `builders` table
scoped to `WHERE builders.user_id = <me>`. Both the dashboard's "Builders
tracked" stat (`GET /api/dashboard/stats`) and this export read from the
same table and the same scoping.

The problem: **nothing in the app ever writes to that table.** There is no
"save this builder" action anywhere in the UI — not in search results, not
in the recommendations section. So `builders` is permanently empty for every
user, the dashboard stat is permanently 0, and the export always produces an
empty CSV. The page isn't broken by a bug; it's missing the write path its
read path assumes exists.

Confirmation this is the intended model, not a misreading of the schema:
`GET /api/recommendations` already computes a `savedKey` set from
`builders.source + builders.source_id` scoped to the current user, and
explicitly excludes those builders from recommendations ("Exclude builders
the user has already saved"). That code only makes sense if per-user rows in
`builders` represent "builders this user has saved/tracked" — confirming the
data model, just missing the write side.

Separately, `/settings/privacy` already has a fully working, unrelated
"Export my data" feature (GDPR full-account export, JSON, throttled,
backed by `data_export_requests`). It is not touched by this design; the
redesigned `/exports` page must clearly distinguish itself from it so users
don't confuse the two.

## Goals

1. Add the missing "track a builder" write path: a button in search results
   that saves/unsaves a builder to the current user's list.
2. Redesign `/exports` to show that real list (not just a blind download
   button) with explanatory content, and keep CSV export working against
   real data.
3. Do this without touching the unrelated GDPR export feature or the
   dashboard's other (separately fake/hardcoded) stat badges — those are out
   of scope for this change.

## Data model

Reuse the existing `builders` table as-is — no column changes. Add one
migration:

```sql
CREATE UNIQUE INDEX builders_user_source_unique
  ON builders (user_id, source, source_id);
```

This makes "track" idempotent (upsert on conflict) and prevents a user from
ending up with duplicate rows for the same external profile. Generated via
`pnpm db:generate` (not hand-written), and the resulting journal + snapshot
are verified in sync before committing — this repo already hit a production
incident from a hand-desynced `drizzle/meta/_journal.json` (see the
`database-migrations` ai-os skill), so this step is done carefully.

## Backend

### `POST /api/builders/track` (new)

Auth required. Body: the fields already present on a search result —
`source`, `sourceId`, `username`, `displayName`, `avatarUrl`, `bio`,
`profileUrl`, `followersCount`, `language`, `country`, `topics`, `metadata`.
Upserts a row scoped to `session.user.id` (insert; on conflict on the new
unique index, update `lastSeen`/`updatedAt`). Returns `{ id, tracked: true }`.

### `DELETE` on the existing `/api/builders/$builderId` route

That file already has `GET` (public profile) and `PATCH` (claimed-profile
edits). Add `DELETE`: auth required, verifies `builders.userId ===
session.user.id` (note: this is the *tracking* owner check, distinct from
the `claimedByUserId` check `PATCH` already uses for claimed-profile edits —
these are two different relationships to the same row and must not be
conflated). Deletes the row, returns `{ success: true }`.

### `GET /api/me/builders` (new)

Auth required. Returns the full list of the current user's tracked builders
(all columns needed to render the exports-page list: id, username,
displayName, avatarUrl, source, profileUrl, topics, metadata.score,
lastSeen), ordered by `lastSeen desc`.

### `POST /api/search/builders` (extended, not replaced)

When a session exists, annotate each result with `tracked: boolean` by
reusing the same "saved key" lookup `recommendations/index.ts` already does
— this logic is extracted into a shared helper (e.g.
`~/shared/lib/tracked-builders.ts` exporting
`getTrackedKeySet(userId): Promise<Set<string>>`) and both routes import it,
rather than duplicating the query a third time.

## Frontend

### Search results (`SearchPage.tsx`, People tab)

The local `Builder` interface gains `sourceId: string` (already present at
runtime from the API, just untyped) and `tracked?: boolean`. The local
`PersonResultCard` gains a button next to "View":

- Untracked: outline "Track" button (bookmark icon).
- Tracked: filled "Tracked ✓" button — click removes.
- Optimistic toggle: flips immediately, reverts on request failure with an
  inline error.

### `/exports` page (`ExportsPage.tsx`, full rewrite)

- Header: explains the feature in one or two sentences, plus an explicit
  link to `/settings/privacy` for the "export all my account data" case, so
  the two exports are never confused.
- Real count of tracked builders.
- List of tracked builders: avatar/initials, name, source icon, score,
  topics, "Remove" button (calls the `DELETE` endpoint, optimistic removal).
- Empty state: explains why it's empty (you haven't tracked anyone yet) with
  a CTA linking to `/search`.
- "Download CSV" button at the bottom, disabled with a tooltip when the list
  is empty.

## Explicitly out of scope

- The dashboard's hardcoded stat badges ("12 Lists", "20 Closed", "40 Open")
  — a separate, unrelated piece of dead/placeholder content.
- `RecommendationsSection.tsx` and the landing page's demo `PersonResultCard`
  (in `~/modules/search/components/PersonResultCard.tsx`) — not wired to
  live tracking in this change, though the new track button is written so it
  could be reused there later.
- Adding a JSON export format alongside CSV — CSV already works and covers
  the current need; easy to add later if asked.
- Multiple named "lists" (the dashboard badge's "12 Lists" copy implied
  this) — the schema only supports one flat per-user list; introducing named
  lists would be a much larger schema change and wasn't requested.
- The pre-existing "claimable profiles" architecture, where each tracker's
  saved row for the same external person is a separate, independently
  claimable `builders` row (no dedup across users). That's an existing
  design decision this change relies on as-is, not something introduced or
  reworked here.

## Testing

- Vitest: `POST /api/builders/track` (create, idempotent re-track, ownership
  on delete), `GET /api/me/builders`, the shared tracked-key helper.
- Manual browser pass (per the ai-os coolify-deploy skill's mandatory
  post-deploy check, and generally good practice here too): track a builder
  from search, confirm it shows tracked immediately, confirm it appears on
  `/exports`, remove it, confirm the CSV download reflects the current list.
