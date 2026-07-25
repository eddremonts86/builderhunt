# Why This Match — Evidence Panel (spec)

> **Status**: `pending`
> **Depends on**: nothing (pure read-only consumer of `src/lib/score.ts` and `builder_source_snapshots`). Closes open findings in [`audit-trust`](../../audit-trust/spec.md) and must respect [`project-hygiene`](../../project-hygiene/spec.md) (no synthetic evidence presented as measured fact).
> **Blocks**: [`jd-to-candidates-matching`](../jd-to-candidates-matching/spec.md) (soft — that plan reuses this panel to explain per-JD match reasons)
> **Reality check**: `src/lib/score.ts` returns a single clamped integer per builder with no breakdown. A second, **already-drifted** copy of the math lives in `getScoreBreakdown` (`src/components/ui/score-ring.tsx:158`) and feeds the ring tooltip. `SearchPage.tsx` already renders a one-line "why this match" (`getMatchHighlights`, line 1293; row 4 at line 1470). `builder_source_snapshots` exists (`src/shared/lib/db/schema.ts:163`, created in `drizzle/0005_builder_normalization.sql`) but has **zero readers, zero writers, and no `builderhunt_app` grant** — it is empty everywhere.

## Problem

Every result card shows a 0–100 score ring and one line of "matches 'rust' in topic". Neither is
inspectable, and both are less honest than they look.

1. **The tooltip breakdown is a second implementation of the score, and it has already drifted.**
   `getScoreBreakdown` caps popularity at 30 while `scoreBuilders` never caps it (1M followers ⇒
   `log1p(1e6)*3 ≈ 41`), omits the `profileUrl` quality point, and omits the entire source-specific
   branch (`score.ts:59-137` — nominally 0–15, but the Stack Overflow arm reaches 20 at `:88-96`
   and the reddit/hn arms at `:72`/`:75` are uncapped logarithms). Realistic under-reporting is
   ≈14 points for a high-star GitHub repo (capped popularity + the missing `profileUrl` +1 + the
   omitted +4 star-ratio bonus) and more than 20 for a multi-tag Stack Overflow person. This is the
   exact failure mode `project-hygiene` was written for.
2. **Several score inputs are not what they claim.** Verified in `src/lib/sources/`:
   `stackoverflow.ts:193` sets `metadata.lastSeen = Date.now()`, so every Stack Overflow result
   collects the full 30 recency points for being "active today". `hn.ts:128` sets `topics: keywords`
   — the topics factor and the "matches in topic" line are the user's own query echoed back.
   `reddit.ts:114` sets `topics: [user.data.subreddit]` from a field its own `t2` interface nests
   elsewhere. `npm.ts:177` sets `followersCount = round(maxScore * 100000)`, which the card prints
   as "85,000 followers".
3. **`deduplicateBuilders` merges by lowercased username across all 12 sources**
   (`src/lib/dedup.ts:6`), keeping the first row's `source`/`profileUrl`/`id` while unioning
   `topics`, shallow-merging `metadata` and taking `max(followersCount)`. A card labelled "GitHub ·
   @foo" can therefore be scored on a Lobsters user's `lastSeen`. Per-source attribution is unsound
   for merged rows and nothing says so.

All four personas (OSS maintainers, founders, recruiters, DevRel) ask the same question before
spending outreach effort: *is this a real person, and why am I being shown them?* `audit-trust`
answers that internally. Nothing answers it on screen.

## Goal

A collapsible **evidence panel** on each result showing exactly which inputs produced the score,
which were actually measured, which are defaults or known unreliable, and a link to the original
public artifact when one exists. One score implementation, one view model, zero fabricated evidence.

## Non-goals

- **No change to ranking.** `scoreBuilders` output stays byte-identical; a golden test enforces it.
  Fixing the connector defects the panel exposes would change every score and is filed as a
  finding, not implemented here.
