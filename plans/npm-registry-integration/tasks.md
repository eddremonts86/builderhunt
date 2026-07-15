# Tasks: npm Registry Integration

## Phase 0 — Read first

- [ ] `src/lib/sources/github.ts` — pattern for "user + repo" sources
- [ ] `src/lib/score.ts` — how scoring works
- [ ] The dedup logic — we have maintainer emails, use them later

## Phase 1 — Data model

- [ ] No schema changes; reuse `source: 'npm'`
- [ ] Two kinds: `'person'` (maintainers) and `'repo'` (packages)

## Phase 2 — New source: `src/lib/sources/npm.ts`

- [ ] Add `npm` to `Source` type
- [ ] `searchNpmPackages(keywords)`:
  - `GET https://api.npms.io/v2/search?q={keywords}&size=20`
  - For each result, fetch `https://registry.npmjs.org/{package.name}` for full metadata + maintainers
  - Map to `RawBuilder` with `kind: 'repo'`
- [ ] `searchNpmMaintainers(keywords)`:
  - Same package search
  - Extract maintainers from each package
  - Group by maintainer username (same person may maintain multiple packages)
  - Aggregate: which packages they maintain, total downloads, bio
  - Map to `RawBuilder` with `kind: 'person'`
- [ ] `searchNpm(keywords)`:
  - Run `searchNpmPackages` and `searchNpmMaintainers` in parallel
  - Combine

## Phase 3 — Parallel fetching

- [ ] Use `Promise.all` for fetching package metadata
- [ ] Limit: max 20 packages per search (matches npms.io `size=20`)
- [ ] Throttle: max 5 concurrent requests (npm registry is CORS-friendly but be polite)

## Phase 4 — Wire into pipeline

- [ ] Update `src/lib/search.ts` to include `searchNpm`
- [ ] Update `ALL_SOURCES` and `SOURCE_META` in `SearchPage.tsx`:
  - Add `'npm'` to `Source` type
  - Add `SOURCE_META.npm = { label: 'npm', color: 'badge-npm', Icon: NpmIcon }`
  - Add npm to default active sources (6 → 7)
- [ ] Note: with 7 sources, default might be too many. Consider making npm opt-in (off by default). See plan.

## Phase 5 — Brand icon + UI

- [ ] Add `NpmIcon` to `BrandIcons.tsx` (inline SVG)
- [ ] Color: npm red `#CB3837`
- [ ] Add `.badge-npm` to `globals.css`

## Phase 6 — Scoring

- [ ] Maintainer score:
  - Number of packages maintained (log scale, ×5)
  - Total weekly downloads of their packages (log scale, ×3)
  - Recency of last publish (×5 if last week, ×2 if last month, ×1 if older)
  - Bio keyword match (×10)
- [ ] Package score:
  - Weekly downloads (log scale, ×10)
  - Recency of publish (×5)
  - Quality score from npms.io if available

## Phase 7 — Default off?

- [ ] **Decision**: with 7 sources, default-on npm might dilute results. Two options:
  - (a) On by default — most JS-related queries benefit
  - (b) Off by default — opt-in
  - **Recommended**: (b) for v1. Add a small banner: "JS ecosystem? Enable npm →" with one-click toggle.
- [ ] Persist user preference in `users.preferences` JSONB column (no migration needed if we add it)

## Phase 8 — Verification

### Manual
- [ ] Search "graphql" → see packages + maintainers
- [ ] Search "react" → see react maintainers
- [ ] npm card shows the red badge correctly
- [ ] npm maintainer card shows: "Maintains 5 packages: react, react-dom, ..."

### Automated (Playwright)
- [ ] npm toggle behavior
- [ ] npm cards have `.badge-npm` class

### Performance
- [ ] npm endpoint < 1s (parallel fetches are slower than single API)
- [ ] Cache packages and maintainers separately

## Phase 9 — Rollout

- [ ] Soft launch with monitoring
- [ ] Track: dismiss rate, CTR
- [ ] Decide on default on/off based on data

## Edge cases

- **No keywords match in npms.io**: empty result, silently skip
- **Package with 0 maintainers**: skip the package
- **Maintainer with no packages in result**: skip
- **Email is `null`** (some packages hide it): dedup by username only
- **Scope packages** (`@types/react`): include or exclude? Default: include, but filter very small scopes
- **Deprecated packages**: include with a "deprecated" tag in the card

## Dependencies

- No new packages
- No schema changes
- No new env vars

## Estimated effort

| Phase | Effort |
|-------|--------|
| 2 — New source | M (4-6h) |
| 3 — Parallel fetching | XS (1h) |
| 4-5 — Wire + UI | S (2-3h) |
| 6 — Scoring | S (2-3h) |
| 7 — UX decision | XS (1h) |
| 8 — Verification | S (2-3h) |
| **Total** | **~1.5 days** |
