# Why This Match — Evidence Panel (tasks)

> **Status**: `pending`
> **Depends on**: nothing (pure read-only consumer of `src/lib/score.ts` and `builder_source_snapshots`). Files new connector findings against [`audit-trust`](../../phase-1/audit-trust/spec.md) and must respect [`project-hygiene`](../../phase-1/project-hygiene/spec.md) (no synthetic evidence presented as measured fact).
> **Blocks**: [`jd-to-candidates-matching`](../jd-to-candidates-matching/spec.md) (soft — that plan reuses this panel to explain per-JD match reasons); [`browser-extension-overlay`](../browser-extension-overlay/spec.md) (soft — it reads `src/lib/score.ts`, so land Phase 1 first)
> **Reality check**: `src/lib/score.ts` returns one integer and branches over **15** sources; `getScoreBreakdown` (`src/components/ui/score-ring.tsx:158`) is a drifted second copy feeding the ring tooltip; `SearchPage.tsx:1473` already renders a one-line "why this match"; `builder_source_snapshots` is migrated (`drizzle/0005_builder_normalization.sql`) but has no reader, no writer, and no `builderhunt_app` grant.

**Before you start.** Two conventions this file depends on:

- Unit tests live under `tests/unit/**` mirroring `src/` — `vitest.config.ts:22` includes only
  `tests/unit/**/*.{test,spec}.{ts,tsx}`. There are no co-located tests under `src/`.
  Playwright specs live in `tests/e2e/`. A `Files:` entry is marked `(new)` only where the task
  first creates it; a later task revisiting the same path is editing what an earlier task in this
  file already wrote.
- The unit environment is `happy-dom` (`vitest.config.ts:21`). It **does** toggle `<details>` on
  `summary.click()`; it does **not** implement UA keyboard activation of `<summary>`, and
  `getBoundingClientRect()` returns `0×0`. Those two properties are verified in Playwright, not
  vitest.

## Phase 1 — Freeze the score, then decompose it

- [ ] **Build the 15-source scoring fixture corpus**
  - Files: `tests/unit/lib/evidence/fixtures.ts` (new)
  - Do: export `SCORING_FIXTURES: RawBuilder[]`. Iterate `SOURCE_NAMES`
    (`src/lib/sources/types.ts:19` — 15 members today, `devpost`/`producthunt`/`bluesky` included)
    so a future source cannot be silently skipped, emitting one `kind: 'person'` row per member plus
    `kind: 'repo'` rows for `github`/`gitlab`/`codeberg`/`npm`/`huggingface`. Copy the exact metadata
    key set each connector produces — the `metadata: { … }` literal in each `src/lib/sources/*.ts`
    is the authority, and `spec.md`'s source table lists every one with its file:line. Include the
    degenerate rows: `metadata: {}`; the real GitHub-person shape
    `{ followersCount: undefined, metadata: { publicRepos: undefined, createdAt: undefined } }`
    (`/search/users` omits those fields even though `GitHubSearchUser` at `github.ts:4-15` declares
    them); `topics: []`. Not a `*.test.ts` file, so vitest will not try to collect it.
  - Verify: `pnpm type-check` passes and every fixture satisfies `RawBuilder`
    (`src/lib/sources/types.ts:38-53`).

- [ ] **Pin today's scores with a golden test — before touching `score.ts`**
  - Files: `tests/unit/lib/score.test.ts` (new)
  - Do: assert `scoreBuilders(SCORING_FIXTURES).map(b => [b.id, b.score])` equals hardcoded
    literals (not `toMatchSnapshot`, so drift shows in the diff), with `vi.setSystemTime` frozen —
    `scoreBuilders` reads `Date.now()` at `score.ts:20` and several fixtures carry
    `metadata.lastSeen`. Also assert `SOURCE_NAMES.every(s => SCORING_FIXTURES.some(f => f.source === s))`
    so the corpus can never fall behind a new connector.
  - Verify: `pnpm test tests/unit/lib/score.test.ts` passes against the current, unmodified `score.ts`.

- [ ] **Add the explanation types to `score.ts`**
  - Files: `src/lib/score.ts`
  - Do: export
    ```ts
    export type FactorBasis = 'measured' | 'client-attested' | 'default' | 'unreliable'
    export type ScoreFactorId = 'popularity' | 'recency' | 'topics' | 'source-signal' | 'profile-quality'
    export interface ScoreFactor { id: ScoreFactorId; label: string; points: number; basis: FactorBasis; inputs: Array<{ key: string; value: string | number }>; caveat?: string }
    export interface ScoreExplanation { score: number; rawTotal: number; clamped: boolean; factors: ScoreFactor[] }
    export type ScoreInput = Pick<RawBuilder, 'source' | 'topics' | 'metadata'> & Partial<Pick<RawBuilder, 'followersCount' | 'bio' | 'avatarUrl' | 'profileUrl' | 'displayName'>>
    ```
    `caveat` is required whenever `basis !== 'measured'`; `points` stays unrounded. `measured` means
    a value **BuilderHunt's server fetched** from the source; `client-attested` means it arrived in a
    browser request body — see `spec.md`'s provenance section.
  - Verify: `pnpm type-check`.

