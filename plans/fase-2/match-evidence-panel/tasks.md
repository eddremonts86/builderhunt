# Why This Match — Evidence Panel (tasks)

> **Status**: `pending`
> **Depends on**: nothing (pure read-only consumer of `src/lib/score.ts` and `builder_source_snapshots`). Closes open findings in [`audit-trust`](../../audit-trust/spec.md) and must respect [`project-hygiene`](../../project-hygiene/spec.md) (no synthetic evidence presented as measured fact).
> **Blocks**: [`jd-to-candidates-matching`](../jd-to-candidates-matching/spec.md) (soft — that plan reuses this panel to explain per-JD match reasons)
> **Reality check**: `src/lib/score.ts` returns one integer; `getScoreBreakdown` (`src/components/ui/score-ring.tsx:158`) is a drifted second copy feeding the ring tooltip; `SearchPage.tsx:1470` already renders a one-line "why this match"; `builder_source_snapshots` is migrated (`drizzle/0005_builder_normalization.sql`) but has no reader, no writer, and no `builderhunt_app` grant.

## Phase 1 — Freeze the score, then decompose it

- [ ] **Build the 12-source scoring fixture corpus**
  - Files: `src/lib/evidence/fixtures.ts` (new)
  - Do: export `SCORING_FIXTURES: RawBuilder[]` — one `kind: 'person'` row per `SOURCE_NAMES`
    member (`src/lib/sources/types.ts:17`) plus `kind: 'repo'` rows for github/gitlab/codeberg/npm/
    huggingface, copying the exact metadata key sets each connector produces. Include degenerate
    rows: `metadata: {}`, `followersCount: undefined` (what GitHub's `/search/users` really yields
    — its `GitHubSearchUser` interface declares fields the endpoint omits), `topics: []`.
  - Verify: `pnpm type-check` passes and every fixture satisfies `RawBuilder`.

- [ ] **Pin today's scores with a golden test — before touching `score.ts`**
  - Files: `src/lib/score.test.ts` (new)
  - Do: assert `scoreBuilders(SCORING_FIXTURES).map(b => [b.id, b.score])` equals hardcoded
    literals (not `toMatchSnapshot`, so drift shows in the diff), with `vi.setSystemTime` frozen.
  - Verify: `pnpm test src/lib/score.test.ts` passes against the current, unmodified `score.ts`.

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
  - Do: move every branch of the current body into `explainScore(builder: ScoreInput, now =
    Date.now()): ScoreExplanation`, one factor per section, arithmetic byte-identical — including
    the uncapped `Math.log1p(followers) * 3.0` and the `profileUrl` `+1` that `getScoreBreakdown`
    omits. Then `scoreBuilders = bs => bs.map(b => ({ ...b, score: explainScore(b, now).score }))`.
  - Verify: `pnpm test src/lib/score.test.ts` — the golden literals must be unchanged.

- [ ] **Label popularity per source and mark the three unreliable inputs**
  - Files: `src/lib/score.ts`
  - Do: export exhaustive `POPULARITY_MEANING: Record<SourceName, string>` used as the popularity
    factor's label (`npm: 'quality score (0-1) x100,000 — not followers'` per `npm.ts:177`,
    `lobsters: 'highest score of one story'` per `lobsters.ts:176`, `stackoverflow: 'reputation'`,
    `sourcehut: 'not reported'`, …). Set `basis: 'unreliable'` + caveat for `stackoverflow` recency
    (`stackoverflow.ts:193` stamps `Date.now()`), `hn` topics (`hn.ts:128` echoes the query),
    `reddit` topics (`reddit.ts:114`); `basis: 'default'` for the neutral `+5` recency branch.
  - Verify: `pnpm test src/lib/score.test.ts` asserts a basis per source and a non-empty `caveat`
    on every non-`measured` factor.

- [ ] **Assert factors reconcile with the ring**
  - Files: `src/lib/score.test.ts`
  - Do: per fixture assert `clamp(0,100,round(sum(factors.points))) === explanation.score ===
    scoreBuilders([b])[0].score`, and `clamped === (rawTotal > 100 || rawTotal < 0)`.
  - Verify: `pnpm test src/lib/score.test.ts`.

