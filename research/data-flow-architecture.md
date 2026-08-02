# BuilderHunt — Data Flow & Scraping Architecture

> **Source paths referenced in this document** are the authoritative references. The companion visual HTML
> (`data-flow-architecture.html`) renders the Mermaid diagrams interactively. This file is the same content as
> searchable, git-friendly markdown.

---

## TL;DR

Three independent pipelines write into one Postgres database. Each runs on its own trigger, has its own rate
budget, and its own policy gate.

| Path | Trigger | Sync/Async | Persists? | Spec |
|---|---|---|---|---|
| **Live federated search** | User query | Sync (request-scoped) | No (read-only) | n/a |
| **Discovery worker** | External cron (15 min) | Async batch | Yes — `builder_embeddings` (stubs) | `plans/phase-1/23-proactive-discovery` |
| **Enrichment worker** | User "Refresh" or scheduled | Async batch | Yes — `enrichment_evidence` | `plans/phase-1/42-stealth-scraping` |
| **Content sync** | `pnpm content:sync` (manual or pre-deploy) | Script | Yes — `changelog` + `roadmap_items` | `scripts/db/sync-platform-content.ts` |

---

## 0. System overview

```
                         ┌──────────────────────┐
                         │ Recruiter / Member   │
                         └──────┬───────────────┘
                                │ typed query
              ┌─────────────────▼──────────────────┐
              │  /api/queries  +  /api/search      │  ← tenant principal, rate limit
              └─────────────────┬──────────────────┘
                                │
              ┌─────────────────▼──────────────────┐
              │  searchBuilders()  ·  src/lib/...  │  ← orchestrator
              └────┬──────┬──────┬──────┬──────┬───┘
                   │      │      │      │      │
              ┌────▼─┐ ┌──▼──┐ ┌─▼───┐ ┌─▼───┐ ┌▼────┐
              │github│ │gnlab│ │  HN │ │ npm │ │ ... │  ← 15 connectors
              │  .ts │ │ .ts │ │.ts  │ │ .ts │ │     │     src/lib/sources/
              └──────┘ └─────┘ └─────┘ └─────┘ └─────┘
                   │      │      │      │      │
                   └──────┴──────┴──────┴──────┘
                                │
              ┌─────────────────▼──────────────────┐
              │  Normalize + dedupe + score        │
              └─────────────────┬──────────────────┘
                                │ ranked builders
              ┌─────────────────▼──────────────────┐
              │  Profile surface ·  /builders/$id  │
              └────────────────────────────────────┘

  ┌─────────────────────────── Async workers ─────────────────────────────┐
  │                                                                        │
  │  ┌─── Discovery (cron 15 min) ───┐  ┌─── Enrichment (on demand) ───┐  │
  │  │ DISCOVERY_MATRIX              │  │ enrichment_jobs              │  │
  │  │ → searchBuilders(cell)        │  │ → policy ∩ allowlist         │  │
  │  │ → builder_embeddings stubs    │  │ → safeFetch (robots + SSRF) │  │
  │  └───────────────────────────────┘  │ → resolver (score → accept)  │  │
  │                                     │ → enrichment_evidence        │  │
  │                                     │ → retention pass (30d/180d)  │  │
  │                                     └───────────────────────────────┘  │
  │                                                                        │
  │  ┌─── Content sync (pre-deploy) ──────────────────────────────────┐  │
  │  │ content/changelog/*.md + content/roadmap/*.md → DB              │  │
  │  │ deterministic IDs, idempotent, preserves shipped_at + votes      │  │
  │  └─────────────────────────────────────────────────────────────────┘  │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## 1. 15 source connectors · one shape

File: `src/lib/sources/types.ts`

```ts
export type BuilderKind = 'person' | 'repo' | 'organization'

export type SourceName =
  | 'github' | 'gitlab' | 'codeberg' | 'sourcehut'
  | 'hn' | 'reddit' | 'devto' | 'hashnode' | 'stackoverflow'
  | 'npm' | 'huggingface' | 'lobsters' | 'devpost' | 'producthunt'
  | 'bluesky'