- [ ] **Add `explainScore()` and reimplement `scoreBuilders` on top of it**
  - Files: `src/lib/score.ts`
  - Do: move every branch of the current body (`score.ts:22-165`) into
    `explainScore(builder: ScoreInput, now = Date.now()): ScoreExplanation`, one factor per section,
    arithmetic byte-identical — including the uncapped `Math.log1p(followers) * 3.0` (`:32`), all
    **15** source arms (`:60-154`, the last three being `devpost`, `producthunt`, `bluesky`), and
    the `profileUrl` `+1` (`:159`) that `getScoreBreakdown` omits. Then
    `scoreBuilders = bs => { const now = Date.now(); return bs.map(b => ({ ...b, score: explainScore(b, now).score })) }`
    — one `now` for the whole batch, as today.
  - Verify: `pnpm test tests/unit/lib/score.test.ts` — the golden literals must be unchanged.

- [ ] **Label popularity per source and mark the three unreliable inputs**
  - Files: `src/lib/score.ts`
  - Do: export an exhaustive `POPULARITY_MEANING: Record<SourceName, string>` (the `Record` type,
    not a partial map, so a new source fails `pnpm type-check`) used as the popularity factor's
    label: `npm: 'top package quality score (0-1) x100,000 — not followers'` per `npm.ts:205`,
    `lobsters: 'highest score of one story'` per `lobsters.ts:176`, `stackoverflow: 'reputation'`,
    `sourcehut: 'not reported'`, `gitlab: 'total stars across projects (no follower count exists)'`
    per `gitlab.ts:144`, `devpost: 'not reported'`, `producthunt: 'total votes across launches'`,
    `bluesky: 'followers'`, … Set `basis: 'unreliable'` + caveat for `stackoverflow` recency
    (`stackoverflow.ts:213` stamps `Date.now()`), `hn` topics (`hn.ts:128` echoes the query),
    `reddit` topics (`reddit.ts:114`); `basis: 'default'` for the neutral `+5` recency branch
    (`score.ts:51`).
  - Verify: `pnpm test tests/unit/lib/score.test.ts` asserts a basis per source and a non-empty `caveat`
    on every non-`measured` factor.

- [ ] **Assert factors reconcile with the ring**
  - Files: `tests/unit/lib/score.test.ts`
  - Do: per fixture assert `clamp(0,100,round(sum(factors.points))) === explanation.score ===
    scoreBuilders([b])[0].score`, and `clamped === (rawTotal > 100 || rawTotal < 0)`.
  - Verify: `pnpm test tests/unit/lib/score.test.ts`.

- [ ] **Delete the drifted client copy and rewire the ring tooltip**
  - Files: `src/components/ui/score-ring.tsx`, `src/components/ui/index.ts`,
    `src/modules/search/components/SearchPage.tsx`
  - Do: delete `getScoreBreakdown` (`score-ring.tsx:158`) and `MinimalBuilder` (`:147`); drop
    `getScoreBreakdown` from the `src/components/ui/index.ts:9` export and from the
    `SearchPage.tsx:8` import; retype `ScoreRing.breakdown` as `ScoreFactor[]` rendering
    label/points plus a basis marker; replace both call sites
    (`SearchPage.tsx:1404` and `:1605`) with `explainScore(builder).factors`.
  - Verify: `pnpm type-check`; `grep -rn getScoreBreakdown src/` returns nothing; `pnpm lint`.

- [ ] **Add a boundary test forbidding a second score implementation**
  - Files: `tests/unit/lib/score.test.ts`
  - Do: walk every `.ts`/`.tsx` file under `src/` (`node:fs` `readdir` with `recursive: true`) and
    assert the popularity term — regex `/log1p\([^)]*\)\s*\*\s*3(\.0)?\b/` — appears only in
    `src/lib/score.ts`.
  - Verify: `pnpm test tests/unit/lib/score.test.ts`.

## Phase 2 — Dedup provenance

- [ ] **Record merge provenance in `deduplicateBuilders`**
  - Files: `src/lib/sources/types.ts`, `src/lib/dedup.ts`
  - Do: declare `export interface MergedIdentity { source: SourceName; sourceId: string; profileUrl:
    string }` in `types.ts` (its home is beside `RawBuilder`, so the evidence layer can depend on it
    rather than the reverse) and add optional `mergedFrom?: MergedIdentity[]` to `RawBuilder`. In the
    merge branch (`dedup.ts:12-24`) set it to the surviving identity plus each folded-in row's
    identity, so `mergedFrom.length >= 2` whenever a merge happened and is `undefined` otherwise.
    Leave every other merge rule byte-identical.
  - Verify: `pnpm type-check`.

- [ ] **Prove dedup provenance does not change ranking**
  - Files: `tests/unit/lib/dedup.test.ts` (new)
  - Do: assert `sortByScore(scoreBuilders(deduplicateBuilders(SCORING_FIXTURES)))` yields the id
    order and scores captured before the change (reuse the Phase 1 golden literals); add a
    github+lobsters same-handle case and assert `mergedFrom.length === 2` while `source`, `id` and
    `profileUrl` still come from the first row (`dedup.ts:15`).
  - Verify: `pnpm test tests/unit/lib/dedup.test.ts`.

