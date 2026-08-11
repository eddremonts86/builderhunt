# Feature: SourceHut Integration

> **Status**: `retired`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector exists at `src/lib/sources/sourcehut.ts` and is fully wired
> (pipeline, pill, badge, icon, scoring, env var). It returns results **only when
> `SOURCEHUT_TOKEN` is set** — the SourceHut GraphQL API requires auth. Token is not
> documented in `.env.example`.

## Problem

SourceHut is a small-but-loyal OSS forge (privacy-focused developers who avoid GitHub and
Microsoft). Complementary niche coverage next to GitHub/GitLab/Codeberg.

## Goal

Index SourceHut users as `RawBuilder` person records via the meta.sr.ht GraphQL API.

## Delivered

Shipped in `src/lib/sources/sourcehut.ts`:

- GraphQL user search against `https://meta.sr.ht/query`:
  `users(search: $q, first: 20) { results { canonicalName name description location url } }`.
- **Auth is mandatory upstream**: without `SOURCEHUT_TOKEN` every request 401s, so the
  connector short-circuits to `[]` when the token is unset (by design — the source is wired
  so it lights up the moment a token is configured).
- Mapping: `id: sh-{canonicalName}`, `kind: 'person'`, `followersCount: undefined`
  (SourceHut has no follower concept), profile URL `https://sr.ht/~{name}`.
- Registered in `src/lib/search.ts` and `SourceName` (`src/lib/sources/types.ts`).
- UI: opt-in pill in `ALL_SOURCES` + `SOURCE_META` (`SearchPage.tsx`), `SourceHutIcon` in
  `BrandIcons.tsx`, `.badge-sourcehut` in `src/shared/styles/globals.css`.
- Scoring: `sourcehut` branch in `src/lib/score.ts` (bio-length bonus, since no
  followers/karma exist).
- GraphQL errors and network failures return `null`/`[]` — never break the federated
  search (`search.ts` uses `Promise.all`).

## Remaining gaps (real)

1. **Repo search never built.** The original plan promised `kind: 'repo'` results from the
   git.sr.ht GraphQL API; only people are returned today. Low value (SourceHut repos carry
   no stars), kept as an optional task.
2. **`SOURCEHUT_TOKEN` is missing from `.env.example`** — without documentation, deploys
   silently get an always-empty source.

## Non-goals (unchanged)

Unauthenticated operation (impossible — the API requires a token); social graph; mailing
list / todo trackers.

## Success metrics

- With a token configured, searching a known SourceHut username or topic keyword returns
  person cards; without a token the source contributes nothing and costs nothing.
