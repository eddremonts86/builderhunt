# Why This Match — Evidence Panel (spec)

> **Status**: `pending`
> **Depends on**: nothing (pure read-only consumer of `src/lib/score.ts` and `builder_source_snapshots`). Files new connector findings against [`audit-trust`](../../phase-1/51-audit-trust/spec.md) (it does not close any existing one — `audit-trust`'s two open tasks are the runtime trust gate and the staged rollout, neither of which this plan touches) and must respect [`project-hygiene`](../../phase-1/04-project-hygiene/spec.md) (no synthetic evidence presented as measured fact).
> **Blocks**: [`jd-to-candidates-matching`](../jd-to-candidates-matching/spec.md) (soft — that plan reuses this panel to explain per-JD match reasons); [`browser-extension-overlay`](../browser-extension-overlay/spec.md) (soft — it reads `src/lib/score.ts`, so land the `explainScore` refactor first)
> **Reality check**: `src/lib/score.ts` returns a single clamped integer per builder with no breakdown. A second, **already-drifted** copy of the math lives in `getScoreBreakdown` (`src/components/ui/score-ring.tsx:158`) and feeds the ring tooltip. `SearchPage.tsx` already renders a one-line "why this match" (`getMatchHighlights`, line 1296; row 4 at line 1473). `builder_source_snapshots` exists (`src/shared/lib/db/schema.ts:164`, created in `drizzle/0005_builder_normalization.sql`) but has **zero readers, zero writers, and no `builderhunt_app` grant** — it is empty everywhere.

## Problem

Every result card shows a 0–100 score ring and one line of "matches 'rust' in topic". Neither is
inspectable, and both are less honest than they look.

1. **The tooltip breakdown is a second implementation of the score, and it has already drifted.**
   `getScoreBreakdown` caps popularity at 30 while `scoreBuilders` never caps it (1M followers ⇒
   `log1p(1e6)*3 ≈ 41`), omits the `profileUrl` quality point, and omits the entire source-specific
   branch (`score.ts:59-154` — nominally 0–15, but the Stack Overflow arm reaches 20 at `:88-96`
   and the reddit/hn arms at `:72`/`:75` are uncapped logarithms). Realistic under-reporting is
   ≈14 points for a high-star GitHub repo (capped popularity + the missing `profileUrl` +1 + the
   omitted +4 star-ratio bonus) and more than 20 for a multi-tag Stack Overflow person. This is the
   exact failure mode `project-hygiene` was written for.
2. **Several score inputs are not what they claim.** Verified in `src/lib/sources/`:
   `stackoverflow.ts:213` sets `metadata.lastSeen = Date.now()`, so every Stack Overflow result
   collects the full 30 recency points for being "active today". `hn.ts:128` sets `topics: keywords`
   — the topics factor and the "matches in topic" line are the user's own query echoed back.
   `reddit.ts:114` sets `topics: [user.data.subreddit]` from a field its own `t2` interface nests
   elsewhere. `npm.ts:205` sets `followersCount = round(maxScore * 100000)`, which the card prints
   as "85,000 followers". `github.ts:62` and `:66` read `user.followers`, `user.public_repos` and
   `user.created_at` from `/search/users`, which returns none of them — `GitHubSearchUser`
   (`github.ts:4-15`) declares fields the endpoint omits, so `followersCount` and both metadata
   values are `undefined` at runtime, not zero.
3. **`deduplicateBuilders` merges by lowercased username across all 15 sources**
   (`src/lib/dedup.ts:7`), keeping the first row's `source`/`profileUrl`/`id` while unioning
   `topics`, shallow-merging `metadata` and taking `max(followersCount)` (`dedup.ts:12-24`). A card
   labelled "GitHub · @foo" can therefore be scored on a Lobsters user's `lastSeen`. Per-source
   attribution is unsound for merged rows and nothing says so.

All four personas (OSS maintainers, founders, recruiters, DevRel) ask the same question before
spending outreach effort: *is this a real person, and why am I being shown them?* Nothing answers
it on screen.

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
  `_landing/explore/index.tsx`): its `PersonCardData` (`PersonResultCard.tsx:4-17`) carries no
  `metadata`, so a panel there could only guess.