- **No AI.** Every input is a structured number, timestamp or string a source API returned. Per
  [`ai-policy`](../../_meta/ai-policy.md) this registers **no AI task** and touches nothing under
  `src/shared/lib/ai/`. No LLM-written "why this match" prose.
- **No screenshots, no scraping, no new source calls** — zero outbound HTTP added.
- **No new table.** `builder_source_snapshots` already exists.
- **Not on `src/modules/search/components/PersonResultCard.tsx`** (the compact card used by
  `_dashboard/sprints/new.tsx`, `_dashboard/sprints/$sprintId/index.tsx` and the anonymous
  `_landing/explore/index.tsx`): its `PersonCardData` carries no `metadata`, so a panel there could
  only guess.
- No bespoke repo panel — `kind: 'repo'` gets the same component, factors plus the repo URL.

## User stories

1. As a **recruiter** I expand "Why this match" on a GitHub result and see `Popularity +21 · 1,240
   followers`, `Topics +6 · rust, tokio`, `Recency +5 · default — GitHub's user search does not
   report last activity`, plus a profile link. The ring stops being a black box.
2. As an **OSS maintainer** I expand a Lobsters result and see the three matching story titles, each
   linking to lobste.rs, with the date each was posted.
3. As a **founder** I expand a Stack Overflow result and see the recency row marked *"not evidence —
   this connector stamps the request time, not the user's activity"*.
4. As any user looking at a card whose handle exists on three platforms, I see an explicit warning
   that BuilderHunt merged same-handle profiles and the rows may belong to different people.
5. As a **recruiter on a tracked builder's profile**, I see the same panel built from the snapshot
   recorded at track time, captioned "recorded 12 Jun 2026 when a teammate tracked this builder —
   reported by their browser, not re-checked against GitHub". Every row in it is badged
   *client-attested*, and none of them can ever say *measured*.

## The score-decomposition decision — RESOLVED

| Option | Verdict |
| --- | --- |
| Change `scoreBuilders` to return `{ score, factors[] }` | **Rejected.** `ScoredBuilder` is spread into the search response, `upsertEmbeddingStubs`, and the sprints/alerts/discovery workers. It also ships ~1.2 KB × 30 results of data the client can derive. |
| Recompute client-side in a separate module | **Rejected.** That is `getScoreBreakdown` today, and it drifted within one release. |
| A parallel pure `explainScore()` **inside `src/lib/score.ts`**, with `scoreBuilders` reimplemented on top | **Chosen.** |

`explainScore(input, now?)` returns the factor list; `scoreBuilders` becomes
`builders.map(b => ({ ...b, score: explainScore(b, now).score }))`. Drift becomes impossible by
construction, the wire format is unchanged, and the module stays pure (it imports only the
`RawBuilder` type), so **the client imports the same function the server scored with** — no API
round-trip, no payload growth for search.

**Is the score decomposable?** Mostly yes, and the panel is honest about the rest. Popularity,
recency, topics, the source-specific branch and the quality bonus are already independent additive
terms. Two caveats: only the *final sum* is rounded and clamped, so per-factor integers can differ
from the ring by ±1 — `ScoreExplanation` carries `rawTotal` and `clamped` so the UI can say "capped
at 100" instead of silently lying; and the popularity term is uncapped despite its 0–30 comment.

**Basis labelling is mandatory.** Every factor carries
`basis: 'measured' | 'client-attested' | 'default' | 'unreliable'`:

- `measured` — computed from a value **BuilderHunt's own server fetched** from this source's API.
  Only the live-search adapter can produce it (see below).
- `client-attested` — the value reached us in a browser's request body and was never re-checked
  against the source. Only the snapshot adapter produces it.
- `default` — the source did not expose the input and `score.ts` substituted a constant (the `+5`
  neutral recency at `score.ts:51`).
- `unreliable` — the input exists but does not mean what its name says. Hardcoded to the verified
  cases: `stackoverflow` recency, `hn` topics, `reddit` topics, and every factor on a merged row.