- [ ] **Pass `mergedFrom` through the search response**
  - Files: `src/routes/api/search/builders.ts`, `src/modules/search/components/SearchPage.tsx`
  - Do: the route already spreads the scored builder (`builders.ts:84`) so the field flows through
    — add `mergedFrom?: MergedIdentity[]` to the page-local `Builder` interface
    (`SearchPage.tsx:20-42`) so it is typed rather than accidental. Do not add it to the
    `/api/builders/track` request body (`TrackBody`, `track.ts:18-38`).
  - Verify: `pnpm type-check`, then with `pnpm dev` running:
    `curl -s localhost:3000/api/search/builders -H 'content-type: application/json' -d
    '{"keywords":"rust","sources":["github","lobsters"],"perPage":30}' | jq
    '[.builders[]|select(.mergedFrom)]|length'` returns a number; record the response byte size
    (`curl -s … | wc -c`) as the Phase 6 baseline.

## Phase 3 — Canonical links and per-source evidence extraction (pure)

- [ ] **Extract the source host allowlist into a client-safe module**
  - Files: `src/lib/sources/canonical-links.ts` (new), `src/shared/lib/security/url-policy.ts`
  - Do: move `builderProfileHosts` (`url-policy.ts:46-59`) into `canonical-links.ts` as
    `export const SOURCE_HOSTS: Record<SourceName, string[]>`, widening it from its current 12 keys
    to all 15 by adding `devpost: ['devpost.com']` (`src/lib/devpost/worker.ts:100`),
    `producthunt: ['producthunt.com']` (`producthunt.ts:135`) and `bluesky: ['bsky.app']`
    (`bluesky.ts:78`). This does not change `isAllowedBuilderProfileUrl`'s behaviour for any
    existing caller: its only caller is `TrackBody`'s `.refine` (`track.ts:35`), and `TrackBody`'s
    `source` enum (`track.ts:19-22`) rejects those three sources before the refine runs. Add pure
    `isSourceUrl(source, url)` (https only, no credentials, host `=== allowed` or
    `endsWith('.' + allowed)` — same predicate as `url-policy.ts:61-71`) and
    `resolveEvidenceUrl(source, candidate?, profileUrl?)` (item URL → profile URL → `undefined`).
    `url-policy.ts` imports `SOURCE_HOSTS`; `canonical-links.ts` must import nothing from `node:*`.
  - Verify: `pnpm test tests/unit/shared/lib/security/url-policy.test.ts` still passes unchanged;
    `pnpm type-check`; `grep -n "node:" src/lib/sources/canonical-links.ts` returns nothing.

- [ ] **Test the link resolver against every source**
  - Files: `tests/unit/lib/sources/canonical-links.test.ts` (new)
  - Do: loop `SOURCE_NAMES` and assert a legitimate `https://{host}/x` profile URL passes for each,
    and that `https://evil.example/github.com`, `http://github.com/x`, `https://u:p@github.com/x`,
    `https://notgithub.com/x` and non-URL input all return `undefined`. Assert
    `Object.keys(SOURCE_HOSTS).sort()` equals `[...SOURCE_NAMES].sort()`.
  - Verify: `pnpm test tests/unit/lib/sources/canonical-links.test.ts`.

- [ ] **Promote `getMatchHighlights` out of the page component**
  - Files: `src/lib/evidence/query-match.ts` (new), `tests/unit/lib/evidence/query-match.test.ts` (new),
    `src/modules/search/components/SearchPage.tsx`
  - Do: move `getMatchHighlights` (`SearchPage.tsx:1296-1340`) verbatim, retyped against a minimal
    structural input (`{ topics?: string[]; displayName?: string; username: string; bio?: string }`)
    instead of the page-local `Builder`; import it back into `SearchPage.tsx` (used at `:466`,
    `:1347` and `:1509`).
  - Verify: `pnpm test tests/unit/lib/evidence/query-match.test.ts` covers topic/name/handle/bio and the
    empty-query case; `pnpm type-check`.

- [ ] **Define the evidence view model**
  - Files: `src/lib/evidence/model.ts` (new)
  - Do: export
    ```ts
    export type EvidenceKind = 'story' | 'post' | 'package' | 'repo' | 'model' | 'launch' | 'answer' | 'activity' | 'profile'
    export interface EvidenceItem { kind: EvidenceKind; title: string; url?: string; occurredAt?: string; count?: number; basis: FactorBasis; caveat?: string }
    export type { MergedIdentity } from '~/lib/sources/types' // declared in Phase 2, re-exported here
    export interface MatchEvidence { source: SourceName; username: string; profileUrl?: string; observedAt: string; freshness: 'live' | 'snapshot'; provenance: 'server-fetched' | 'client-attested-track'; popularityMeaning: string; queryMatches: { terms: string[]; fields: Array<'topic' | 'name' | 'handle' | 'bio'> }; factors: ScoreFactor[]; items: EvidenceItem[]; coverage: { measured: number; attested: number; defaulted: number; unreliable: number }; ambiguity?: { mergedFrom: MergedIdentity[] } }
    ```
  - Verify: `pnpm type-check`.