- No bespoke repo panel — `kind: 'repo'` gets the same component, factors plus the repo URL.
- **No connector fixes.** Not even the obviously wrong ones. They change every score.

## User stories

1. As a **recruiter** I expand "Why this match" on a GitHub *repo* result and see `Popularity +21 ·
   1,240 stargazers`, `Topics +6 · rust, tokio`, `Recency +5 · default — GitHub's search payload
   does not report last activity`, plus a repo link. The ring stops being a black box.
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
| Change `scoreBuilders` to return `{ score, factors[] }` | **Rejected.** `ScoredBuilder` is spread into the search response (`src/routes/api/search/builders.ts:84`), `upsertEmbeddingStubs`, and the sprints/alerts/discovery workers. It also ships ~1.2 KB × 30 results of data the client can derive. |
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

- `measured` — computed from a value **BuilderHunt's own server fetched** from this source. Only
  the live-search adapter can produce it (see below). One nuance, stated in the panel: `devpost`
  is not fetched in the request — `src/lib/sources/devpost.ts` reads the cron-populated
  `devpost_profiles` store written by `src/lib/devpost/worker.ts`. It is still server-fetched, so
  it stays `measured`, but its recency caption names the worker cadence rather than "this search".
- `client-attested` — the value reached us in a browser's request body and was never re-checked
  against the source. Only the snapshot adapter produces it.
- `default` — the source did not expose the input and `score.ts` substituted a constant (the `+5`
  neutral recency at `score.ts:51`).
- `unreliable` — the input exists but does not mean what its name says. Hardcoded to the verified
  cases: `stackoverflow` recency, `hn` topics, `reddit` topics, and every factor on a merged row.

`measured` and `client-attested` are never mixed in one panel, never share a visual treatment, and
never share a caption.

## The evidence-provenance decision — RESOLVED

Search results are ephemeral `RawBuilder` objects (`src/lib/sources/types.ts:38-53`) behind a
5-minute cache; `builder_source_snapshots` is a global, `builder_identity_id`-keyed, content-hashed
version history that is **currently empty**. A pure read-only consumer of it would render nothing,
so this plan makes it live with the smallest possible write.

**One view model, one component, two adapters — with different provenance, stated as such.**

- **Search** (`freshness: 'live'`): `buildMatchEvidence(builder, query)` runs client-side on the
  object already in the response. That object was produced by **BuilderHunt's own server** calling
  the source APIs inside `searchBuilders` (`src/lib/search.ts:76-95`), so its values are genuinely
  server-fetched and may be labelled `measured`. `observedAt` = response time. No round-trip, no
  payload change, works for never-tracked and never-snapshotted results — nearly all of them.
- **Profile** (`freshness: 'snapshot'`): `GET /api/builders/$builderId/match-evidence` reads the
  newest snapshot row, written fire-and-forget by `POST /api/builders/track` in the same shape as
  `upsertEmbeddingStubs` (`src/routes/api/builders/track.ts:86`). Every factor and item it yields is
  `client-attested`. **It can never be `measured`.**

### Why the snapshot is client-attested, not an observation

`POST /api/builders/track` performs **no source fetch**. It passes the request body straight through
— `trackOrganizationBuilder(tx, { ...parsed.data })` at `track.ts:67-72`, where `parsed.data` is
`TrackBody` (`:18-38`). Only `profileUrl` is corroborated, and only against the declared source's
host allowlist (`isAllowedBuilderProfileUrl`, `:35`); `isSuppressed` at `:51` is a removal check,
not a truth check. `followersCount`, `bio`, `topics`, `score` and the whole `metadata` blob are
client-supplied and unvalidated. A snapshot written from that path therefore has **exactly the
provenance of the `privateMetadata` this spec rejects**; writing it server-side and content-hashing
it makes it durable and tamper-evident, not true.

Three ways out were considered:

| Option | Verdict |
| --- | --- |
| (a) Fetch the source API server-side before writing the snapshot | **Rejected.** It needs a per-source refetch adapter for 15 sources — that is `enrichment`'s connector registry rebuilt — and it breaks this plan's "zero outbound HTTP" non-goal, putting GitHub/Stack Overflow quota and multi-second latency on the track path. It is a real feature and belongs to its own plan. |
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

**Track covers 12 of the 15 sources.** `TrackBody`'s enum (`track.ts:19-22`) omits `devpost`,
`producthunt` and `bluesky`, so no snapshot can ever exist for them and the profile panel for such
an identity is permanently `no-snapshot`. That is correct, not a gap: widening `TrackBody` is a
different plan's decision.

## What each of the 15 sources can actually prove

Verified field-by-field against `src/lib/sources/*.ts` at HEAD (the `metadata: { … }` literal in
each file is the authority). This table is the specification for `src/lib/evidence/extract.ts` (new); an
extractor may never emit a row a source does not populate.

| Source | `followersCount` really is | Recency input | Metadata keys actually emitted | Item deep link |
| --- | --- | --- | --- | --- |
| github (person) | `user.followers` — **absent from the `/search/users` payload**, so `undefined` at runtime | none → `default +5` | `publicRepos`, `createdAt` — **also absent from that payload, so both `undefined` at runtime** (`github.ts:66`) | profile only |
| github (repo) | `stargazers_count` | none | `stars`, `issues`, `watchers` (`github.ts:99`) | repo URL (`profileUrl`) |
| gitlab (person, token path) | `undefined` — GitLab exposes no follower count (`gitlab.ts:144`) | none → `default +5` | `matchedVia` only (`gitlab.ts:148`) | profile only |
| gitlab (person, owner-aggregate path) | total stars across projects | `lastSeen` (`measured`) | `projectCount`, `totalStars`, `totalForks`, `lastSeen` (`gitlab.ts:272`) | profile only (`namespacePath` is not a URL) |
| gitlab (repo) | `star_count` | `last_activity_at` → `lastSeen` (`measured`) | `stars`, `forks`, `openIssues`, `lastSeen`, `namespacePath`, `ownerKind` (`gitlab.ts:199`) | project `web_url` (`profileUrl`) |
| codeberg (person) | real `followers_count` | none → `default +5` | `starredRepos`, `following`, `website`, `createdAt` (`codeberg.ts:120`) | profile only |
| codeberg (repo) | `stars_count` | `updated_at` → `lastSeen` (`measured`) | `stars`, `forks`, `openIssues`, `watchers`, `lastSeen`, `ownerLogin` (`codeberg.ts:144`) | repo `html_url` (`profileUrl`) |
| sourcehut | `undefined` | none → `default +5` | `location` only (`sourcehut.ts:67`) | profile only |
| hn | `karma` | newest matching item's `created_at` → `lastSeen` (`measured`) | `submittedCount`, `lastSeen`, `matchCount` (`hn.ts:129`) | **none** — the item id is not retained |
| reddit | `subscribers` | none → `default +5` | `activeUsers` only (`reddit.ts:115`) | profile only |
| devto | total reactions on matched articles | none → `default +5` | `articlesCount`, `reactions`, `github`, `twitter` (`devto.ts:99`) — the last two are off-platform handles and are **never rendered** (see Privacy) | profile only — article URLs not retained |
| hashnode | real `followersCount` | none → `default +5` | `postCount` only (`hashnode.ts:109`) | profile only |
| stackoverflow | `reputation` | `Date.now()` → **`unreliable`** (`stackoverflow.ts:213`) | `reputation`, `acceptRate`, `postCount`, `postScore`, `lastSeen`, `matchedTags` (`stackoverflow.ts:208`) | profile only |
| npm (package) | `round(qualityScore * 100000)` — a 0–1 quality score, **not followers** (`npm.ts:128`) | package `lastModified` → `lastSeen` (`measured`) | `version`, `license`, `lastSeen`, `maintainerCount` (`npm.ts:132`) | package page (`profileUrl`) |
| npm (maintainer) | `round(maxScore * 100000)` — same, **not followers** (`npm.ts:205`) | aggregated `lastSeen` (`measured`) | `packageCount`, `totalScore`, `maxScore`, `lastSeen` (`npm.ts:209`) | profile only — package names live in `bio` |
| huggingface (model) | `downloads` | `created` → `lastSeen` (`measured`) | `downloads`, `likes`, `pipelineTag`, `library`, `lastSeen`, `author` (`huggingface.ts:85`) | model page (`profileUrl`) |
| huggingface (author) | `totalDownloads` | `lastSeen` (`measured`) | `modelCount`, `totalDownloads`, `totalLikes`, `lastSeen`, `pipelines` (`huggingface.ts:151`) | profile only |
| lobsters | `maxScore` of one story — **not followers** (`lobsters.ts:176`) | `lastSeen` (`measured`) | `storyCount`, `matchedStoryCount`, `totalScore`, `maxScore`, `lastSeen`, `sampleTitles` (≤3), `representativeUrl` (`lobsters.ts:180`) | `representativeUrl` (`lobsters.ts:188`) |
| devpost | `undefined` — Devpost exposes none (see `score.ts:137-142`) | `lastSeenAt` from the cron store → `lastSeen` (`measured`, worker cadence) | `projectsCount`, `lastSeen` (`devpost.ts:53`) | profile only |
| producthunt | total votes across launches | `lastSeen` (`measured`) | `launchedCount`, `totalVotes`, `bestVotes`, `lastSeen`, `launches[{name,tagline,votesCount,url}]`, `twitterUsername` (`producthunt.ts:140`) | **`launches[].url`** — the second real per-item link in the codebase (`producthunt.ts:119`) |
| bluesky | `followersCount` (real) | none → `default +5` | `did`, `followsCount`, `postsCount`, `customDomainHandle` (`bluesky.ts:83`) | profile only |

