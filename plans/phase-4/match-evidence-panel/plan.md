# Why This Match — Evidence Panel (plan)

> **Status**: `pending`
> **Depends on**: nothing (pure read-only consumer of `src/lib/score.ts` and `builder_source_snapshots`). Files new connector findings against [`audit-trust`](../../implemented/52-audit-trust/spec.md) and must respect [`project-hygiene`](../../implemented/05-project-hygiene/spec.md) (no synthetic evidence presented as measured fact).
> **Blocks**: [`jd-to-candidates-matching`](../jd-to-candidates-matching/spec.md) (soft — that plan reuses this panel to explain per-JD match reasons); [`browser-extension-overlay`](../browser-extension-overlay/spec.md) (soft — it reads `src/lib/score.ts`, so land Phase 1 first)
> **Reality check**: `src/lib/score.ts` returns one integer and now branches over **15** sources; `getScoreBreakdown` (`src/components/ui/score-ring.tsx:158`) is a drifted second copy feeding the ring tooltip; `SearchPage.tsx:1408` already renders a one-line "why this match"; `builder_source_snapshots` is migrated (`drizzle/0005_builder_normalization.sql`) but has no reader, no writer, and no `builderhunt_app` grant.

## Phases (dependency order — shippable after each)

### Phase 1 — Freeze the score, then decompose it

The refactor must be provably behaviour-preserving before anything is built on it.

1. Write a golden test that pins today's `scoreBuilders` output for a fixture corpus covering all
   **15** sources × both `kind`s, including the degenerate `metadata: {}`,
   `metadata: { publicRepos: undefined }` and `followersCount: undefined` shapes that GitHub person
   results actually produce at runtime.
2. Add `ScoreInput`, `ScoreFactor`, `FactorBasis`, `ScoreExplanation` and `explainScore()` to
   `src/lib/score.ts`; reimplement `scoreBuilders` as a thin wrapper over it. Same file, one
   implementation, no new module — that is what makes drift structurally impossible.
3. Encode the per-source `popularityMeaning` label table, the four-value `FactorBasis`
   (`measured | client-attested | default | unreliable`), and the three hardcoded `unreliable`
   cases (`stackoverflow` recency, `hn` topics, `reddit` topics).
4. Delete `getScoreBreakdown` and its `src/components/ui/index.ts:9` export; feed `ScoreRing`'s
   `breakdown` prop from `explainScore`.

**Ships**: the ring tooltip stops under-reporting scores. No new UI. `browser-extension-overlay`
and `jd-to-candidates-matching` can both build on `explainScore` from here.

### Phase 2 — Dedup provenance

Ordered before the evidence library because `buildMatchEvidence` consumes `mergedFrom`, and the
field does not exist in `RawBuilder` today.

1. Add `MergedIdentity` and an optional `mergedFrom?: MergedIdentity[]` to
   `src/lib/sources/types.ts` (its home is next to `RawBuilder`, not in the evidence layer);
   `deduplicateBuilders` records `{ source, sourceId, profileUrl }` for every row it folds in,
   including the surviving one.
2. Prove ranking is untouched: a test asserts identical scores and identical order for a fixture
   with and without collisions.
3. Pass `mergedFrom` through the `/api/search/builders` response (allowlisted field).

**Ships**: the search response gains one small, honest field; nothing renders it yet.

### Phase 3 — Canonical links and per-source evidence extraction (pure)

1. Extract the source→host allowlist out of `src/shared/lib/security/url-policy.ts:46` into a
   client-safe `src/lib/sources/canonical-links.ts` (new), widened from 12 to an exhaustive 15 entries;
   `url-policy.ts` imports it so there stays exactly one allowlist. Add `resolveEvidenceUrl`.
2. Promote `getMatchHighlights` out of `SearchPage.tsx:1296` into `src/lib/evidence/query-match.ts` (new)
   (unchanged behaviour, now testable); `SearchPage.tsx` imports it.
3. Add `src/lib/evidence/extract.ts` (new) — one small pure extractor per source, driven strictly by the
   source table in `spec.md`. An extractor emits nothing when its metadata **value** is missing or
   `undefined` (key presence is not enough — see the GitHub note in `spec.md`).
4. Add `buildMatchEvidence()` composing explanation + items + coverage counts into `MatchEvidence`,
   downgrading every metadata-derived factor to `unreliable` when `mergedFrom` is present.

**Ships**: a fully tested pure library with no caller. Zero runtime change.

### Phase 4 — The panel on search