export interface RawBuilder {
  id: string
  kind: BuilderKind
  source: SourceName
  sourceId: string
  username: string
  displayName?: string
  avatarUrl?: string
  bio?: string
  profileUrl: string
  followersCount?: number
  language?: string
  country?: string
  topics: string[]
  metadata: Record<string, unknown>
}
```

> **Why `BuilderKind` matters:** the comment on the type is unusually explicit — "30 of 60 GitHub results turned
> out to be repositories and one of the 'people' was a company account. A recruiter searching for people must not
> be shown either."

### Active sources (15)

`github` · `gitlab` · `codeberg` · `sourcehut` · `hn` · `reddit` · `devto` · `hashnode` · `stackoverflow` · `npm`
· `huggingface` · `lobsters` · `devpost` · `producthunt` · `bluesky`

### Hard-blocked at compile time (defined as policies, never executable)

`linkedin` · `x` · `facebook` · `instagram`

Reason recorded in `permissionReference` with link to provider terms (LinkedIn crawling terms, X ToS, Meta
automated data collection terms).

---

## 2. Path 1 · Live federated search

```
User → /api/queries or /api/search
   → requireTenantPrincipal
   → rateLimit + entitlement check
   → searchBuilders({ keywords, sources, perPage })
        ↳ searchUsers()  per connector in parallel
        ↳ hydrate()      one call per result for full profile
   → normalize + dedupe + score
   → ranked JSON
```

### Implementation notes

- **GitHub**: `api.github.com/search/users?q=...&type:user` returns only `login`, `id`, `avatar_url`, `html_url`,
  `type`, `score` — no display name, bio, location, follower count. The connector makes one extra call per result to
  `/users/{login}` to hydrate those fields. Without hydration, 43 GitHub people had only 1 display name, 0 bios, 0
  locations, 0 follower counts in the DB.
- **HN**: uses Algolia (`hn.algolia.com/api/v1/search?tags=(story,comment)`), not the Firebase API. The Firebase API
  has no full-text search — only item/user lookups by id. The connector aggregates hits by author (count, best title,
  recency, top points) and strips raw HTML in bios/comments.
- **Failure isolation**: a connector that throws or returns `[]` is logged and skipped — never aborts the search.
- **No data persisted**: live search is read-only. The only writes are analytics events. To make a builder
  "tracked," the user adds it to a list (creates the `organization_builders` row and seeds an enrichment job).

---

## 3. Path 2 · Proactive discovery worker

Files: `src/lib/discovery/{worker,matrix}.ts`. Trigger: external scheduler (15 min) → `POST /api/admin/discovery/run-worker`.

### One run

```
loadState()          → discovery_state row (cursor + stats)
loop i in 0..CELLS_PER_RUN:
  cell = cellAt(cursor)
  results = searchBuilders({ keywords: cell.keywords, sources: cell.sources, perPage: 30 })
  persons = results.filter(b => b.kind === 'person')
  usedToday = peekStubCount()       (Redis or in-memory fallback)
  if !capped:
    allowance = cap - usedToday
    toUpsert = persons.slice(0, allowance)
    await upsertEmbeddingStubs(toUpsert)    → builder_embeddings (stubs, no full payload)
    await incrementStubCount(toUpsert.length)
  cursor = nextCursor(cursor, 1, matrix.length)
