# Plan: Codeberg Integration

> **Status**: `implemented` (verified 2026-07-28)
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: The original "defer until GitLab ships" decision is obsolete — both
> shipped. `src/lib/sources/codeberg.ts` is complete and wired; the `.env.example`
> documentation landed 2026-07-25, so nothing remains.

## Executed phases (record)

1. **Source file** — `src/lib/sources/codeberg.ts`: parallel user + repo search against the
   Gitea API, public/active filtering, combined and paginated output.
2. **Pipeline** — import + `sources.includes('codeberg')` in `src/lib/search.ts`;
   `codeberg` in `SourceName`.
3. **Env** — `CODEBERG_API_URL` (default `https://codeberg.org/api/v1`) and
   `CODEBERG_TOKEN`, both optional, in `src/shared/lib/env.ts`.
4. **UI** — opt-in pill, `SOURCE_META.codeberg`, `CodebergIcon`, `.badge-codeberg`.
5. **Scoring** — `codeberg` branch in `src/lib/score.ts` using real follower counts.

## Remaining phase

### Phase A — Env documentation

Add both vars to `.env.example`. One-line-each change, no code.

## Risks

| Risk                         | Likelihood | Impact | Mitigation                                                          |
| ---------------------------- | ---------- | ------ | ------------------------------------------------------------------- |
| Codeberg rate limit (unauth) | Low        | Low    | 5-min search cache in `search.ts`; connector returns `[]` on non-OK |
| Gitea API drift              | Low        | Low    | Standard stable endpoints; connector degrades to `[]`               |

## Rollback plan

No migrations. Remove `'codeberg'` from `ALL_SOURCES` to hide; remove the gate in
`search.ts` to disable.