1. `src/modules/search/components/MatchEvidencePanel.tsx` (new) — native `<details>`/`<summary>`, body
   rendered only while open, factor rows with basis labels, item rows with validated links,
   coverage line, merged-row notice, reduced-motion guard, ≥24×24 px summary target.
2. Replace `SearchPage.tsx`'s row 4 (line 1473) and `ResourceResultCard`'s why-this-match paragraph
   (line 1571) with the panel, keeping today's copy as the `<summary>` text and existing
   `data-testid`s intact.
3. Component tests in `happy-dom`: factor rendering, empty metadata, merged notice, no
   off-allowlist link, click open/close. Keyboard activation and target size are deferred to
   Phase 6's Playwright gate — `happy-dom` implements neither.

**Ships**: the feature, for search, with no server change at all.

### Phase 5 — Attested track-time snapshots and the profile panel

`POST /api/builders/track` does **no source fetch** — it forwards its own request body
(`track.ts:67-72`, `parsed.data`). So a snapshot written there is client-attested, not observed, and
this phase is built so that it cannot be labelled otherwise. See `spec.md`'s "Why the snapshot is
client-attested, not an observation".

1. Grants migration for `builder_source_snapshots` (`SELECT, INSERT, DELETE` to `builderhunt_app`),
   mirroring `drizzle/0025_public_tables_app_grants.sql`. **Minted with
   `pnpm exec drizzle-kit generate --custom`** so the journal entry and the `meta/NNNN_snapshot.json`
   are written by the tool, then the SQL body is hand-written and
   `drizzle/migration-hashes.json` regenerated. No RLS — the table has no `organization_id` and
   keeps its system-operational class.
2. `src/shared/lib/repositories/builder-snapshots.ts` (new) on `publicDb`:
   `recordBuilderSourceSnapshot` (content-hash dedup, prune to the 10 newest) and
   `findBuilderSourceSnapshots`. The stored envelope splits `serverVerified` (source, sourceId,
   host-checked `profileUrl`, server `recordedAt`) from `attested` (everything else) and carries
   `provenance: 'client-attested-track'`.
3. Fire-and-forget snapshot write in `POST /api/builders/track`, next to `upsertEmbeddingStubs`
   (`track.ts:86`), skipping identities with an active processing restriction.