- [ ] **Delete the drifted client copy and rewire the ring tooltip**
  - Files: `src/components/ui/score-ring.tsx`, `src/components/ui/index.ts`,
    `src/modules/search/components/SearchPage.tsx`
  - Do: delete `getScoreBreakdown` + `MinimalBuilder` and their `index.ts` exports; retype
    `ScoreRing.breakdown` as `ScoreFactor[]` rendering label/points plus a basis marker; replace
    both call sites (`SearchPage.tsx:1401` and `:1602`) with `explainScore(builder).factors`.
  - Verify: `pnpm type-check`; `grep -r getScoreBreakdown src/` returns nothing.

- [ ] **Add a boundary test forbidding a second score implementation**
  - Files: `src/lib/score.test.ts`
  - Do: scan every file under `src/` and assert the popularity term (`log1p` followed by `* 3`)
    appears only in `src/lib/score.ts`.
  - Verify: `pnpm test src/lib/score.test.ts`.

## Phase 2 — Dedup provenance

- [ ] **Record merge provenance in `deduplicateBuilders`**
  - Files: `src/lib/sources/types.ts`, `src/lib/dedup.ts`
  - Do: declare `export interface MergedIdentity { source: SourceName; sourceId: string; profileUrl:
    string }` in `types.ts` (its home is beside `RawBuilder`, so the evidence layer can depend on it
    rather than the reverse) and add optional `mergedFrom?: MergedIdentity[]` to `RawBuilder`. In the
    merge branch (`dedup.ts:11`) set it to the surviving identity plus each folded-in row's identity.
    Leave every other merge rule byte-identical.
  - Verify: `pnpm type-check`.

- [ ] **Prove dedup provenance does not change ranking**
  - Files: `src/lib/dedup.test.ts` (new)
  - Do: assert `sortByScore(scoreBuilders(deduplicateBuilders(SCORING_FIXTURES)))` yields the id
    order and scores captured before the change; add a github+lobsters same-handle case and assert
    `mergedFrom.length === 2` while `source`, `id` and `profileUrl` still come from the first row.
  - Verify: `pnpm test src/lib/dedup.test.ts`.

- [ ] **Pass `mergedFrom` through the search response**
  - Files: `src/routes/api/search/builders.ts`, `src/modules/search/components/SearchPage.tsx`
  - Do: the route already spreads the scored builder (`builders.ts:83`) so the field flows through
    — add it to the page-local `Builder` interface (`SearchPage.tsx:20`) so it is typed rather than
    accidental. Do not add it to the `/api/builders/track` request body.
  - Verify: `curl -s localhost:3000/api/search/builders -H 'content-type: application/json' -d
    '{"keywords":"rust","sources":["github","lobsters"],"perPage":30}' | jq
    '[.builders[]|select(.mergedFrom)]|length'` returns a number; record the response byte size as
    the Phase 6 baseline.

## Phase 3 — Canonical links and per-source evidence extraction (pure)

- [ ] **Extract the source host allowlist into a client-safe module**
  - Files: `src/lib/sources/canonical-links.ts` (new), `src/shared/lib/security/url-policy.ts`
  - Do: move `builderProfileHosts` (`url-policy.ts:46`) into `canonical-links.ts` as
    `SOURCE_HOSTS: Record<SourceName, string[]>`; add pure `isSourceUrl(source, url)` and
    `resolveEvidenceUrl(source, candidate?, profileUrl?)` (item URL → profile URL → `undefined`).
    `url-policy.ts` imports `SOURCE_HOSTS` so `isAllowedBuilderProfileUrl` is unchanged.
    `canonical-links.ts` must import nothing from `node:*`.
  - Verify: existing `pnpm test src/shared/lib/security` still passes; `pnpm type-check`.

- [ ] **Test the link resolver against every source**
  - Files: `src/lib/sources/canonical-links.test.ts` (new)
  - Do: per source assert a legitimate profile URL passes and that `https://evil.example/github.com`,
    `http://…`, `https://u:p@github.com/x` and non-URL input all return `undefined`.
  - Verify: `pnpm test src/lib/sources/canonical-links.test.ts`.

- [ ] **Promote `getMatchHighlights` out of the page component**
  - Files: `src/lib/evidence/query-match.ts` (new), `src/lib/evidence/query-match.test.ts` (new),
    `src/modules/search/components/SearchPage.tsx`
  - Do: move `getMatchHighlights` (`SearchPage.tsx:1293`) verbatim, retyped against a minimal
    structural input instead of the page-local `Builder`; import it back into `SearchPage.tsx`
    (used by `displayKeywords`, `PersonResultCard`, `ResourceResultCard`).
  - Verify: `pnpm test src/lib/evidence/query-match.test.ts` covers topic/name/handle/bio and the
    empty-query case; `pnpm type-check`.