`measured` and `client-attested` are never mixed in one panel, never share a visual treatment, and
never share a caption.

## The evidence-provenance decision — RESOLVED

Search results are ephemeral `RawBuilder` objects (`src/lib/sources/types.ts`) behind a 5-minute
cache; `builder_source_snapshots` is a global, `builder_identity_id`-keyed, content-hashed version
history that is **currently empty**. A pure read-only consumer of it would render nothing, so this
plan makes it live with the smallest possible write.

**One view model, one component, two adapters — with different provenance, stated as such.**

- **Search** (`freshness: 'live'`): `buildMatchEvidence(builder, query)` runs client-side on the
  object already in the response. That object was produced by **BuilderHunt's own server** calling
  the source APIs inside `searchBuilders` (`src/lib/search.ts:70-97`), so its values are genuinely
  server-fetched and may be labelled `measured`. `observedAt` = response time. No round-trip, no
  payload change, works for never-tracked and never-snapshotted results — nearly all of them.
- **Profile** (`freshness: 'snapshot'`): `GET /api/builders/$builderId/match-evidence` reads the
  newest snapshot row, written fire-and-forget by `POST /api/builders/track` in the same shape as
  `upsertEmbeddingStubs` (`src/routes/api/builders/track.ts:82`). Every factor and item it yields is
  `client-attested`. **It can never be `measured`.**

### Why the snapshot is client-attested, not an observation

`POST /api/builders/track` performs **no source fetch**. It passes the request body straight through
— `trackOrganizationBuilder(tx, { ...parsed.data })` at `track.ts:63-68`, where `parsed.data` is
`TrackBody` (`:17-37`). Only `profileUrl` is corroborated, and only against the declared source's
host allowlist (`isAllowedBuilderProfileUrl`, `:34`). `followersCount`, `bio`, `topics`, `score` and
the whole `metadata` blob are client-supplied and unvalidated. A snapshot written from that path
therefore has **exactly the provenance of the `privateMetadata` this spec rejects**; writing it
server-side and content-hashing it makes it durable and tamper-evident, not true.

Three ways out were considered:

| Option | Verdict |
| --- | --- |
| (a) Fetch the source API server-side before writing the snapshot | **Rejected.** It needs a per-source refetch adapter for 12 sources — that is `enrichment`'s connector registry rebuilt — and it breaks this plan's "zero outbound HTTP" non-goal, putting GitHub/Stack Overflow quota and multi-second latency on the track path. It is a real feature and belongs to its own plan. |
| (b) Keep the path, add a distinct `client-attested` basis with its own caption and treatment | **Chosen**, together with (c). |
| (c) Narrow the snapshot to fields the server can corroborate | **Chosen** as the structural half. In practice the server can corroborate almost nothing here, which is the point — so the envelope makes the split explicit rather than implicit. |

The envelope separates the two provenances by construction:

```ts
{ version: 1,
  provenance: 'client-attested-track',            // future: 'server-fetched'
  serverVerified: { source, sourceId, profileUrl, // profileUrl host-checked at track time
                    recordedAt },                 // server clock
  attested: { username, displayName?, bio?, avatarUrl?, followersCount?,
              language?, country?, topics, metadata } }
```

**The invariant**: the snapshot adapter's input type is `AttestedSnapshot`, distinct from the live
adapter's `ScoreInput`, and its basis mapping is a pure function that emits only
`client-attested | default | unreliable`. `measured` is unreachable from it — enforced by a test, not
by reviewer vigilance. When a future plan adds a real server-side fetch it writes
`provenance: 'server-fetched'` and *earns* `measured`; until then no code path can mislabel a
browser-supplied number.

**Never-snapshotted, never-tracked**: the route returns `{ available: false, reason: 'no-snapshot' }`
and the panel renders identity-level facts only (`builder_identities.username`, `followersCount`,
`lastSeenAt`) with "nothing recorded yet". It never falls back to `privateMetadata` and never
fabricates.