- [ ] **Implement the per-source evidence extractors**
  - Files: `src/lib/evidence/extract.ts` (new)
  - Do: `extractEvidenceItems(builder): EvidenceItem[]`, keyed by
    `Record<SourceName, (b) => EvidenceItem[]>` so a new source fails `pnpm type-check` rather than
    falling through. Read only the keys listed in `spec.md`'s source table:
    `lobsters.sampleTitles`/`representativeUrl`, `producthunt.launches[{name,tagline,votesCount,url}]`,
    `hn.matchCount`/`submittedCount`, `devto.articlesCount`/`reactions`,
    `stackoverflow.postCount`/`postScore`/`matchedTags`, `npm.packageCount`/`maintainerCount`,
    `huggingface.modelCount`/`totalLikes`/`pipelines`, `gitlab.projectCount`/`totalForks`,
    `codeberg.stars`/`forks`/`openIssues`/`starredRepos`, `github.stars`/`issues`/`watchers`/`publicRepos`,
    `hashnode.postCount`, `reddit.activeUsers`, `sourcehut.location`, `devpost.projectsCount`,
    `bluesky.postsCount`/`followsCount`/`customDomainHandle`. **Never** emit `devto.github`,
    `devto.twitter`, `producthunt.twitterUsername` or `bluesky.did` — off-platform identity, see
    `spec.md` Privacy. Gate every emission on the **value**, not the key: `typeof v === 'number' &&
    Number.isFinite(v)`, `typeof v === 'string' && v.length > 0`, `Array.isArray(v) && v.length > 0`
    — `github.ts:66` writes keys whose values are `undefined` at runtime. Only
    `lobsters.representativeUrl` and `producthunt.launches[].url` may yield an item `url`, and only
    via `resolveEvidenceUrl`.
  - Verify: `pnpm test tests/unit/lib/evidence/extract.test.ts` (next task).

- [ ] **Test that extractors never invent evidence**
  - Files: `tests/unit/lib/evidence/extract.test.ts` (new)
  - Do: for every `SOURCE_NAMES` member assert `extractEvidenceItems({ ...fixture, metadata: {} })`
    is `[]`, and the same for the all-`undefined`-values shape
    `{ ...fixture, metadata: Object.fromEntries(Object.keys(fixture.metadata).map(k => [k, undefined])) }`.
    Assert every emitted value appears in the fixture's metadata; no item `url` is off that source's
    `SOURCE_HOSTS` entry; `occurredAt` is set only where the source returned a real timestamp (never
    `stackoverflow`); and no emitted item mentions `devto.github`, `devto.twitter`,
    `producthunt.twitterUsername` or `bluesky.did`.
  - Verify: `pnpm test tests/unit/lib/evidence/extract.test.ts`.

- [ ] **Compose and test the view model**
  - Files: `src/lib/evidence/build.ts` (new), `tests/unit/lib/evidence/build.test.ts` (new)
  - Do: `buildMatchEvidence(builder, { query?, observedAt })` — the **live-search adapter only**:
    sets `freshness: 'live'`, `provenance: 'server-fetched'`, calls `explainScore`,
    `extractEvidenceItems` and `getMatchHighlights`, reads `popularityMeaning` from
    `POPULARITY_MEANING[builder.source]`, derives `coverage`, copies `mergedFrom` into
    `ambiguity`. Tests: coverage counts sum to `factors.length`; a row with `mergedFrom.length > 1`
    has every metadata-derived factor `unreliable` and zero item `url`s; no factor is
    `client-attested` (that basis belongs to the Phase 5 adapter).
  - Verify: `pnpm test tests/unit/lib/evidence/build.test.ts`.

## Phase 4 — The panel on search

- [ ] **Build the disclosure panel component**
  - Files: `src/modules/search/components/MatchEvidencePanel.tsx` (new)
  - Do: `({ evidence })` rendering a native `<details data-testid={`match-evidence-${id}`}>` whose
    `<summary>` keeps today's "matches 'x' in topic" copy plus a coverage chip, and — only while
    open — a provenance header derived from `evidence.provenance`, the factor list, item list and
    merged-row amber notice. A `client-attested-track` panel badges every row and never renders the
    `measured` treatment; a `server-fetched` panel never renders the attested badge. Existing
    `card`/`badge`/`bh-*` utilities only; transitions behind `prefers-reduced-motion`; basis shown by
    text + icon, never colour alone; links `target="_blank" rel="noopener noreferrer"`. The
    `<summary>` must stay a bare native summary — **no** `role`, **no** hand-written `aria-expanded`,
    **no** `tabIndex`, **no** `onKeyDown` — and carry a `min-h-6 min-w-6` (24 px) utility class plus
    `py-1.5` so the WCAG 2.2 target size holds. Precedent: `src/modules/landing/components/FAQSection.tsx`.
  - Verify: `pnpm test tests/unit/modules/search/components/MatchEvidencePanel.test.tsx` (next task);
    `pnpm lint`.