- [ ] **Define the evidence view model**
  - Files: `src/lib/evidence/model.ts` (new)
  - Do: export
    ```ts
    export type EvidenceKind = 'story' | 'post' | 'package' | 'repo' | 'model' | 'answer' | 'activity' | 'profile'
    export interface EvidenceItem { kind: EvidenceKind; title: string; url?: string; occurredAt?: string; count?: number; basis: FactorBasis; caveat?: string }
    export type { MergedIdentity } from '~/lib/sources/types' // declared in Phase 2, re-exported here
    export interface MatchEvidence { source: SourceName; username: string; profileUrl?: string; observedAt: string; freshness: 'live' | 'snapshot'; provenance: 'server-fetched' | 'client-attested-track'; queryMatches: { terms: string[]; fields: Array<'topic' | 'name' | 'handle' | 'bio'> }; factors: ScoreFactor[]; items: EvidenceItem[]; coverage: { measured: number; attested: number; defaulted: number; unreliable: number }; ambiguity?: { mergedFrom: MergedIdentity[] } }
    ```
  - Verify: `pnpm type-check`.

- [ ] **Implement the per-source evidence extractors**
  - Files: `src/lib/evidence/extract.ts` (new)
  - Do: `extractEvidenceItems(builder): EvidenceItem[]`, one branch per source, reading only the
    keys listed in `spec.md`'s source table (`lobsters.sampleTitles`/`representativeUrl`,
    `hn.matchCount`, `devto.articlesCount`, `stackoverflow.postCount`/`matchedTags`,
    `npm.packageCount`, `huggingface.modelCount`, `gitlab.projectCount`, `codeberg.stars`,
    `github.stars`/`publicRepos`, `hashnode.postCount`, `reddit.activeUsers`,
    `sourcehut.location`). Return `[]` when a key is absent — never substitute a default. Only
    `lobsters.representativeUrl` may yield an item `url`, and only via `resolveEvidenceUrl`.
  - Verify: `pnpm test src/lib/evidence/extract.test.ts`.

- [ ] **Test that extractors never invent evidence**
  - Files: `src/lib/evidence/extract.test.ts` (new)
  - Do: per source assert `extractEvidenceItems({ ...fixture, metadata: {} })` is `[]`; every
    emitted value appears in the fixture's metadata; no item `url` is off that source's allowlist;
    `occurredAt` is set only where the source returned a real timestamp (never stackoverflow).
  - Verify: `pnpm test src/lib/evidence/extract.test.ts`.

- [ ] **Compose and test the view model**
  - Files: `src/lib/evidence/build.ts` (new), `src/lib/evidence/build.test.ts` (new)
  - Do: `buildMatchEvidence(builder, { query?, observedAt })` — the **live-search adapter only**:
    sets `freshness: 'live'`, `provenance: 'server-fetched'`, calls `explainScore`,
    `extractEvidenceItems` and `getMatchHighlights`, derives `coverage`, copies `mergedFrom` into
    `ambiguity`. Tests: coverage counts sum to `factors.length`; a row with `mergedFrom.length > 1`
    has every metadata-derived factor `unreliable` and zero item `url`s; no factor is
    `client-attested` (that basis belongs to the Phase 5 adapter).
  - Verify: `pnpm test src/lib/evidence/build.test.ts`.

## Phase 4 — The panel on search

- [ ] **Build the disclosure panel component**
  - Files: `src/modules/search/components/MatchEvidencePanel.tsx` (new)
  - Do: `({ evidence })` rendering a native `<details data-testid="match-evidence-{id}">` whose
    `<summary>` keeps today's "matches 'x' in topic" copy plus a coverage chip (hit area ≥24×24 px),
    and — only while open — a provenance header derived from `evidence.provenance`, the factor list,
    item list and merged-row amber notice. A `client-attested-track` panel badges every row and never
    renders the `measured` treatment; a `server-fetched` panel never renders the attested badge.
    Existing `card`/`badge`/`bh-*` utilities only; transitions behind `prefers-reduced-motion`; basis
    shown by text + icon, never colour alone; links `target="_blank" rel="noopener noreferrer"`.
  - Verify: `pnpm test src/modules/search/components/MatchEvidencePanel.test.tsx`.

