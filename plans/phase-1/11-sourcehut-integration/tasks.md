# Tasks: SourceHut Integration

> **Status**: `partially-implemented` (only the explicitly-optional item remains)
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector + wiring shipped. `.env.example` docs delivered 2026-07-25.
> Remaining: an optional repo-search extension (nice-to-have, not required for the plan to
> be considered done).

## Delivered

- [x] **GraphQL client + user search** — Done: `src/lib/sources/sourcehut.ts`
      (`searchSourceHut(keywords, {page, perPage})` against `https://meta.sr.ht/query`;
      returns `[]` without `SOURCEHUT_TOKEN` or on any error).
- [x] **Register in federated search** — Done: `src/lib/search.ts`; `sourcehut` in
      `SourceName` (`src/lib/sources/types.ts`).
- [x] **Add `SOURCEHUT_TOKEN` env var** — Done: `src/shared/lib/env.ts` (optional).
- [x] **UI source pill + metadata** — Done: `ALL_SOURCES` + `SOURCE_META.sourcehut` in
      `SearchPage.tsx` (opt-in); `PersonResultCard.tsx`.
- [x] **Brand icon + badge** — Done: `SourceHutIcon` in `BrandIcons.tsx`;
      `.badge-sourcehut` in `src/shared/styles/globals.css`.
- [x] **Scoring without followers** — Done: `sourcehut` branch in `src/lib/score.ts`
      (bio-length bonus; no follower data exists upstream).

## Remaining

- [x] **Document `SOURCEHUT_TOKEN` in `.env.example`**
  - Files: `.env.example`
  - Do: add `SOURCEHUT_TOKEN=` under "External Source API Tokens" with a comment: REQUIRED
    for the SourceHut source to return anything (API 401s unauthenticated); create at
    meta.sr.ht > OAuth > personal access token.
  - Verify: `grep SOURCEHUT_TOKEN .env.example` prints the documented line.
  - **Done.**

- [ ] **(Optional) Emit repo results from git.sr.ht**
  - Files: `src/lib/sources/sourcehut.ts`
  - Do: with the same token, POST to `https://git.sr.ht/query` searching public
    repositories by keyword; map to `kind: 'repo'` (`id: sh-repo-{id}`,
    `followersCount: undefined`, `metadata.lastSeen` from `updated`). Keep person results
    first, then repos, sliced by `page`/`perPage` like other connectors. All errors -> `[]`.
  - Verify: with a token set, search a term matching a known sr.ht repo with only the
    SourceHut pill active; a repo card appears under the Resources tab.

  **Blocked 2026-08-03 — not implementable as written, and the finding is bigger than this task.**

  Checked against SourceHut's published GraphQL schemas before writing any query, per this repo's standing
  discipline of verifying live API behaviour rather than trusting task text.

  ### 1. There is no keyword search over repositories

  git.sr.ht's entire `Query` type is `gitWebhooks`, `me`, `redirectByDiskPath`, `repositoryByDiskPath`, `user`,
  `userWebhook`, `userWebhooks`, `version`, `webhook`. Repositories are reachable only through
  `me { repositories }` or `user(username) { repositories }` — **you must already know whose repositories you
  want**. `searchRepositories`, `allRepositories` and any `search(` argument are absent from the schema
  entirely. This task's `Do` line ("POST to `https://git.sr.ht/query` searching public repositories by keyword")
  describes an operation the API does not offer.

  ### 2. The person path this plan already marked done does not work either

  `searchSourceHut` asks meta.sr.ht for `users(search: $q, first: $first)`. **That field does not exist.**
  meta.sr.ht's `Query` type is account management only: `me`, `loginSecurity`, `myOauthGrant`, `oauthClient*`,
  `oauthGrants`, `personalAccessTokens`, `pgpKey*`, `sshKey*`, `userByEmail`, `userByID`, `version`, webhooks.
  No user search, no `search:` argument anywhere.

  So the connector receives a GraphQL error, `gql()` returns `null` on its `data.errors` branch, and the search
  answers `[]` — **indistinguishable from "no token configured"**. That is what hid it: the source has never
  been able to return a result, and because no `SOURCEHUT_TOKEN` is set in `.env`, nobody could tell the
  difference between "no token" and "impossible query". The plan's claim that "when `SOURCEHUT_TOKEN` is set,
  search becomes available" is false.

  The connector's header comment now records this in full, so a future reader does not re-derive it. The query
  is deliberately left pointing at the non-existent field: every rewrite still returns `[]`, and a wrong query
  that is honestly documented is easier to act on than a different wrong query that looks deliberate — the same
  reasoning as the Hashnode connector.

  ### This needs a decision from the user, not a code change

  Same shape as the Hashnode dead end, and the same three options:

  1. **Retire the source.** It has never worked; the pill, icon, badge and scoring entry all promise something
     the API cannot deliver. Zero product impact, since it already degrades to `[]`.
  2. **Keep it as a documented no-op**, as now — cheapest, and honest as long as the UI does not imply
     otherwise. Worth checking that the pill does not advertise a source that cannot answer.
  3. **Redefine what SourceHut is for.** Exact resolution *is* available: `userByEmail`/`userByID` on
     meta.sr.ht, and `user(username) { repositories }` on git.sr.ht. That makes SourceHut an
     enrichment/verification source — the shape `src/lib/sources/profile-proof.ts` already implements for
     GitHub, GitLab, Codeberg and dev.to — rather than a discovery source. This is the only option that yields
     working functionality, and it is a change of scope rather than a fix.

  A token is still needed to verify whichever option is chosen (every endpoint 401s unauthenticated, confirmed
  live), so this cannot be closed without one being created at meta.sr.ht > OAuth > personal access token.
