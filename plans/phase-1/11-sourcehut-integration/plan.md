# Plan: SourceHut Integration

> **Status**: `retired`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: The original "deferred" decision is obsolete — the connector shipped
> (`src/lib/sources/sourcehut.ts`), token-gated by upstream necessity. Remaining: env
> documentation and an optional repo-search extension.

## Executed phases (record)

1. **GraphQL client + user search** — `src/lib/sources/sourcehut.ts` (`gql<T>()` helper,
   `searchSourceHut(keywords, {page, perPage})`, token-gated, silent degradation).
2. **Pipeline** — import + gate in `src/lib/search.ts`; `sourcehut` in `SourceName`.
3. **Env** — optional `SOURCEHUT_TOKEN` in `src/shared/lib/env.ts`.
4. **UI** — opt-in pill, `SOURCE_META.sourcehut`, `SourceHutIcon`, `.badge-sourcehut`.
5. **Scoring** — `sourcehut` branch in `src/lib/score.ts`.

## Remaining phases

### Phase A — Env documentation

Add `SOURCEHUT_TOKEN` to `.env.example`. Without it the source is permanently empty, which
is invisible to operators today.

### Phase B (optional) — Repo results

Query git.sr.ht GraphQL (`repositories(filter: ...)`) with the same token and emit
`kind: 'repo'` records. Only worth doing if SourceHut people-results prove useful; repos
carry no popularity signal there.

## Risks

| Risk                                      | Likelihood | Impact | Mitigation                                                    |
| ----------------------------------------- | ---------- | ------ | ------------------------------------------------------------- |
| Token quota (~600/h authed)               | Low        | Low    | 5-min search cache in `search.ts`; opt-in pill limits traffic |
| GraphQL schema drift (API still maturing) | Medium     | Low    | Connector returns `[]` on GraphQL errors already              |

## Rollback plan

No migrations. Unset `SOURCEHUT_TOKEN` to silence the source; remove the pill/gate to
remove it from the product.
