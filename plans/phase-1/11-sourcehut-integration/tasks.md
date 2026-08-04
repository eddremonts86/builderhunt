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

  ### Update 2026-08-04 — the decision is narrower than the three options above, and option 3 is out

  Option 3 (enrichment) was going to be the recommendation. Before implementing it, two things were checked live
  rather than assumed: whether anything works **without** a token, and what sr.ht's own policy says.

  **`https://git.sr.ht/robots.txt`** (identical at meta.sr.ht) opens with a prose policy, not just directives:

  > Allowed: search engine indexers, archival services. **Disallowed: marketing or SEO crawlers; anything used
  > to feed a machine learning model**; bots which are too aggressive by default.

  BuilderHunt indexes profiles into `builder_embeddings` (pgvector) and feeds AI ranking and grounded
  explanation. It is the case that sentence names. Crucially, that is a statement about the **use**, so a
  `SOURCEHUT_TOKEN` does not resolve it — the token would only record that a person accepted terms while the use
  itself stays excluded. Option 3 is therefore not a scope change to weigh against the others; it is off the
  table.

  **The unauthenticated surface, probed directly:** `https://git.sr.ht/~user` answers 200 with a bare list of
  repository names and is *not* in the machine-readable `Disallow` list. Everything that carries signal is:
  `/*/*/log/*` (including the per-repo `log/rss.xml`, which does return 200 `application/rss+xml`), plus
  `blame`, `commit`, `tree`, `item`, `*/raw`, and any URL with a query string. So even setting the purpose
  policy aside, the crawlable surface is repository names with no dates, no activity and no profile fields —
  nothing worth building on.

  **Recommendation, changed by this finding: option 1, retire the source.** Previously the argument was "the API
  cannot do it", which invites "then find another way". The real argument is that the operator has said in
  writing that this use is unwelcome, and a source pill that can never return a result is a claim the UI cannot
  keep. Retiring means removing the pill, icon, badge and scoring entry — user-visible product surface, so it is
  left for the maintainer to approve rather than done unilaterally.

  Recorded in `docs/operations/public-enrichment-source-register.md` under a new `sourcehut` entry, which is the
  document that exists to hold lawful-basis facts per source, and in the connector's own header.

  **No token is needed any more to close this.** The blocker was never the token; it was this question, and the
  question is now answered.
