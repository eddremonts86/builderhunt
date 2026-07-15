# Plan: npm Registry Integration

## Goal recap

Index npm package maintainers as discoverable entities. Different angle from GitHub: maintainers are builders of widely-used tools, not just PR contributors.

## Why this is the third pick

1. **Unique angle.** No other source in this product captures "package maintainer" identity. GitHub user search finds people who commit to repos; npm finds people who *own* widely-used packages.
2. **High-signal data.** A person who maintains a package with 100k weekly downloads is a serious builder. Easy to identify.
3. **Public email exposure** (opt-out default) — useful for cross-source dedup later.

## Phases

### Phase 0: Research (done in plan)

Confirmed:
- `api.npms.io/v2/search` for search
- `registry.npmjs.org/{package}` for metadata
- `api.npmjs.org/downloads/point/last-week/{package}` for downloads
- Public, no auth

### Phase 1: Data model

No changes. Two kinds in one source: 'person' (maintainer) and 'repo' (package).

### Phase 2-3: Source + parallel fetching

New file `src/lib/sources/npm.ts`. Pattern:
1. Search packages via npms.io
2. Fetch metadata for each (parallel)
3. Extract maintainers
4. Group by username

### Phase 4-5: Pipeline + UI

Add to `search.ts`, add to `Source` type, add brand icon (npm red `#CB3837`).

### Phase 6: Scoring

Maintainer score = packages × downloads × recency × bio-match.

### Phase 7: Default on/off — **RECOMMEND OFF BY DEFAULT**

With 6 other sources, adding npm by default would dilute most results. **Off by default for v1** with a "JS ecosystem? Enable npm" prompt. User can toggle on.

This is a conservative bet. After monitoring, if data quality is good, we can switch to default-on.

### Phase 8-9: Verification + rollout

Manual + Playwright + soft launch.

## Dependency graph

```
Phase 0 ──> Phase 1 (npm package) ──> Phase 2 (search) ──┐
                                                        ├──> Phase 6 (verify) ──> Phase 7 (rollout)
                                  Phase 3 (UI) ──> Phase 4 (scoring) ──┘
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **Many sources, dilute results** | High | Medium | npm OFF by default; one-click banner to enable |
| **Email exposure (privacy)** | Certain | Low | Never show emails in UI; only use for dedup |
| **Slow due to many parallel fetches** | Medium | Medium | Throttle 5 concurrent, cache package metadata |
| **Scope packages clutter** | Medium | Low | Filter `@types/*` or deprioritize |
| **Deprecated packages** | Medium | Low | Mark as deprecated in card |

## Rollback plan

- `ENABLE_NPM=false` env var hides from UI
- No migrations
- Per-user preference to enable/disable

## What this is NOT

- **Not full registry scrape.** Only keyword-matched packages.
- **Not just packages.** The maintainer is the user, not the package.
- **Not security audit data.** Just ownership.

## What this enables (downstream)

Once npm works:
1. **PyPI / crates.io / RubyGems** — same pattern, multi-language maintainer discovery
2. **"Who maintains X?"** — direct query: `npm:react` → maintainers of react
3. **Cross-source dedup by email** — same person on GitHub + npm
4. **Team pages** — "maintainers of @vercel/*"
