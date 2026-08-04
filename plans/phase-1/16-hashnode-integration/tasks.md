# Tasks: Hashnode Integration

> **Status**: `partially-implemented` — executable. The legacy endpoint is dead and the task below
> states the replacement in full: the new API has no `searchUsers`, so discovery goes through post
> search plus author aggregation. No vendor decision gates that; the paid-API question was about a
> *different*, richer integration that this plan does not scope.
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector + wiring shipped; id-prefix fix and env docs delivered
> 2026-07-25. The endpoint-migration task is genuinely blocked, not just unimplemented:
> Hashnode has closed free public GraphQL API access entirely (confirmed live 2026-07-25 —
> both the old and the task's proposed replacement endpoint now redirect to a "moving to a
> paid offering" page). The source stays wired in and degrades to `[]`, zero impact on the
> rest of the app; flagged for the user to decide whether to pay for API access, accept the
> source stays dark, or deprioritize this integration.

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

- [ ] **Migrate the connector to `https://gql.hashnode.com`**
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