- [ ] **Test the panel (happy-dom: structure and click-toggling)**
  - Files: `tests/unit/modules/search/components/MatchEvidencePanel.test.tsx` (new)
  - Do: mount with `react-dom/client` + `act`, following
    `tests/unit/components/ui/dialog.test.tsx:1-40` (this repo has no `@testing-library/react`).
    Assert: closed state renders no factor rows; `summary.click()` reveals them and a second click
    hides them (verified working in happy-dom on 2026-07-27); a `default`/`unreliable` factor
    renders its caveat; `mergedFrom` renders the notice and no item links; an empty-metadata builder
    renders the "little beyond the profile" line and no fake rows; a `client-attested-track`
    evidence object renders the "reported by their browser" header and badges every row, and a
    `server-fetched` one renders neither. Accessibility-by-construction assertions:
    `summary.getAttribute('role') === null`, `summary.getAttribute('aria-expanded') === null`,
    `summary.getAttribute('tabindex') === null`, and the summary's `className` contains the 24 px
    utility. Do **not** assert Enter/Space or `getBoundingClientRect()` here — happy-dom implements
    neither (probed 2026-07-27: a synthetic `keydown` does not toggle, and the rect is `0×0`).
    Those two move to the Phase 6 Playwright task.
  - Verify: `pnpm test tests/unit/modules/search/components/MatchEvidencePanel.test.tsx`.