4. `src/lib/evidence/attested.ts` (new) — the snapshot adapter. Takes `AttestedSnapshot` (a type distinct
   from the live adapter's `ScoreInput`) and emits only `client-attested | default | unreliable`.
   `measured` is unreachable from it, and a test asserts that exhaustively.
5. `GET /api/builders/$builderId/match-evidence`: tenant principal required, identity must be
   tracked by that organization, zod-parsed payload, DTO allowlist, and the
   `no-snapshot` / `restricted` / `unreadable-snapshot` unavailable states.
6. Mount the same panel on `BuilderProfilePage.tsx` above `HygieneCard` (line 325), captioned with
   the tracking date and the "reported by their browser, not re-checked" provenance line.
7. Extend `scripts/db/verify-api-isolation-local.mjs` for the new route and the new grant.

**Ships**: the profile-page panel, honestly labelled, and `builder_source_snapshots` gets its first
data.

### Phase 6 — Gating, retention, accessibility gate, docs

1. Entitlement gate on the attested-history timeline (`entitlement.tier === 'free'` → latest
   snapshot only; anything else → up to 10). Its copy says "reported followers +240", never "grew".
2. Retention assertion test: the 11th snapshot for an identity prunes the oldest.
3. Playwright keyboard + axe coverage for `/search` and `/builders/:id` with the panel expanded.
4. Update `docs/architecture/data-classification.md` (snapshot table now has a reader/writer) and
   `docs/architecture/authorization-matrix.md` (new route) per `security-policy.md` release gate 9.
5. File the connector defects the panel exposes (Stack Overflow synthetic `lastSeen`, HN
   query-echo topics, Reddit `t2` field mismatch, cross-source handle merge) as follow-up findings
   in `plans/implemented/52-audit-trust/tasks.md`.

**Ships**: release-gate clean.

## Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| The `explainScore` refactor silently changes a score and reorders results | Medium | High — ranking is the product | Golden test written **first** (Phase 1 step 1) over all 15 sources and both `kind`s; the refactor is only merged when it reproduces the pinned output exactly |
| **The source count moved from 12 to 15 while this plan sat unbuilt** (`devpost`, `producthunt`, `bluesky` shipped with their own `score.ts` branches at `:137-154`) and a fixture corpus or extractor written to the old list would silently under-cover | **Already happened once** | High — a missing branch is an un-pinned score | Every enumeration in this plan is now typed `Record<SourceName, …>` rather than a hand-written list, so `pnpm type-check` fails on the next new source instead of quietly skipping it. `SOURCE_NAMES` (`src/lib/sources/types.ts:19`) is the single loop source for the fixture corpus |
| The panel exposes that Stack Overflow/HN/Reddit signals are not real, and that reads as a product regression | High | Medium | Deliberate: labelled `unreliable` with a plain-language caveat rather than hidden. Connector fixes are filed as findings, not silently bundled — fixing them changes every score |
| **Client-supplied track data gets rendered as measured evidence** — a trust regression shipped under a trust-feature banner | Medium if unguarded | **Critical**, and the exact `project-hygiene` defect class this plan exists to close | Structural, not procedural: the snapshot adapter takes its own input type (`AttestedSnapshot`) and its basis mapping cannot return `measured`; an exhaustive test asserts no snapshot-derived factor or item is ever `measured`; the profile panel's caption and per-row badge both name the provenance |
| Someone later adds a server-side refetch and forgets to re-label, or reuses the attested adapter for fetched data | Low | High | `provenance` is a required discriminant in the stored envelope (`'client-attested-track'` today); earning `measured` requires writing `'server-fetched'`, which no current code path can produce |
| **`happy-dom` cannot verify two of the plan's accessibility promises.** Probed 2026-07-27: it toggles `<details>` on `summary.click()` but does **not** implement UA keyboard activation of `<summary>`, and `getBoundingClientRect()` returns `0×0` | Certain | Medium — a vitest assertion would pass for the wrong reason and certify nothing | Split the gate by capability: structure and click-toggling in `tests/unit/**`; Enter/Space activation and the ≥24×24 CSS-px target in Playwright (`tests/e2e/`) and `pnpm test:a11y`, which run a real engine |
| `mergedFrom` grows the search response for handle-heavy queries | Low | Low | Three short fields per merged identity, only present when a merge happened; measured before/after in Phase 2 |
| `builder_source_snapshots` write fails against the real `builderhunt_app` role (no grant has ever existed) | High if the grants migration is skipped | Medium — silent no-op, exactly the `0025` bug class | Grant migration and the isolation-script check are in the same phase as the first write; the write is fire-and-forget and logs on failure |
| `/api/builders/$builderId/match-evidence` becomes a global identity-enumeration oracle | Medium | High | Tenant principal required, tracked-by-this-org check under `withTenantContext`, identical 404 body for unknown and untracked identities, negative tenant A/B test in `verify-api-isolation-local.mjs` |
| Confusing the new route with the existing tenant-private `…/$builderId/evidence/` namespace | Medium | Medium — one is global-public, one is tenant-private | Different filename (`match-evidence.ts`, a sibling not a child), different DTO, and `docs/architecture/authorization-matrix.md` records both side by side in Phase 6 |
| Snapshot payload drifts from what the extractor expects as connectors change | Medium | Low | Versioned envelope, zod-parsed on read, `unreadable-snapshot` state instead of a partial render |
| 30 `<details>` elements per page hurt render performance | Low | Low | Body renders only while open; `explainScore` is O(1) per builder and already runs server-side once per result today |
| Someone re-adds a client-side copy of the score math later | Medium | Medium | A boundary test asserts no module outside `src/lib/score.ts` contains the `log1p(x) * 3` popularity term |

## Rollback

Every phase is independently revertible and nothing is destructive.

- **Phases 1–4** are code-only, no schema, no migration. `git revert` restores the current ring
  tooltip and the one-line why-this-match row. The golden test from Phase 1 stays valuable
  regardless and should be kept even on a full revert.
- **Phase 5** adds one forward-only grants migration (plus its snapshot JSON and regenerated
  `drizzle/migration-hashes.json`) and one new route. To disable the profile panel without a
  migration, revert the `BuilderProfilePage.tsx` mount and the route file; the grant is harmless on
  its own. To stop recording snapshots, revert the two lines in
  `src/routes/api/builders/track.ts` — no data is lost and existing rows keep rendering.
- **Snapshot data** is a bounded, content-hashed history of client-attested public source data with no
  tenant coupling. It can be truncated by the schema owner at any time with no user-visible effect
  beyond the profile panel returning `no-snapshot`.
- **Phase 6** gating is one entitlement read; reverting it makes the timeline available to all
  tiers, which is a UX loosening, not a data or billing risk (`STRIPE_BILLING_ENABLED` is `false`
  everywhere and no one is billed for it).