- [ ] **Test the panel**
  - Files: `src/modules/search/components/MatchEvidencePanel.test.tsx` (new)
  - Do: closed state renders no factor rows; Enter on `<summary>` reveals them; a
    `default`/`unreliable` factor renders its caveat; `mergedFrom` renders the notice and no item
    links; an empty-metadata builder renders the "little beyond the profile" line and no fake rows; a
    `client-attested-track` evidence object renders the "reported by their browser" header and badges
    every row, and a `server-fetched` one renders neither.
  - Verify: `pnpm test src/modules/search/components/MatchEvidencePanel.test.tsx`.

- [ ] **Wire the panel into both search cards**
  - Files: `src/modules/search/components/SearchPage.tsx`
  - Do: replace the row-4 block in the page-local `PersonResultCard` (`:1470`) and
    `ResourceResultCard`'s why-this-match paragraph (`:1569`) with `<MatchEvidencePanel
    evidence={buildMatchEvidence(builder, { query, observedAt, freshness: 'live' })} />`, storing
    the response timestamp in `runSearch`/`loadMore` state. Keep every existing `data-testid`.
  - Verify: `pnpm dev`, search "rust async runtime", expand a card: factor points sum to the ring
    value; a Stack Overflow result shows the recency caveat; a Lobsters result links to `lobste.rs`.

- [ ] **Handle semantic-search results honestly**
  - Files: `src/modules/search/components/MatchEvidencePanel.tsx`
  - Do: when `builder.similarity != null`, render the similarity plus derivable factors and a "from
    the local index — not a live source fetch in this response" line, and emit no items.
  - Verify: with a pro plan and the semantic toggle on, an indexed hit's panel shows that note and
    zero item rows.

## Phase 5 — Attested track-time snapshots and the profile panel

> `POST /api/builders/track` performs **no source fetch** — it forwards its own request body
> (`track.ts:63-68`). Everything this phase persists and renders is therefore `client-attested`, and
> the tasks below are ordered so that `measured` is unreachable from the snapshot path. See
> `spec.md`'s "Why the snapshot is client-attested, not an observation".

- [ ] **Grant `builder_source_snapshots` to the runtime role**
  - Files: `drizzle/0046_builder_source_snapshots_app_grants.sql` (new),
    `drizzle/meta/_journal.json`, `drizzle/meta/0046_snapshot.json` (new),
    `drizzle/migration-hashes.json`
  - Do: hand-write, mirroring `drizzle/0025_public_tables_app_grants.sql`, with a comment recording
    that no grant has existed since `0005_builder_normalization.sql`:
    `GRANT SELECT, INSERT, DELETE ON TABLE builder_source_snapshots TO builderhunt_app;` No RLS (no
    `organization_id`; stays system-operational). Append journal entry `idx: 46`, `version: "7"`,
    `breakpoints: true` **and write the matching `drizzle/meta/0046_snapshot.json`**. Grants-only
    migrations are not exempt from the snapshot: `src/shared/lib/db/migration-integrity.test.ts`
    compares `drizzle/*.sql` against the journal and the snapshot files, and it went red on
    2026-07-24 when `0045_user_devices_worker_read_grant` shipped without one.
    `0044_abuse_usage_integrity_rls_grants` is the correct precedent: grants-only, snapshot present.
    Then regenerate the immutability manifest: `node scripts/db/verify-migration-integrity.mjs
    --write` rewrites `drizzle/migration-hashes.json`, which the same script compares on every run
    (`:12-15`, `:27-30`) and fails with "Migration hash manifest mismatch" without.
  - Verify: `pnpm exec drizzle-kit check` passes; `pnpm test:migration-integrity` and `pnpm vitest run
    src/shared/lib/db/migration-integrity.test.ts` stay green; `pnpm db:migrate` applies cleanly on a
    fresh DB.

- [ ] **Add the snapshot repository**
  - Files: `src/shared/lib/repositories/builder-snapshots.ts` (new)
  - Do: on `publicDb` (`../db/client`), mirroring `public-builders.ts`:
    `recordBuilderSourceSnapshot({ builderIdentityId, payload })` — sha256 of the canonicalised
    payload as `contentHash`, `onConflictDoNothing` on
    `builder_source_snapshots_identity_hash_unique`, then delete rows outside the 10 newest
    `observed_at`; and `findBuilderSourceSnapshots(builderIdentityId, limit)` ordered desc. Payload
    is a zod envelope that separates provenance by construction — public fields only, no tenant data:
    ```ts
    { version: 1, provenance: 'client-attested-track',
      serverVerified: { source, sourceId, profileUrl, recordedAt },   // profileUrl host-checked at track time
      attested: { username, displayName?, bio?, avatarUrl?, followersCount?, language?, country?, topics, metadata } }
    ```
  - Verify: `pnpm test src/shared/lib/repositories/builder-snapshots.test.ts`.

- [ ] **Test the snapshot repository against a real database**
  - Files: `src/shared/lib/repositories/builder-snapshots.test.ts` (new)
  - Do: use `src/shared/lib/db/create-disposable-test-database.ts` like the sibling repository
    tests. Assert: identical payload twice → one row; changed payload → two; the 11th insert prunes
    the oldest; a malformed envelope is rejected before insert; an envelope whose `provenance` is not
    `'client-attested-track'` is rejected (nothing can write `'server-fetched'` yet).
  - Verify: `pnpm test src/shared/lib/repositories/builder-snapshots.test.ts`.

- [ ] **Record an attested snapshot when a builder is tracked**
  - Files: `src/routes/api/builders/track.ts`
  - Do: alongside the existing fire-and-forget `upsertEmbeddingStubs(...)` (`track.ts:82`), call
    `recordBuilderSourceSnapshot` with `sha256(source \0 sourceId)` (same derivation as
    `organization-builders.ts:212`), skipped when `select is_builder_processing_restricted($1)` is
    true (pattern: `repositories/enrichment.ts:187`). `.catch(err => log.error(
    'snapshot_writethrough_error', …))`; never awaited into the response. Split `parsed.data` into the
    envelope's `attested` group and set `serverVerified` from the server's own values only — never
    copy a client field into `serverVerified`.
  - Verify: track a builder, then `psql -c "select count(*) from builder_source_snapshots"` is 1;
    track again unchanged and it stays 1.

- [ ] **Add the attested snapshot adapter — the never-`measured` boundary**
  - Files: `src/lib/evidence/attested.ts` (new)
  - Do: `buildAttestedMatchEvidence(snapshot: AttestedSnapshot, { observedAt })` — a **second**
    adapter, deliberately not an option on `buildMatchEvidence`. It takes the envelope type (not
    `ScoreInput`), sets `freshness: 'snapshot'` and `provenance: 'client-attested-track'`, and maps
    every basis through `attestedBasis(b: FactorBasis)` which returns `'client-attested'` for
    `'measured'` and passes `'default'`/`'unreliable'` through. Type the return so `measured` is
    unrepresentable: `Omit<MatchEvidence,'factors'|'items'> & { factors: AttestedFactor[]; items:
    AttestedItem[] }` where those aliases narrow `basis` to `Exclude<FactorBasis,'measured'>`.
  - Verify: `pnpm test src/lib/evidence/attested.test.ts` (next task); `pnpm type-check` fails if a
    `measured` factor is constructed in this module.

- [ ] **Prove no snapshot-derived row can ever say `measured`**
  - Files: `src/lib/evidence/attested.test.ts` (new)
  - Do: run every `SCORING_FIXTURES` entry through the envelope and `buildAttestedMatchEvidence`, and
    assert **exhaustively** that no factor and no item has `basis: 'measured'`, that
    `coverage.measured === 0`, and that `provenance === 'client-attested-track'`. Include a hostile
    fixture with `followersCount: 9_999_999` to show an inflated client value renders as
    `client-attested`, not evidence. This is the plan's guard test — reference it in the PR.
  - Verify: `pnpm test src/lib/evidence/attested.test.ts`.

- [ ] **Add the profile evidence endpoint**
  - Files: `src/routes/api/builders/$builderId/match-evidence.ts` (new)
  - Do: `GET` only. `requireTenantPrincipal` → `withTenantContext` →
    `findOrganizationBuilderByEitherId`; a miss returns the **same** `404 { error: 'Builder not
    found' }` as `$builderId.ts:78`. Then restriction → `{ available: false, reason: 'restricted' }`;
    no row → `'no-snapshot'`; zod failure → `'unreadable-snapshot'`; else
    `buildAttestedMatchEvidence(envelope, { observedAt: row.observedAt })` — never
    `buildMatchEvidence` — projected through an explicit `MatchEvidenceDTO` allowlist. Never read
    `privateMetadata`. `rateLimit('match-evidence', getAuthedRateLimitId(…), 60, 60)`.
  - Verify: `curl -i -b "$COOKIE" localhost:3000/api/builders/$ID/match-evidence` → 200 with
    `freshness: "snapshot"`; anonymous → 401; another org's identity → byte-identical 404 to an
    unknown id.

- [ ] **Mount the panel on the builder profile**
  - Files: `src/modules/builder-profile/components/BuilderProfilePage.tsx`
  - Do: fetch `/api/builders/${builderId}/match-evidence` in the existing mount `Promise.all`
    (`:54`) and render `MatchEvidencePanel` directly above `HygieneCard` (`:246`), captioned
    "recorded {date} when a teammate tracked this builder — reported by their browser, not
    re-checked against {source}". Render an honest empty state for each `available: false` reason;
    never fall back to `builder.metadata`.
  - Verify: `pnpm dev` — a builder tracked after Phase 5 shows the tracking date and a
    `client-attested` badge on every row; one tracked earlier shows "nothing recorded yet".

- [ ] **Prove tenant isolation on the new route**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: add checks for `GET /api/builders/:id/match-evidence` — anonymous (401), tenant A's identity
    requested by tenant B (404, body identical to unknown id), an untracked identity (404), plus a
    direct `INSERT`/`SELECT` on `builder_source_snapshots` as `builderhunt_app` (must now succeed,
    proving the grant).
  - Verify: `pnpm test:api-isolation:local` — all checks pass, including the new ones.

## Phase 6 — Gating, retention, accessibility gate, docs

- [ ] **Gate the attested-history timeline on the entitlement**
  - Files: `src/routes/api/builders/$builderId/match-evidence.ts`
  - Do: `getOrganizationEntitlement` + `resolveLegacyPlanTier`
    (`repositories/entitlements.ts`): free → newest snapshot only; pro/team and above → up to 10 as
    `history: Array<{ recordedAt, followersCount, topicCount }>`, every entry client-attested. Add no
    entitlement column; `STRIPE_BILLING_ENABLED` stays `false` and nobody is billed.
  - Verify: a free entitlement returns no `history`; after `setPlatformUserPlan` to pro it does —
    both covered in `builder-snapshots.test.ts`.

- [ ] **Render the timeline and its upgrade hint**
  - Files: `src/modules/search/components/MatchEvidencePanel.tsx`
  - Do: with `history.length > 1` render a compact "reported followers +240 since 12 Jun" delta line
    — the word *reported*, never *grew*, since it is a delta between two client-attested claims; when
    the field is absent render a single "Track history is a Pro feature" link to `/pricing` — no fake
    sparkline, no placeholder numbers.
  - Verify: `pnpm test src/modules/search/components/MatchEvidencePanel.test.tsx` covers both.

- [ ] **Add the panel to the accessibility gate**
  - Files: `src/modules/search/components/MatchEvidencePanel.test.tsx`
  - Do: assert `<summary>` is Tab-reachable, toggles on Enter and Space, keeps focus on itself after
    toggling, exposes no `role="button"` or hand-written `aria-expanded`, and measures ≥24×24 CSS px;
    add `/search` and `/builders/:id` with an expanded panel to the `audit-accessibility` axe matrix.
  - Verify: `pnpm test src/modules/search/components/MatchEvidencePanel.test.tsx` and `pnpm
    test:a11y` report zero new violations.

- [ ] **Update the architecture docs (security-policy release gate 9)**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: keep `builder_source_snapshots` system-operational but record its now-real writer
    (`POST /api/builders/track`), reader (`GET /api/builders/:id/match-evidence`), the 10-row
    retention bound, the public-fields-only envelope, and explicitly that stored values are
    **client-attested, not server-observed** (`provenance` discriminant); add the new route to the
    authorization matrix with its principal requirement, tracked-by-org precondition and
    entitlement-gated field.
  - Verify: both files mention `match-evidence`; `pnpm lint` passes.

- [ ] **File the connector defects the panel exposes**
  - Files: `plans/audit-trust/tasks.md`
  - Do: add four unchecked findings with file:line citations — `stackoverflow.ts:193` synthetic
    `lastSeen` inflates recency by 25 points on every SO result; `hn.ts:128` echoes query terms as
    `topics`, making the topics factor circular; `reddit.ts:104-115` maps `t2` accounts using fields
    Reddit nests under `data.subreddit`; `dedup.ts:6` merges across sources on lowercased handle.
    Do **not** fix them here — each changes ranking for every affected result.
  - Verify: `plans/audit-trust/tasks.md` contains four new unchecked items with citations.

- [ ] **Final gate**
  - Files: none
  - Do: run the full suite and confirm the search payload did not grow.
  - Verify: `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm test:api-isolation:local` and
    `pnpm build` all pass; a 30-result `/api/search/builders` response is within 1% of the Phase 3
    baseline.
