# Feature: npm Registry Integration

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Connector exists at `src/lib/sources/npm.ts` and is fully wired
> (pipeline, opt-in pill, badge, icon, scoring branch, no env vars needed). It depends on
> the third-party `api.npms.io` search service (alive as of 2026-07-19, but historically
> unreliable) and never uses the downloads API this spec originally promised.

## Problem

GitHub finds committers; it does not directly find **package maintainers** — the people who
own the tools everyone depends on. The npm registry is the canonical record of the JS
ecosystem and exposes maintainers per package.

## Goal

Index npm packages (repos) and, primarily, their maintainers (people) as `RawBuilder`
records.

## Delivered

Shipped in `src/lib/sources/npm.ts` (file header documents the strategy):

- Search: `GET https://api.npms.io/v2/search?q={q}&size=20` (ranked, includes quality/
  popularity scores), then `GET https://registry.npmjs.org/{name}` per result (parallel,
  capped at 20) for maintainers, keywords, and modification times.
- Two entity kinds:
  - `kind: 'repo'` — packages (`id: npm-{name}`), npms.io `score.final * 100000` as the
    `followersCount` proxy, keywords as topics, `metadata.lastSeen` from `time.modified`.
  - `kind: 'person'` — maintainers aggregated across matched packages
    (`id: npm-user-{username}`), max package score x 100k as `followersCount` proxy,
    aggregated keywords, package count / total score in metadata.
- **Privacy delivered as promised**: maintainer emails are read for aggregation but
  intentionally excluded from `metadata` (comment in `maintainerToPersonBuilder`), so they
  never reach the client.
- Registered in `src/lib/search.ts` and `SourceName`; opt-in pill (`ALL_SOURCES`, not
  default-active — matching the original "off by default" recommendation), `NpmIcon`,
  `.badge-npm`, `npm` scoring branch in `src/lib/score.ts` (multi-package maintainer bonus).
- All fetches try/caught to `[]` (mandatory: `search.ts` uses `Promise.all`).

## Remaining gaps (real)

1. **Hard dependency on npms.io.** `registry.npmjs.org/-/v1/search` (first-party, also
   returns `score` + maintainers inline) would remove the third-party single point of
   failure. If npms.io dies again, the npm source silently returns `[]`.
2. **Weekly downloads never fetched.** The promised
   `api.npmjs.org/downloads/point/last-week/{pkg}` signal was replaced by the npms.io
   composite score. Acceptable proxy, but popularity for packages is opaque to users.
   Folded into gap #1's task (the first-party search response makes downloads optional).

## Non-goals (unchanged)

Full registry coverage; PyPI/crates.io/RubyGems (separate future plans); showing maintainer
emails anywhere in the UI (never); npm Enterprise.

## Success metrics

- "graphql" / "react state" with the npm pill active returns maintainer person-cards above
  package cards; maintainers of multiple matched packages rank higher.