## What each of the 12 sources can actually prove

Verified field-by-field against `src/lib/sources/*.ts`. This table is the specification for
`src/lib/evidence/extract.ts`; an extractor may never emit a row a source does not populate.

| Source | `followersCount` really is | Recency input | Item-level evidence | Item deep link |
| --- | --- | --- | --- | --- |
| github (person) | `followers` — **absent from the `/search/users` payload**, so `undefined` at runtime | none → `default +5` | none | profile only |
| github (repo) | `stargazers_count` | none | stars / issues / watchers | repo URL |
| gitlab | total stars across projects | `last_activity_at` (`measured`) | project count, forks | profile only (`namespacePath` is not a URL) |
| codeberg | real `followers_count` | repo `updated_at` (`measured`, repos only) | stars, forks, open issues | repo `html_url` |
| sourcehut | `undefined` | none | `location` only | profile only |
| hn | `karma` | newest matching item's `created_at` (`measured`) | `matchCount`, best title (folded into `bio`) | **none** — the item id is not retained |
| reddit | `subscribers` | none | `activeUsers` | profile only |
| devto | total reactions on matched articles | none | `articlesCount`, first title (in `bio`) | profile only — article URLs not retained |
| hashnode | real `followersCount` | none | `postCount` | profile only |
| stackoverflow | `reputation` | `Date.now()` → **`unreliable`** | `postCount`, `postScore`, `matchedTags` | profile only |
| npm | `round(maxScore * 100000)` — a 0–1 quality score, **not followers** | package `lastModified` (`measured`) | `packageCount`, names (in `bio`) | profile only |
| huggingface | model downloads / author `totalDownloads` | model `created` (`measured`) | `modelCount`, `totalLikes`, pipelines | profile only |
| lobsters | `maxScore` of one story — **not followers** | `lastSeen` (`measured`) | `sampleTitles` (≤3), `matchedStoryCount` | `representativeUrl` — the only real per-item link in the codebase (`lobsters.ts:188`) |

The panel therefore renders a per-source `popularityMeaning` string instead of the word "followers",
and a **coverage line** whose wording follows the adapter: the live panel says "4 of 5 signals
measured · 1 default · 0 unreliable", the snapshot panel says "5 signals, all client-attested · 0
measured". `coverage` therefore counts four bases, not three.

## Deep links to the original

`resolveEvidenceUrl(source, candidate)` in `src/lib/sources/canonical-links.ts` (new, client-safe):
a per-item URL from metadata (only `lobsters.representativeUrl` today) if it passes the host
allowlist → otherwise `RawBuilder.profileUrl` (a required field, always present) as "View on
{source}" → otherwise **no link**, with the row saying the source does not expose one.

Validation reuses the per-source host map at `src/shared/lib/security/url-policy.ts:46`. That module
imports `node:dns`/`node:net` and cannot be bundled for the client, so the map moves into
`canonical-links.ts` and `url-policy.ts` imports it — one allowlist, two consumers. Off-allowlist
URLs are dropped, never rendered: string-templating a source host to manufacture a link is how you
ship a 404 as evidence.

## Privacy and data classification