The panel therefore renders a per-source `popularityMeaning` string instead of the word "followers",
and a **coverage line** whose wording follows the adapter: the live panel says "4 of 5 signals
measured · 1 default · 0 unreliable", the snapshot panel says "5 signals, all client-attested · 0
measured". `coverage` therefore counts four bases, not three.

**A metadata key being present is not evidence that it has a value.** GitHub's `/search/users`
response omits `followers`, `bio`, `name`, `location`, `public_repos` and `created_at`, so
`github.ts:66` writes `metadata: { publicRepos: undefined, createdAt: undefined }` — the keys exist,
the values do not. Every extractor therefore tests the **value** (finite number / non-empty string /
non-empty array), never `key in metadata`.

## Deep links to the original

`resolveEvidenceUrl(source, candidate, profileUrl)` in `src/lib/sources/canonical-links.ts` (new)
— client-safe: a per-item URL from metadata (`lobsters.representativeUrl` and
`producthunt.launches[].url` today) if it passes the host allowlist → otherwise
`RawBuilder.profileUrl` (a required field, always present) as "View on {source}" → otherwise
**no link**, with the row saying the source does not expose one.

Validation reuses the per-source host map at `src/shared/lib/security/url-policy.ts:46`
(`builderProfileHosts`). That module imports `node:dns`/`node:net` and cannot be bundled for the
client, so the map moves into `canonical-links.ts` and `url-policy.ts` imports it — one allowlist,
two consumers. Off-allowlist URLs are dropped, never rendered: string-templating a source host to
manufacture a link is how you ship a 404 as evidence.

**The move also widens the map from 12 entries to an exhaustive 15**, adding `devpost.com`
(written by `src/lib/devpost/worker.ts:100`, the only writer of the store row `devpost.ts:47`
reads), `producthunt.com` (`producthunt.ts:135`) and `bsky.app` (`bluesky.ts:78`). That is safe for
the map's only other consumer:
`isAllowedBuilderProfileUrl` is called from exactly one place — `TrackBody`'s `.refine`
(`track.ts:35`) — and `TrackBody`'s `source` enum rejects those three sources before the refine ever
runs. No existing behaviour changes; the exhaustive `Record<SourceName, string[]>` type simply makes
a future source impossible to forget.

## Privacy and data classification