- [ ] **Wire the panel into both search cards**
  - Files: `src/modules/search/components/SearchPage.tsx`
  - Do: replace the row-4 block in the page-local `PersonResultCard` (`:1473`) and
    `ResourceResultCard`'s why-this-match paragraph (`:1571`) with `<MatchEvidencePanel
    evidence={buildMatchEvidence(builder, { query, observedAt })} />`, storing the response
    timestamp in `runSearch`/`loadMore` state (`:359`, `:405`). Keep every existing `data-testid`.
  - Verify: `pnpm dev`, search "rust async runtime", expand a card: factor points sum to the ring
    value; a Stack Overflow result shows the recency caveat; a Lobsters result links to `lobste.rs`.

- [ ] **Handle semantic-search results honestly**
  - Files: `src/modules/search/components/MatchEvidencePanel.tsx`
  - Do: when `builder.similarity != null` (`SearchPage.tsx:39-41` — set only by
    `/api/search/semantic`), render the similarity plus derivable factors and a "from the local
    index — not a live source fetch in this response" line, and emit no items.
  - Verify: with a pro entitlement and the semantic toggle on
    (`data-testid="semantic-toggle"`, `SearchPage.tsx:711`), an indexed hit's panel shows that note
    and zero item rows.

## Phase 5 — Attested track-time snapshots and the profile panel

> `POST /api/builders/track` performs **no source fetch** — it forwards its own request body
> (`track.ts:67-72`). Everything this phase persists and renders is therefore `client-attested`, and
> the tasks below are ordered so that `measured` is unreachable from the snapshot path. See
> `spec.md`'s "Why the snapshot is client-attested, not an observation".

- [ ] **Grant `builder_source_snapshots` to the runtime role**
  - Files: `drizzle/<next>_builder_source_snapshots_app_grants.sql` (new),
    `drizzle/meta/_journal.json`, `drizzle/meta/<next>_snapshot.json` (new),
    `drizzle/migration-hashes.json`
  - Do: **do not hardcode a migration number.** Read the real next index from
    `drizzle/meta/_journal.json` (the last entry's `idx` + 1) and mint the empty migration with
    `pnpm exec drizzle-kit generate --custom --name builder_source_snapshots_app_grants`, which
    appends the journal entry and writes the matching `drizzle/meta/<next>_snapshot.json` for you.
    Grants-only migrations are **not** exempt from the snapshot:
    `tests/unit/shared/lib/db/migration-integrity.test.ts` compares `drizzle/*.sql` against the
    journal and the snapshot files. `drizzle/0044_abuse_usage_integrity_rls_grants.sql` is the
    correct precedent (grants-only, snapshot present). Then write the body, mirroring
    `drizzle/0025_public_tables_app_grants.sql`, with a comment recording that no grant has existed
    since `drizzle/0005_builder_normalization.sql`:
    ```sql
    GRANT SELECT, INSERT, DELETE ON TABLE builder_source_snapshots TO builderhunt_app;
    ```
    No RLS, no `TRUNCATE`, no `REFERENCES` (no `organization_id`; the table stays
    system-operational, `docs/architecture/data-classification.md:21`). Finally regenerate the
    immutability manifest: `node scripts/db/verify-migration-integrity.mjs --write` rewrites
    `drizzle/migration-hashes.json`, which the same script compares on every run
    (`verify-migration-integrity.mjs:28-35`) and fails with "Migration hash manifest mismatch"
    without.
  - Verify: `pnpm exec drizzle-kit check` passes; `pnpm test:migration-integrity` and
    `pnpm test tests/unit/shared/lib/db/migration-integrity.test.ts` stay green;
    `pnpm db:migrate` applies cleanly on a fresh DB.

- [ ] **Add the snapshot repository**
  - Files: `src/shared/lib/repositories/builder-snapshots.ts` (new)
  - Do: on `publicDb` (`~/shared/lib/db/client`, `client.ts:53` — the `builderhunt_app` role),
    mirroring `src/shared/lib/repositories/public-builders.ts`:
    `recordBuilderSourceSnapshot({ builderIdentityId, payload })` — sha256 of the canonicalised
    payload (stable key order) as `contentHash`, `onConflictDoNothing` on the
    `builder_source_snapshots_identity_hash_unique` index (`schema.ts:174`), then delete rows
    outside the 10 newest `observed_at` for that identity; and
    `findBuilderSourceSnapshots(builderIdentityId, limit)` ordered `observed_at desc` (served by
    `builder_source_snapshots_identity_observed_idx`, `schema.ts:175`). The payload is a zod envelope
    that separates provenance by construction — public fields only, no tenant data:
    ```ts
    { version: 1, provenance: 'client-attested-track',
      serverVerified: { source, sourceId, profileUrl, recordedAt },   // profileUrl host-checked at track time
      attested: { username, displayName?, bio?, avatarUrl?, followersCount?, language?, country?, topics, metadata } }
    ```
    `provenance` is `z.literal('client-attested-track')` on write — nothing may persist
    `'server-fetched'` yet. Both functions require the grant shipped by the previous task
    (`SELECT, INSERT, DELETE`); no other grant is needed.
  - Verify: `pnpm test tests/unit/shared/lib/repositories/builder-snapshots.test.ts` (next task).

- [ ] **Test the snapshot repository against a real database**
  - Files: `tests/unit/shared/lib/repositories/builder-snapshots.test.ts` (new)
  - Do: use `src/shared/lib/db/create-disposable-test-database.ts` like the sibling repository tests
    (`tests/unit/shared/lib/repositories/organization-builders.test.ts` is the closest shape).
    Assert: identical payload twice → one row; changed payload → two; the 11th insert prunes the
    oldest and leaves exactly 10; a malformed envelope is rejected before insert; an envelope whose
    `provenance` is not `'client-attested-track'` is rejected.
  - Verify: `pnpm test tests/unit/shared/lib/repositories/builder-snapshots.test.ts`.

- [ ] **Record an attested snapshot when a builder is tracked**
  - Files: `src/routes/api/builders/track.ts`
  - Do: alongside the existing fire-and-forget `upsertEmbeddingStubs(...)` (`track.ts:86`), call
    `recordBuilderSourceSnapshot` with `builderIdentityId = sha256(\`${source}\0${sourceId}\`)` —
    the same derivation `trackOrganizationBuilder` uses at
    `src/shared/lib/repositories/organization-builders.ts:278`, so the FK resolves to the row that
    call just created. Skip when `select is_builder_processing_restricted($1)` is true (pattern:
    `src/shared/lib/repositories/enrichment.ts:187`; the function is `EXECUTE`-granted to
    `builderhunt_app` at `drizzle/0017_enrichment_rls_policies.sql:82`). Chain
    `.catch(err => log.error('snapshot_writethrough_error', { error: err instanceof Error ? err.message : String(err) }))`;
    never awaited into the response. Split `parsed.data` into the envelope's `attested` group and set
    `serverVerified` from the server's own values only (`recordedAt = new Date()`) — never copy a
    client field into `serverVerified` beyond the already-host-checked `profileUrl` and the
    enum-validated `source`.
  - Verify: with `pnpm dev`, track a builder, then
    `psql "$DATABASE_URL" -c "select count(*) from builder_source_snapshots"` is 1; track the same
    builder again unchanged and it stays 1.

- [ ] **Add the attested snapshot adapter — the never-`measured` boundary**
  - Files: `src/lib/evidence/attested.ts` (new)
  - Do: `buildAttestedMatchEvidence(snapshot: AttestedSnapshot, { observedAt })` — a **second**
    adapter, deliberately not an option on `buildMatchEvidence`. It takes the envelope type (not
    `ScoreInput`), sets `freshness: 'snapshot'` and `provenance: 'client-attested-track'`, and maps
    every basis through `attestedBasis(b: FactorBasis)` which returns `'client-attested'` for
    `'measured'` and passes `'default'`/`'unreliable'` through. Type the return so `measured` is
    unrepresentable: `Omit<MatchEvidence,'factors'|'items'> & { factors: AttestedFactor[]; items:
    AttestedItem[] }` where those aliases narrow `basis` to `Exclude<FactorBasis,'measured'>`.
  - Verify: `pnpm type-check` (it fails if a `measured` factor is constructed in this module);
    `pnpm test tests/unit/lib/evidence/attested.test.ts` (next task).

- [ ] **Prove no snapshot-derived row can ever say `measured`**
  - Files: `tests/unit/lib/evidence/attested.test.ts` (new)
  - Do: run every `SCORING_FIXTURES` entry through the envelope and `buildAttestedMatchEvidence`, and
    assert **exhaustively** that no factor and no item has `basis: 'measured'`, that
    `coverage.measured === 0`, and that `provenance === 'client-attested-track'`. Include a hostile
    fixture with `followersCount: 9_999_999` to show an inflated client value renders as
    `client-attested`, not evidence. This is the plan's guard test — reference it in the PR.
  - Verify: `pnpm test tests/unit/lib/evidence/attested.test.ts`.

- [ ] **Add the profile evidence endpoint**
  - Files: `src/routes/api/builders/$builderId/match-evidence.ts` (new)
  - Do: `GET` only. Deliberately a sibling of the existing tenant-private
    `src/routes/api/builders/$builderId/evidence/` namespace, not a child — different data class.
    `requireTenantPrincipal` → `withTenantContext` → `findOrganizationBuilderByEitherId`
    (`src/shared/lib/repositories/organization-builders.ts:183`); a miss returns the **same**
    `404 { error: 'Builder not found' }` as `src/routes/api/builders/$builderId.ts:95`. Then
    `isSuppressed(source, sourceId)` (`src/shared/lib/profile-suppression.ts:47`) or an active
    `is_builder_processing_restricted` → `{ available: false, reason: 'restricted' }`; no row →
    `'no-snapshot'` (plus identity-level facts from `builder_identities`, which
    `builderhunt_app` may `SELECT` per `drizzle/0011_builder_claim_policies.sql:31`); zod failure →
    `'unreadable-snapshot'`; else `buildAttestedMatchEvidence(envelope, { observedAt: row.observedAt })`
    — never `buildMatchEvidence` — projected through an explicit `MatchEvidenceDTO` allowlist. Never
    read `privateMetadata`. `await rateLimit('match-evidence', getAuthedRateLimitId({ userId:
    principal.userId, organizationId: principal.organizationId }), 60, 60)`
    (`src/shared/lib/rate-limit.ts:44`, `:136`).
  - Verify: `pnpm security:route-coverage` passes (the route is guarded, so no allowlist entry is
    needed); with `pnpm dev`, `curl -i -b "$COOKIE" localhost:3000/api/builders/$ID/match-evidence`
    → 200 with `"freshness":"snapshot"`; anonymous → 401; another org's identity → byte-identical
    404 to an unknown id.

- [ ] **Add a route test for the endpoint**
  - Files: `tests/unit/routes/api/builders/match-evidence.test.ts` (new)
  - Do: follow `tests/unit/routes/api/scheduling/invitations/invitations.test.ts:19-32` — mock
    `requireTenantPrincipal`, redirect `withTenantContext` at a real disposable-Postgres
    transaction, leave the repositories real. Cover: tracked identity with a snapshot → 200,
    `freshness: 'snapshot'`, `provenance: 'client-attested-track'`, and **no** `measured` anywhere in
    the body; tracked identity with no snapshot → `{ available: false, reason: 'no-snapshot' }`;
    a stored payload that fails the zod envelope → `'unreadable-snapshot'`; a restricted identity →
    `'restricted'`; an identity tracked by another organization → 404 with a body byte-identical to
    an unknown id.
  - Verify: `pnpm test tests/unit/routes/api/builders/match-evidence.test.ts`.

- [ ] **Mount the panel on the builder profile**
  - Files: `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: fetch `/api/builders/${builderId}/match-evidence` in the existing mount `Promise.all`
    (`:91`) and render `MatchEvidencePanel` directly above `HygieneCard` (`:325`), captioned
    "recorded {date} when a teammate tracked this builder — reported by their browser, not
    re-checked against {source}". Render an honest empty state for each `available: false` reason;
    never fall back to `builder.metadata`.
  - Verify: `pnpm dev` — a builder tracked after Phase 5 shows the tracking date and a
    `client-attested` badge on every row; one tracked earlier shows "nothing recorded yet".

- [ ] **Prove tenant isolation on the new route**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: add `async function checkMatchEvidence()` following the shape of
    `checkPublicNonTenantTableGrants` (`:399-424`) and register it in `main()` (`:1223`). Checks:
    `GET /api/builders/:id/match-evidence` anonymous (401); tenant A's identity requested by tenant
    B (404, body identical to unknown id); an untracked identity (404); plus a direct
    `publicDb.insert(builderSourceSnapshots)` + read-back as `builderhunt_app` (must now succeed,
    proving the grant) and a `delete` (proving the prune path's grant).
  - Verify: `pnpm test:api-isolation:local` — all checks pass, including the new ones.

## Phase 6 — Gating, retention, accessibility gate, docs

- [ ] **Gate the attested-history timeline on the entitlement**
  - Files: `src/routes/api/builders/$builderId/match-evidence.ts`,
    `tests/unit/routes/api/builders/match-evidence.test.ts`
  - Do: inside the existing `withTenantContext` transaction call
    `getOrganizationEntitlement(tx, principal.organizationId)`
    (`src/shared/lib/repositories/entitlements.ts:78`) and gate on `entitlement.tier === 'free'` →
    newest snapshot only; any other tier (`pro`, `team`, `pro_max`) → up to 10 as
    `history: Array<{ recordedAt, followersCount, topicCount }>`, every entry client-attested. Do
    **not** route this through `resolveLegacyPlanTier` — it collapses `pro_max` into `team`
    (`entitlements.ts:49-51`) and buys this feature nothing. Add no entitlement column and no
    `PLAN_LIMITS` key; `STRIPE_BILLING_ENABLED` stays `false` (`src/shared/lib/env.ts:141`) and
    nobody is billed.
  - Verify: `pnpm test tests/unit/routes/api/builders/match-evidence.test.ts` — with no
    `organization_entitlements` row (which `resolveEntitlementPolicy` resolves to `free`) the
    response has no `history`; after inserting a row with `tier: 'pro'` for the same organization it
    does, capped at 10.

- [ ] **Render the timeline and its upgrade hint**
  - Files: `src/modules/search/components/MatchEvidencePanel.tsx`,
    `tests/unit/modules/search/components/MatchEvidencePanel.test.tsx`
  - Do: with `history.length > 1` render a compact "reported followers +240 since 12 Jun" delta line
    — the word *reported*, never *grew*, since it is a delta between two client-attested claims; when
    the field is absent render a single "Track history is a Pro feature" link to `/pricing` — no fake
    sparkline, no placeholder numbers.
  - Verify: `pnpm test tests/unit/modules/search/components/MatchEvidencePanel.test.tsx` covers both.

- [ ] **Add the browser-only accessibility assertions (keyboard + target size)**
  - Files: `tests/e2e/match-evidence-panel.spec.ts` (new)
  - Do: this is the half `happy-dom` cannot do. Sign in with the e2e harness
    (`tests/e2e/harness/auth.ts`), then intercept the client fetch with
    `page.route('**/api/search/builders', route => route.fulfill({ json: { builders: [FIXTURE],
    page: 1, perPage: 30, hasMore: false } }))` — deterministic, and it respects the suite's
    external-egress ban (`tests/e2e/harness/fakes/egress.ts`), which would otherwise make every
    connector return `[]`. Run a search, then assert: `<summary>` is reachable with `Tab`;
    `Enter` toggles `details.open`; `Space` toggles it back; focus stays on the `<summary>` after
    each toggle; and `summary.boundingBox()` is `>= 24` on both axes.
  - Verify: `pnpm test:e2e tests/e2e/match-evidence-panel.spec.ts`.

- [ ] **Confirm the axe gate is clean with the panel expanded**
  - Files: `tests/regression/test-accessibility.mjs`
  - Do: `/search` is already in `AUTH_ROUTES` (`test-accessibility.mjs:53`). Before the axe run for
    that route, expand any rendered `details[data-testid^="match-evidence-"]` so the panel body is
    in the accessibility tree rather than collapsed out of it, and add `/builders/:id` for the
    seeded admin's first tracked builder. Grant no new entry in `EXPECTED_EXCEPTIONS`.
  - Verify: `pnpm dev` running with `pnpm db:seed:admin` applied, then `pnpm test:a11y` reports zero
    `critical`/`serious` violations.

- [ ] **Update the architecture docs (security-policy release gate 9)**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: keep `builder_source_snapshots` system-operational (row at
    `data-classification.md:21`) but record its now-real writer (`POST /api/builders/track`), reader
    (`GET /api/builders/:id/match-evidence`), the 10-row retention bound, the public-fields-only
    envelope, and explicitly that stored values are **client-attested, not server-observed**
    (`provenance` discriminant); add the new route to the authorization matrix with its principal
    requirement, tracked-by-org precondition and entitlement-gated `history` field, next to the
    existing tenant-private `/api/builders/:id/evidence` entries so the two are not confused.
  - Verify: `grep -n match-evidence docs/architecture/*.md` matches both files; `pnpm lint` passes.

- [ ] **File the connector defects the panel exposes**
  - Files: `plans/phase-1/audit-trust/tasks.md`
  - Do: add five unchecked findings with file:line citations — `stackoverflow.ts:213` synthetic
    `lastSeen` inflates recency by up to 25 points on every SO result; `hn.ts:128` echoes query terms
    as `topics`, making the topics factor circular; `reddit.ts:114` maps `t2` accounts using a
    `subreddit` field its own interface nests elsewhere; `dedup.ts:7` merges across all 15 sources on
    lowercased handle; `TrackBody` (`track.ts:18-38`) accepts unvalidated `followersCount`/`metadata`
    from the client. Do **not** fix them here — each changes ranking for every affected result.
    (This is the plan's only edit outside its own directory; flag it in the PR description.)
  - Verify: `plans/phase-1/audit-trust/tasks.md` contains five new `- [ ]` items with citations.

- [ ] **Final gate**
  - Files: none
  - Do: run the full suite and confirm the search payload did not grow.
  - Verify: `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm test:migration-integrity`,
    `pnpm security:boundaries`, `pnpm security:route-coverage`, `pnpm test:api-isolation:local` and
    `pnpm build` all pass; a 30-result `/api/search/builders` response is within 1% of the Phase 2
    baseline byte size.
