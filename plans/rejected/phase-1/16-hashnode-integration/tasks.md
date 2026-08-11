# Tasks: Hashnode Integration

> **Status**: `superseded` — retired 2026-08-04, not built
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: the connector shipped and then **stopped working silently**. Hashnode closed free
> public GraphQL access — `gql.hashnode.com` 301s to a "moving to a paid offering" page and
> `api.hashnode.com` now 404s, both re-verified live on 2026-08-04. The maintainer chose retirement over
> paying. `drizzle/0144` disables the `search_sources` row and the connector is deleted, so the
> `Delivered` list below describes what was built, not what works. Reversing it is one migration.
>
> The header's earlier claim that this was "executable" and that "no vendor decision gates that" was
> wrong on both counts, and is left visible here rather than quietly edited: the replacement endpoint it
> pointed at is the one that redirects to the paywall.

## Delivered

- [x] **GraphQL connector with graceful degradation** — Done:
      `src/lib/sources/hashnode.ts` (`searchHashnode(keywords, {page, perPage})`; all failure
      modes return `[]`, so the dead API never breaks federated search).
- [x] **Register in federated search** — Done: `src/lib/search.ts`; `hashnode` in
      `SourceName` (`src/lib/sources/types.ts`).
- [x] **Add `HASHNODE_API_KEY` env var** — Done: `src/shared/lib/env.ts` (optional).
- [x] **UI source pill + metadata** — Done: `ALL_SOURCES` + `SOURCE_META.hashnode` in
      `SearchPage.tsx` (opt-in); `PersonResultCard.tsx`.
- [x] **Brand icon + badge** — Done: `HashnodeIcon` in `BrandIcons.tsx`; `.badge-hashnode`
      in `src/shared/styles/globals.css`.
- [x] **Scoring** — Done: `hashnode` branch in `src/lib/score.ts` (followers + post-count
      bonus).

## Remaining

- [x] **Migrate the connector to `https://gql.hashnode.com`** — closed by retiring the source, see the decision below
  - Files: `src/lib/sources/hashnode.ts`
  - Do: replace `HN_GQL` with `https://gql.hashnode.com`. The new API has no `searchUsers`;
    implement discovery as: query posts by the search term/tag (new-API post search),
    collect `author { username name profilePicture followersCount }` from matched posts,
    aggregate authors (same pattern as `aggregateAuthor` in
    `src/lib/sources/huggingface.ts`), set `metadata.postCount` = matched posts,
    `metadata.lastSeen` = newest matched post `publishedAt`. Keep the exported signature
    and the degrade-to-`[]` wrapper. Send `HASHNODE_API_KEY` as `Authorization` when set.
  - Verify: `curl -X POST https://gql.hashnode.com -H 'Content-Type: application/json'`
    with the final query returns data; then search a common tag (e.g. "javascript") with
    only the Hashnode pill active and see person cards.
  - **Blocked — checked live 2026-07-25, not implemented.** Curled the exact endpoint this
    task instructs migrating to (`https://gql.hashnode.com`) before writing any query
    against it, per this session's standing discipline of verifying live API behavior
    rather than trusting task text. Both `api.hashnode.com` (the original, already known
    dead) **and** `gql.hashnode.com` (this task's proposed destination) now 301-redirect to
    `https://hashnode.com/announcements/graphql-api`, whose page title is literally
    *"GraphQL API is moving to a paid offering."* Hashnode has closed free public GraphQL
    access entirely — there is currently no free endpoint this connector could migrate to.
    Implementing the migration as specified would just move the dead-endpoint problem from
    one URL to another with identical `[]`-degradation behavior; not attempted. Left the
    connector pointed at `api.hashnode.com` (updated its own header comment to document
    this finding in detail, including the announcement page's exact title, so a future
    reader doesn't waste time re-discovering the same dead end). **This needs a real
    decision from the user**, not a code fix: either accept the source stays effectively
    disabled (already zero-impact since it degrades to `[]`, per the existing design), pay
    for Hashnode's new offering if it's worth it, or de-prioritize/remove this integration
    entirely. Flagging rather than guessing which the user would want.
  - **Decision 2026-07-25**: paused. Leave the connector pointed at the dead
    `api.hashnode.com` endpoint (zero-impact, degrades to `[]`) rather than paying for the
    new offering or removing the integration outright. Revisit if Hashnode's pricing
    changes or the free tier reopens — no further action needed now.
  - **Re-checked live 2026-08-04, still closed.** `POST https://gql.hashnode.com` continues to
    301 to `https://hashnode.com/announcements/graphql-api` ("GraphQL API is moving to a paid
    offering"). `api.hashnode.com` has degraded further and now answers **404** rather than the
    301 it returned in July — the old host no longer even points at the announcement. Nothing
    changed that would unblock this; the decision above stands, and the connector's own header
    comment already records the dead end. Re-verified rather than assumed, since a "paid API"
    situation is exactly the kind that can quietly reopen.

  ### Decision executed 2026-08-04 — retired

  The maintainer chose retirement over paying, and authorised acting on it directly.

  `drizzle/0144_retire_hashnode_source.sql` sets `enabled = false, connector_implemented = false` on the
  `search_sources` row with the reason in `register_notes` — the same mechanism `0143` used for SourceHut, and the
  same reasoning: the table's `CHECK ("enabled" = false OR "connector_implemented" = true)` makes an accidental
  re-enable impossible while a deliberate reversal stays one migration away.

  Removed: `src/lib/sources/hashnode.ts` and its wiring in `search.ts`; `hashnode` from `ALL_SOURCES` and from
  `IMPLEMENTED_SEARCH_CONNECTORS`; `HASHNODE_API_KEY` from `env.ts`, `.env.example` and
  `api/admin/integrations`. Kept: the `SourceName` union member, the icon, the badge and the scoring branch, so a
  result stored before the retirement still renders.

  **One thing worth carrying forward.** `HASHNODE_API_KEY` was documented as *optional*, and that is why nobody
  noticed: a source returning `[]` with no key set looks exactly like a source returning `[]` because the API
  closed. Any future connector whose key is optional needs a way to tell those two apart — otherwise it can stop
  working for months in plain sight, which is what happened here.

- [x] **Fix `hn-` id prefix collision with the Hacker News source**
  - Files: `src/lib/sources/hashnode.ts`
  - Do: change `id: hn-${u.username}` to `id: hnode-${u.username}` (the `hn-` prefix is
    taken by `src/lib/sources/hn.ts` line 116; `sourceId` stays the raw username).
  - Verify: `grep -n "id: \`hn-" src/lib/sources/hashnode.ts` returns nothing.
  - **Done, independent of the endpoint being dead** — the id-prefix bug is real regardless
    of whether Hashnode's API works, and fixing it now means the moment a working endpoint
    exists again, results won't silently collide with Hacker News cards. Confirmed no other
    file references the old `hn-${username}` Hashnode id.

- [x] **Document `HASHNODE_API_KEY` in `.env.example`**
  - Files: `.env.example`
  - Do: add `HASHNODE_API_KEY=` under "External Source API Tokens" (comment: optional
    Personal Access Token from hashnode.com > Developer Settings; raises rate limits).
  - Verify: `grep HASHNODE_API_KEY .env.example` prints the documented line.
  - **Done**, with an added note that the source currently returns `[]` regardless of
    whether this key is set, given the finding above.