update discovery_state
return { cellsRun, resultsSeen, upserted, cursor, capped }
```

### The matrix

Built deterministically from **30 curated topics × 4 source groups**. Each topic produces two cells (adjacent source
groups, rotated per topic index) so no topic repeats a group and every group is exercised roughly evenly.

| Group | Sources | Why grouped |
|---|---|---|
| `code` | github · gitlab · codeberg | Code hosting |
| `community` | hn · reddit · lobsters | Aggregator discussion |
| `content` | devto · stackoverflow | Long-form + Q&A |
| `registries` | npm · huggingface | Package / model releases |

### Pacing

- ≤ 4 sources per cell
- Sequential across cells (never parallel across cells)
- Capped at `DISCOVERY_DAILY_STUB_CAP` stubs per day
- Cursor wraps modulo matrix length; unknown key resets to 0
- Redis stub counter has 2-day TTL (covers clock skew); in-memory fallback when Redis is not configured
- A cell that throws is logged and skipped — never aborts the run

---

## 4. Path 3 · Public profile enrichment

Files: `src/lib/enrichment/{worker,registry,policies,network,resolver,robots,hash,types,normalize,connectors/*}.ts`.
Spec: `plans/phase-1/42-stealth-scraping/spec.md`.

> **Status (spec §0):** code-complete-dark 2026-07-20 (phases 0–6 implemented). `ENRICHMENT_ENABLED=false` everywhere
> until the 7-day canary, RLS fixture tests, and legal-copy sign-off pass. The directory name `stealth-scraping` is
> legacy — product copy uses **Public Profile Enrichment**.

### Full job lifecycle

```
[trigger] member clicks Refresh + submits URL(s)
   → enqueue enrichment_jobs (queued, lease=N)
[worker] reclaimExpiredEnrichmentLeases(batchSize)
[worker] claimDueEnrichmentJobs(batchSize, leaseSeconds)  [FOR UPDATE SKIP LOCKED]
   → isBuilderProcessingRestricted? → if yes, finish(cancelled)
   → getExecutableConnectors(allowlistEnv, requested)   [policy ∩ allowlist]
   → if no connectors and no submitted URLs → finish(failed, policy_denied)
   → loadWorkerEnrichmentTarget
[per connector, sequential]
   supports(target)?
   safeFetch(url, allowedHosts)   [envelope below]
   isPathAllowedByRobots(origin, path, ua)  [cache 1h, fail-closed]
   if disallowed: skip
   parse → EnrichmentEvidencePayload
   computeEvidenceContentHash(connector, sourceRecordId, payload)
   resolveEnrichmentCandidate(target, candidate)   [see resolver]
   persistEnrichmentEvidence(tx, ...)             [with expiresAt per retention]
[after all connectors]
   if retryCode and attempts < MAX: requeue with backoff (5m → 30m → 2h)
   if any accepted and any failed: finish(partial)
   if any accepted: finish(succeeded)
   else: finish(failed)
[retention] runEnrichmentRetentionPass(rawDays=30, acceptedDays=180, batch=500)
```

### The resolver — deterministic, versioned, no LLM

| Signal | Points | Trigger |
|---|---|---|
| `verified_owner_cross_link` | 10000 | Profile owner submitted the URL |
| `exact_stable_source_id` | 10000 | Candidate's source ID matches the target's source ID |
| `exact_username_reciprocal_link` | 9500 | Same username AND a reciprocal link exists |
| `exact_username` | 4000 | Same username, no reciprocal link yet |
| `exact_full_name` | 2500 | Normalized display name matches |
| `organization_agreement` | 2000 | Self-declared org matches known org |
| `location_agreement` | 1000 | Normalized location matches |
| `topic_overlap` | 0–1000 | Jaccard ratio × 1000 |

**Thresholds:**
- `accept`: ≥ 9000 bps + ≥ 2 match signals (or `isVerifiedOwnerSubmitted` alone — single signal is allowed when
  the verified owner submitted it, per spec §9/§5.3)
- `review`: ≥ 7000 bps and below accept
- `name_and_org_mismatch_cap`: if both disagree, total bps capped at 6900 regardless of other signals
- `forced_reject`: `conflicting_stable_source_id` or `verified_owner_rejected` always wins
- `resolver_version`: 1 — persisted with each evidence row so scoring can be re-run deterministically

### Retry & retention

- **Deterministic backoff**: 5 min → 30 min → 2 h on `rate_limited` or `upstream_unavailable`. After
  `ENRICHMENT_MAX_ATTEMPTS`, marked `failed`.
- **Lease**: each claim holds a lease for `ENRICHMENT_LEASE_SECONDS`. Crashed workers' jobs are reclaimed on the
  next run.
- **Retention pass**: rows older than `ENRICHMENT_RAW_RETENTION_DAYS` (30 d) for raw evidence and
  `ENRICHMENT_ACCEPTED_RETENTION_DAYS` (180 d) for accepted evidence are deleted in batches of 500.
- **Subject restriction cascade**: if a builder's processing is restricted, every active job for that identity is
  cancelled and all evidence purged — across every organization, not just the requesting one.

---

## 5. Path 4 · Platform content sync

File: `scripts/db/sync-platform-content.ts`. Trigger: `pnpm content:sync` (manual or pre-deploy hook).

### Flow

```
content/changelog/*.md   ─┐
                          ├─→ sync-platform-content.ts
content/roadmap/*.md     ─┘        ↓
                          deterministic IDs (content-changelog-<slug>, content-roadmap-<slug>)
                                   ↓
                          changelog table  +  roadmap_items table
                                   ↓
                          /changelog  +  /roadmap (public routes)
```

### Guarantees

- **Idempotent.** Re-running changes nothing unless a file changed.
- **Scope-respecting.** Never touches rows it doesn't own. File-managed rows have deterministic IDs; admin-UI rows
  have random IDs and are left alone — including by `--prune`.
- **`shipped_at` preserved.** Set once on the run that first sees `status: shipped`, never recomputed. Re-deploying
  doesn't shift the "shipped" date.
- **Votes preserved.** Roadmap votes survive because IDs are stable.
- **Reverse direction.** `--export` writes DB rows back to files, useful for the first-time migration from
  admin-UI to file-managed content.
- **Role-based.** Connects as `DATABASE_PLATFORM_URL` (the role migration 0012 grants INSERT/UPDATE/DELETE on
  these three tables) or falls back to `DATABASE_URL` (DB owner locally).

---

## 6. Persistence

| Table | Written by | Purpose |
|---|---|---|
| `enrichment_jobs` | routes / worker | Queue of evidence-refresh requests with leases, attempts, status |
| `enrichment_evidence` | worker · resolver | Scored evidence with content hash, source, expiresAt, resolver_version |
| `builder_embeddings` | discovery worker | Search-index stubs (no full payload) — semantic index pre-warmed |
| `builder_identities` | user / enrichment | Canonical person record after cross-source identity resolution |
| `organization_builders` | user / API | Tenant-scoped join: which orgs are tracking which builder |
| `discovery_state` | discovery worker | Single-row cursor + run stats (runs, upserted, errors) |
| `changelog` | content sync | Public changelog entries (deterministic IDs from markdown files) |
| `roadmap_items` | content sync + admin | Roadmap with `shipped_at` set once and preserved |

RLS enforces tenant isolation on every row except platform-level tables (`changelog`, `roadmap`, `discovery_state`).

---

## 7. Safety gate

### Two-layer policy gate

```
compile-time (frozen in policies.ts)        runtime (env)
─────────────────────────────────────       ─────────────
SOURCE_POLICIES → all four checks:          ENRICHMENT_ALLOWED_CONNECTORS
  • reviewExpiresAt in future                     (CSV of connector IDs)
  • status === 'enabled'                              ↓
  • not in HARD_BLOCKED                       getExecutableConnectors()
  • lawfulBasisReference set                       = compileSet ∩ runtimeSet

The runtime allowlist can NARROW the compile-time enabled set. It can NEVER enable a connector that isn't enabled at compile time. Tested as the "fail-closed guarantee" in policies.test.ts.
```

### `safeFetch` envelope (network.ts)

Every outbound request from a connector must go through `safeFetch()`. A static scan in `registry.test.ts`
fails any connector that calls `fetch` directly.

| Layer | What it enforces | Why |
|---|---|---|
| URL validation | HTTPS only, public IP only, no credentials in URL | SSRF: prevents the worker being turned into a proxy to internal/metadata endpoints |
| Host allowlist | `allowedHosts` per source policy, subdomain match | Defence in depth |
| Redirects | max 3 hops, host revalidated on every hop | Prevents redirect-based SSRF |
| Timeout | 10 s | Worker stays bounded |
| Byte cap | 2 MB | Prevents memory exhaustion; keeps payloads sane |
| Content-type allowlist | `json` · `html` · `plain` (+ opt-in per call) | Refuses binary; the Jobindex RSS adapter opts in to `application/rss+xml` per call |
| Charset fallback | Declared header wins, else per-call fallback | Legacy feeds declare ISO-8859-1 in prolog; decoding as UTF-8 corrupts Danish characters permanently |

### robots.txt — fail-closed with three distinct outcomes

> The comment in the code is unusually explicit: "RFC 9309 §2.3.1.3 is explicit: a 4xx on `/robots.txt` means the
> crawler **may access any resource**. A site with no robots.txt has not failed to answer — it has answered 'no
> restrictions'. Collapsing that into the same value as a timeout or a 5xx forced every caller to choose
> between refusing most of the public web and ignoring genuine failures."

| Outcome | Meaning | Connector behavior |
|---|---|---|
| `allowed` | Site answered 2xx, path passes UA-specific rules | Proceed |
| `no_robots_file` | Site answered 4xx — RFC 9309 says **permission** | Proceed (conservative callers can refuse) |
| `disallowed` | UA-specific rule matched a `Disallow` | Refuse |
| `unavailable` | Timeout, 5xx, or other real failure | Refuse (fail-closed) |

### What the spec forbids outright (spec §3)

No CAPTCHA solving · no Playwright/Patchright/Selenium · no WARP/Tor/residential proxying · no session-cookie import
· no Google dorking · no scraping of search result pages · no LinkedIn/X/Facebook/Instagram automated retrieval ·
no automatic outreach · no protected-attribute inference · no global sharing of organization-local match decisions.

---

## 8. Operations

### Worker triggers

| Route | Worker | Cadence | Returns |
|---|---|---|---|
| `/api/admin/discovery/run-worker` | `runDiscoveryWorker()` | Every 15 min | `{ cellsRun, resultsSeen, upserted, cursor, capped }` |
| `/api/admin/enrichment/*` | `runEnrichmentWorker()` | On-demand (refresh) + scheduled for eligible plans | `{ claimed, processed, succeeded, partial, failed, leasesReclaimed, evidenceAccepted, evidenceReview, retentionEvidenceDeleted, retentionJobsDeleted }` |
| `/api/admin/operations/$jobKey` | Job-specific | Manual + on schedule | Per-job result + `lastRunAt` history |
| `pnpm content:sync` | Sync script | Manual + pre-deploy hook | `{ inserted, updated, pruned }` |

### Settings (env)

| Var | Default | Meaning |
|---|---|---|
| `ENRICHMENT_ENABLED` | `false` | Master switch — `false` everywhere until the canary passes |
| `ENRICHMENT_ALLOWED_CONNECTORS` | (empty) | CSV of connector IDs — cannot enable a connector that isn't enabled at compile time |
| `ENRICHMENT_BATCH_SIZE` | (configured) | Jobs claimed per run |
| `ENRICHMENT_LEASE_SECONDS` | (configured) | How long a claim is held before another worker can reclaim it |
| `ENRICHMENT_MAX_ATTEMPTS` | (configured) | After this many failures, mark `failed` permanently |
| `ENRICHMENT_RAW_RETENTION_DAYS` | `30` | Retention for evidence that was not accepted |
| `ENRICHMENT_ACCEPTED_RETENTION_DAYS` | `180` | Retention for accepted evidence |
| `DISCOVERY_CELLS_PER_RUN` | (configured) | How many matrix cells to walk per run |
| `DISCOVERY_DAILY_STUB_CAP` | (configured) | Hard ceiling on stubs per day — bounds third-party API spend |
| `ENRICHMENT_USER_AGENT` | `BuilderHuntBot/1.0 (+https://builderhunt.dev/crawler)` | Override the default UA |

---

## File map (where to look)

| Concern | Files |
|---|---|
| Source contract | `src/lib/sources/types.ts` |
| 15 connectors | `src/lib/sources/{github,gitlab,codeberg,sourcehut,hn,reddit,devto,hashnode,stackoverflow,npm,huggingface,lobsters,devpost,producthunt,bluesky}.ts` |
| GitHub client internals | `src/lib/github/{content,repo-signals,work-sample}.ts` |
| Discovery worker | `src/lib/discovery/{worker,matrix}.ts` |
| Enrichment worker | `src/lib/enrichment/worker.ts` |
| Enrichment registry | `src/lib/enrichment/registry.ts` |
| Enrichment policies | `src/lib/enrichment/policies.ts` |
| Network safety envelope | `src/lib/enrichment/network.ts` |
| robots.txt | `src/lib/enrichment/robots.ts` |
| Resolver (scoring) | `src/lib/enrichment/resolver.ts` |
| Connector examples | `src/lib/enrichment/connectors/{github,user-submitted}.ts` |
| Content sync | `scripts/db/sync-platform-content.ts` |
| Backfills | `scripts/db/backfills/{builders,organizations,resources,stripe-billing-legacy}.ts` |
| Admin API | `src/routes/api/admin/{enrichment,discovery,operations,solutions}/` |
| Public + auth API | `src/routes/api/{queries,search,builders,builders/$builderId}/` |
| Spec | `plans/phase-1/42-stealth-scraping/{spec,task,implementation_plan}.md` |
| Source register (per-source lawful basis detail) | `docs/operations/public-enrichment-source-register.md` |

---

*Refresh this document after any structural change to the enrichment pipeline or source connector set.*