The panel renders **global public source data only**. Per
[`security-policy`](../../_meta/security-policy.md) rule 10 (output minimization) both adapters
project through an explicit `MatchEvidenceDTO` allowlist and never return an ORM row or a raw
provider payload. Excluded by construction: `organization_builders.privateMetadata` (notes
overrides, `aiEnrichment`), `builder_notes`, `enrichment_evidence` (tenant-private, has its own
`PublicEvidenceCard` at `src/modules/builder-profile/components/PublicEvidenceCard.tsx`), anything
from another organization, cross-tenant existence signals ("tracked by N organizations"), and
contact/cross-platform identity data.

Three metadata keys are **public but off-platform identity**, and the extractor allowlist omits all
three so they are never rendered or deep-linked: `devto.github` and `devto.twitter`
(`devto.ts:99`), `producthunt.twitterUsername` (`producthunt.ts:140`), and `bluesky.did`
(`bluesky.ts:83`). npm deliberately drops maintainer email at the source (`npm.ts:214-216`) and the
extractor never re-derives it.

`builder_source_snapshots` keeps its existing **system-operational** classification in
`docs/architecture/data-classification.md:21` (bounded version history, no `organization_id`, so no
RLS). Because it is global, the *route* enforces tenancy: `GET
/api/builders/$builderId/match-evidence` requires `requireTenantPrincipal` and confirms the identity
is tracked by that organization via `findOrganizationBuilderByEitherId`
(`src/shared/lib/repositories/organization-builders.ts:183`) under `withTenantContext` — otherwise
it becomes an unauthenticated global identity-enumeration oracle. Unknown and untracked identities
return the **same** 404 body. Snapshot writes skip identities with an active restriction
(`select is_builder_processing_restricted($1)`, the pattern at
`src/shared/lib/repositories/enrichment.ts:187`; the function is defined in
`drizzle/0017_enrichment_rls_policies.sql:70` and `EXECUTE`-granted to `builderhunt_app` at `:82`)
and the route returns `{ available: false, reason: 'restricted' }` for them.

**Route naming.** `src/routes/api/builders/$builderId/evidence/` already exists and serves
*tenant-private enrichment evidence*. The new route is a sibling file, `…/$builderId/match-evidence.ts`,
deliberately not nested under `evidence/`, because the two surfaces have opposite data classes.

## Grants — every write and read checked against a real GRANT

| Operation | Role | Grant that authorizes it |
| --- | --- | --- |
| `INSERT`/`SELECT`/`DELETE` on `builder_source_snapshots` (via `publicDb`, `src/shared/lib/db/client.ts:53`) | `builderhunt_app` | **None exists at HEAD** — `grep -n GRANT drizzle/*.sql` shows the table was never granted since `drizzle/0005_builder_normalization.sql`. This plan ships the grants migration (Phase 5, task 1) before the first write. |
| `SELECT` on `builder_identities` (the `no-snapshot` fallback facts) | `builderhunt_app` | `drizzle/0011_builder_claim_policies.sql:31` — `GRANT SELECT, INSERT, UPDATE ON TABLE builder_identities TO builderhunt_app;` |
| `SELECT` on `organization_builders` (the tracked-by-this-org check) | `builderhunt_app` | Existing tenant grants + RLS, exercised today by `GET /api/builders/$builderId` |
| `SELECT` on `organization_entitlements` (the history gate) | `builderhunt_app` | Existing — `getOrganizationEntitlement` already runs on this role from `track.ts:56` |
| `EXECUTE is_builder_processing_restricted(text)` | `builderhunt_app` | `drizzle/0017_enrichment_rls_policies.sql:82` |

No `TRUNCATE`, no `REFERENCES`, no sequence usage (the primary key is `uuid … defaultRandom()`).

## UX integration

- **Search** (`src/modules/search/components/SearchPage.tsx`): the existing one-line row 4
  (line 1473) becomes the `<summary>` of a native `<details>` — same copy, plus the coverage chip.
  `ResourceResultCard` gets the same treatment at its why-this-match paragraph (line 1571).