The panel renders **global public source data only**. Per
[`security-policy`](../../_meta/security-policy.md) rule 10 (output minimization) both adapters
project through an explicit `MatchEvidenceDTO` allowlist and never return an ORM row or a raw
provider payload. Excluded by construction: `organization_builders.privateMetadata` (notes
overrides, `aiEnrichment`), `builder_notes`, `enrichment_evidence` (tenant-private, has its own
`PublicEvidenceCard`), anything from another organization, cross-tenant existence signals ("tracked
by N organizations"), and contact data — npm deliberately drops maintainer email at the source
(`npm.ts:186`) and the extractor never re-derives it.

`builder_source_snapshots` keeps its existing **system-operational** classification in
`docs/architecture/data-classification.md` (bounded version history, no `organization_id`, so no
RLS). Because it is global, the *route* enforces tenancy: `GET
/api/builders/$builderId/match-evidence` requires `requireTenantPrincipal` and confirms the identity
is tracked by that organization via `findOrganizationBuilderByEitherId` under `withTenantContext` —
otherwise it becomes an unauthenticated global identity-enumeration oracle. Unknown and untracked
identities return the **same** 404 body. Snapshot writes skip identities with an active restriction
(`select is_builder_processing_restricted($1)`, the pattern at
`src/shared/lib/repositories/enrichment.ts:187`) and the route returns
`{ available: false, reason: 'restricted' }` for them.

## UX integration

- **Search** (`src/modules/search/components/SearchPage.tsx`): the existing one-line row 4
  (line 1470) becomes the `<summary>` of a native `<details>` — same copy, plus the coverage chip.
  `ResourceResultCard` gets the same treatment at its why-this-match paragraph (line 1569).
- **Ring tooltip**: `ScoreRing`'s `breakdown` prop is fed from `explainScore`;
  `getScoreBreakdown` and its `src/components/ui/index.ts` export are deleted.
- **Profile** (`src/modules/builder-profile/components/BuilderProfilePage.tsx:246`): the panel
  mounts above `HygieneCard` in the same `card` shell — glass-shell-only, no new design tokens. Its
  header states the provenance in plain language ("recorded {date} when a teammate tracked this
  builder — reported by their browser, not re-checked against {source}"), and every row carries the
  `client-attested` badge. The live-search panel never shows that badge, and the snapshot panel
  never shows `measured`.
- Merged rows show an amber notice above the factor list. The body renders only while open, so a
  30-result page does not carry 30 hidden subtrees.

## Accessibility

[`audit-accessibility`](../../audit-accessibility/spec.md) is a release gate, so the panel is a
native `<details>`/`<summary>` disclosure — the primitive already blessed in `FAQSection.tsx`. That
gives implicit `aria-expanded`, Enter/Space activation and correct roles for free; no
`role="button"`, no focus trap, no roving tabindex.

- The `name` attribute (exclusive accordion) is deliberately **not** used — collapsing a neighbour
  is a surprise state change in a 30-row list.
- Focus stays on the `<summary>` when toggling; the panel never moves focus or scrolls the page.
- `<summary>` hit area ≥ 24 × 24 CSS px (WCAG 2.2 target size, the gap `audit-accessibility` flags
  for `p-1`/`p-1.5` controls).
- Transitions are wrapped in `@media (prefers-reduced-motion: reduce)`; with motion reduced the
  panel appears instantly.
- Basis is never colour-only: `client-attested`, `default` and `unreliable` rows each carry a text
  label and a distinct icon, so the four bases are distinguishable without colour vision.
- External links keep `target="_blank" rel="noopener noreferrer"` and an accessible name naming the
  destination source.

## Tier and billing gating

The panel is **free on every tier**. Gating the explanation of a score behind a paywall would mean
free users see a number they cannot inspect — an `audit-trust` regression, not a feature. What is
gated is the **attested-history timeline** (more than one snapshot: "reported followers +240 since
12 Jun"), which needs retained history and only exists for tracked builders. Its copy says
*reported*, never *grew* — a delta between two client-attested numbers is a delta between two
claims.

Gate: `getOrganizationEntitlement` + `resolveLegacyPlanTier`
(`src/shared/lib/repositories/entitlements.ts`) — free returns the latest snapshot only, pro/team and
above up to 10. With `STRIPE_BILLING_ENABLED=false` (true in every environment today) this resolves
exactly like every other gated feature: the entitlement row is authoritative, admins set it
manually, nobody is billed. No new entitlement column.

No AI ⇒ **no cost model**. Runtime cost is one small insert per track request and one indexed
`SELECT … ORDER BY observed_at DESC LIMIT 10` per profile view.

## Success metrics

- `getScoreBreakdown` no longer exists; one score implementation, proven by a golden test over a
  12-source fixture corpus asserting `scoreBuilders` output is unchanged.
- `sum(factors.points)` clamped and rounded `=== ring score` for every fixture, all 12 sources,
  both `kind`s.
- Zero evidence rows emitted for absent metadata keys (asserted over synthetic `metadata: {}`
  builders for all 12 sources) and zero rendered links off the per-source host allowlist.
- **No snapshot-derived factor or item is ever `basis: 'measured'`** — asserted exhaustively over
  every fixture through the snapshot adapter. This is the plan's single most important test: it is
  what keeps a client-supplied `followersCount` from rendering as measured evidence.
- Search response payload for a 30-result page unchanged within 1% (the panel derives, it does not
  receive), measured before/after on the same query.
- Panel open→render under 16 ms — a pure sync function over data already in memory.
- Conversion proxy: tracked-builders-per-search over a 14-day window, from the existing
  `metrics.searches` counter and `/api/builders/track` volume. Per-open client telemetry is
  explicitly **out of scope** — no client event transport exists and `CookieBanner.tsx:118` states
  analytics consent is currently unused.
- `pnpm test:api-isolation:local` covers the new route (tenant A vs B, untracked identity,
  anonymous) and the new grant.

## Resolved edge cases

- **Merged (deduped) row**: `mergedFrom` is populated by `deduplicateBuilders`; every
  metadata-derived factor becomes `unreliable`, the amber notice lists the colliding profile URLs,
  and item deep links are suppressed (only the primary `profileUrl` remains). Ranking untouched.
- **Semantic-search hits**: `/api/search/semantic` results carry `similarity` and an
  `EmbeddedProfile`-shaped payload, not source metadata. The panel shows the similarity plus
  derivable factors and a "from the local index" note; it invents no items. See
  [`semantic-search`](../../semantic-search/spec.md).
- **Score clamped at 100**: `clamped: true` renders "capped at 100 (raw {rawTotal})" so factor
  points that visibly exceed the ring are explained rather than contradictory.
- **Cached search results**: `searchBuilders` serves from memory/Redis for 5 minutes
  (`src/lib/search.ts:30-68`) and does not expose the cache timestamp, so a `freshness: 'live'`
  `observedAt` is accurate only to within that TTL. The panel says "from this search (within the
  last 5 minutes)" rather than printing a false to-the-second time. Still server-fetched, so
  `measured` remains correct.
- **A tracked builder who also appears in a live search**: the search card shows the `measured`
  live panel and the profile page shows the `client-attested` snapshot panel. They may disagree;
  both captions say where their numbers came from, and neither is silently preferred.
- **`metadata: {}`** (Reddit, GitHub person, sourcehut in practice): factors with bases plus a "this
  source exposes little beyond the profile itself" line. Empty, not fake.
- **Snapshot payload from an older connector version**: payloads are zod-parsed on read; a failure
  yields `{ available: false, reason: 'unreadable-snapshot' }`, never a partial render.
- **Snapshot retention**: keep the 10 newest rows per identity, pruned by the write. Content-hash
  uniqueness already makes an unchanged re-track a no-op.
- **A client POSTing inflated numbers to `/api/builders/track`**: still possible (unchanged from
  today — that is `track.ts`'s existing contract, not something this plan introduces). The panel's
  job is to never dress it up as measurement: the value renders as `client-attested` with the
  tracking date, so an inflated number is visibly a claim by whoever tracked the builder. Hardening
  `TrackBody` itself is out of scope and stays with `audit-trust`.
- **Missing `builderhunt_app` grant**: the table has never been granted to the runtime role — the
  same bug class as `drizzle/0025_public_tables_app_grants.sql`. The grants migration ships in the
  same phase as the first write and the isolation script asserts it against the real role.
- **Suppressed profile** (`audit-trust`'s future `profileSuppressions`): the extractor is pure over
  data the search pipeline already returned, so upstream suppression is inherited automatically; no
  second enforcement point is added here.