- **Ring tooltip**: `ScoreRing`'s `breakdown` prop is fed from `explainScore`;
  `getScoreBreakdown` and its `src/components/ui/index.ts:9` export are deleted, and both call
  sites (`SearchPage.tsx:1404` and `:1605`) are rewired.
- **Profile** (`src/modules/builder-profile/components/BuilderProfilePage.tsx`): the panel mounts
  above `HygieneCard` (line 325) in the same `card` shell — glass-shell-only, no new design tokens.
  Its header states the provenance in plain language ("recorded {date} when a teammate tracked this
  builder — reported by their browser, not re-checked against {source}"), and every row carries the
  `client-attested` badge. The live-search panel never shows that badge, and the snapshot panel
  never shows `measured`.
- Merged rows show an amber notice above the factor list. The body renders only while open, so a
  30-result page does not carry 30 hidden subtrees.

## Accessibility

[`audit-accessibility`](../../phase-1/47-audit-accessibility/spec.md) is a release gate, so the panel is a
native `<details>`/`<summary>` disclosure — the primitive already blessed in
`src/modules/landing/components/FAQSection.tsx`. That gives implicit `aria-expanded`, Enter/Space
activation and correct roles for free; no `role="button"`, no focus trap, no roving tabindex.

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

**Where each of those is verified.** The unit environment is `happy-dom`
(`vitest.config.ts:21`), which *does* toggle `<details>` on `summary.click()` but implements
**neither** UA keyboard activation of `<summary>` **nor** layout — `getBoundingClientRect()` returns
`0×0`. Probed directly on 2026-07-27. So the vitest suite asserts structure and click-toggling; real
Enter/Space activation and the ≥24×24 px target are asserted in Playwright, where a browser engine
exists. Writing those two as vitest assertions would produce a test that passes for the wrong reason.

## Tier and billing gating

The panel is **free on every tier**. Gating the explanation of a score behind a paywall would mean
free users see a number they cannot inspect — a trust regression, not a feature. What is gated is the
**attested-history timeline** (more than one snapshot: "reported followers +240 since 12 Jun"), which
needs retained history and only exists for tracked builders. Its copy says *reported*, never *grew* —
a delta between two client-attested numbers is a delta between two claims.

Gate: `getOrganizationEntitlement(tx, organizationId)`
(`src/shared/lib/repositories/entitlements.ts:78`) returns an `EntitlementPolicy` carrying
`tier: 'free' | 'pro' | 'team' | 'pro_max'`. The gate is simply `tier === 'free'` → latest snapshot
only; anything else → up to 10. `resolveLegacyPlanTier` is deliberately **not** used here: it
collapses `pro_max` into `team` (`entitlements.ts:49-51`), which buys this feature nothing and loses
information. With `STRIPE_BILLING_ENABLED=false` (`src/shared/lib/env.ts:141`, and `false` in every
environment today) this resolves exactly like every other gated feature: the entitlement row is
authoritative, admins set it manually, nobody is billed. No new entitlement column, no new
`PLAN_LIMITS` key.

No AI ⇒ **no cost model**. Runtime cost is one small insert per track request and one indexed
`SELECT … ORDER BY observed_at DESC LIMIT 10` per profile view, served by
`builder_source_snapshots_identity_observed_idx` (`schema.ts:175`).

## Success metrics

- `getScoreBreakdown` no longer exists; one score implementation, proven by a golden test over a
  15-source fixture corpus asserting `scoreBuilders` output is unchanged.
- `sum(factors.points)` clamped and rounded `=== ring score` for every fixture, all 15 sources,
  both `kind`s.
- Zero evidence rows emitted for absent-or-`undefined` metadata values (asserted over synthetic
  `metadata: {}` builders for all 15 sources, plus the GitHub-person
  `metadata: { publicRepos: undefined, createdAt: undefined }` shape that the real connector
  produces) and zero rendered links off the per-source host allowlist.
- **No snapshot-derived factor or item is ever `basis: 'measured'`** — asserted exhaustively over
  every fixture through the snapshot adapter. This is the plan's single most important test: it is
  what keeps a client-supplied `followersCount` from rendering as measured evidence.
- Search response payload for a 30-result page unchanged within 1% (the panel derives, it does not
  receive), measured before/after on the same query.
- Panel open→render under 16 ms — a pure sync function over data already in memory.
- Conversion proxy: tracked-builders-per-search over a 14-day window, from the existing
  `metrics.searches` counter (`src/shared/lib/metrics.ts:5`) and `/api/builders/track` volume.
  Per-open client telemetry is explicitly **out of scope** — no client event transport exists and
  `src/shared/components/CookieBanner.tsx:117-121` states analytics consent is currently unused.
- `pnpm test:api-isolation:local` covers the new route (tenant A vs B, untracked identity,
  anonymous) and the new grant.

## Resolved edge cases

- **Merged (deduped) row**: `mergedFrom` is populated by `deduplicateBuilders`; every
  metadata-derived factor becomes `unreliable`, the amber notice lists the colliding profile URLs,
  and item deep links are suppressed (only the primary `profileUrl` remains). Ranking untouched.
- **Semantic-search hits**: `/api/search/semantic` results carry `similarity`
  (`SearchPage.tsx:39-41`) and an `EmbeddedProfile`-shaped payload, not source metadata. The panel
  shows the similarity plus derivable factors and a "from the local index" note; it invents no
  items. See [`semantic-search`](../../phase-1/21-semantic-search/spec.md).
- **Score clamped at 100**: `clamped: true` renders "capped at 100 (raw {rawTotal})" so factor
  points that visibly exceed the ring are explained rather than contradictory.
- **Cached search results**: `searchBuilders` serves from memory/Redis for 5 minutes
  (`src/lib/search.ts:34` sets the TTL; the two cache-hit paths return at `:46-73`) and does not
  expose the cache timestamp, so a `freshness: 'live'` `observedAt` is accurate only to within that
  TTL. The panel says "from this search (within the last 5 minutes)" rather than printing a false
  to-the-second time. Still server-fetched, so `measured` remains correct.
- **A tracked builder who also appears in a live search**: the search card shows the `measured`
  live panel and the profile page shows the `client-attested` snapshot panel. They may disagree;
  both captions say where their numbers came from, and neither is silently preferred.
- **`metadata: {}` or all-`undefined` values** (Reddit, GitHub person, sourcehut, gitlab's token
  person path in practice): factors with bases plus a "this source exposes little beyond the profile
  itself" line. Empty, not fake.
- **Snapshot payload from an older connector version**: payloads are zod-parsed on read; a failure
  yields `{ available: false, reason: 'unreadable-snapshot' }`, never a partial render.
- **Snapshot retention**: keep the 10 newest rows per identity, pruned by the write. Content-hash
  uniqueness (`builder_source_snapshots_identity_hash_unique`, `schema.ts:174`) already makes an
  unchanged re-track a no-op.
- **A client POSTing inflated numbers to `/api/builders/track`**: still possible (unchanged from
  today — that is `track.ts`'s existing contract, not something this plan introduces). The panel's
  job is to never dress it up as measurement: the value renders as `client-attested` with the
  tracking date, so an inflated number is visibly a claim by whoever tracked the builder. Hardening
  `TrackBody` itself is out of scope and is filed against `audit-trust`.
- **Missing `builderhunt_app` grant**: the table has never been granted to the runtime role — the
  same bug class as `drizzle/0025_public_tables_app_grants.sql`. The grants migration ships in the
  same phase as the first write and the isolation script asserts it against the real role.
- **Suppressed profile**: profile suppression **has shipped** since this plan was written —
  `src/shared/lib/profile-suppression.ts` (`isSuppressed`, `filterSuppressed`) is wired into
  `searchBuilders` on all three return paths (`src/lib/search.ts:50`, `:66`, `:122`) and into
  `track.ts:51`. The
  extractor is pure over data the search pipeline already returned, so upstream suppression is
  inherited automatically; no second enforcement point is added here. The snapshot route still
  needs its own check, because it reads a stored row rather than a search result — that is the
  `is_builder_processing_restricted` call above, plus `isSuppressed(source, sourceId)` on the
  identity before the payload is returned.
