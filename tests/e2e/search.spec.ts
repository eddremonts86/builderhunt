/**
 * Ranking before-images for both search modes (plans/phase-3/11-migrate-search).
 *
 * Plan 11 replaces `page`/`perPage` on both search endpoints with a signed continuation and bounds
 * every response to `TABLE_PAGE_SIZE`. The one thing that must survive that untouched is the
 * *order* — relevance ranking is the product, and a pagination change that quietly reshuffles it
 * would look like a success in every other assertion. So the order is recorded here, from the
 * unchanged endpoints, into `fixtures/search-ranking.json`, and every later run compares against it.
 *
 * ## What makes this deterministic
 *
 * **Keyword mode** never contacts a connector: the spec seeds the app's own Redis cache under the
 * exact key `src/lib/search.ts` computes, and `searchBuildersWithStatus` reads that cache before it
 * reaches any provider. The seeded rows carry no `metadata.lastSeen`, which is the only input
 * `scoreBuilders` derives from `Date.now()` — so the fused ranking is a pure function of the seed.
 *
 * **Semantic mode** uses `E2E_EMBEDDINGS_SCENARIO=success`, whose `deterministicE2EVector` is a pure
 * FNV-1a hash: the same string yields the same vector here and in the spawned app server, so the
 * spec can seed `builder_embeddings` rows at *chosen* distances from the query's vector.
 *
 * Similarities are seeded strictly decreasing and far apart on purpose. Today's local leg orders by
 * `ORDER BY embedding <=> $vec` and nothing else — there is no tiebreaker — so two rows at the same
 * distance come back in whatever order the index produced, and a before-image over tied rows would
 * record noise and fail on the second run. That missing total order is what plan 11's fourth task
 * adds; until it exists, a deterministic before-image can only be taken over distinct distances.
 *
 * ## Recording
 *
 * `E2E_RECORD_SEARCH_RANKING=1` rewrites the fixture instead of asserting against it. Run it twice
 * and diff: the file is byte-identical by construction, since nothing time- or duration-derived is
 * written into it (`durationMs` is dropped, not normalised to a placeholder — a cache hit reports 0
 * for it anyway, and keeping a field whose only honest value is "not measured" would invite reading
 * meaning into it).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

// Plain Node process — nothing auto-loads `.env` the way vite/vitest do.
loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { createOwnerPrincipal, disposePrincipal, type FixtureContext, type Principal } from './harness/fixtures/principals'
import { cachedSearchBuilders, searchCacheKey, seedSearchCache, type CachedSearchBuilder } from './harness/fixtures/search-cache'

const FIXTURE_PATH = new URL('./fixtures/search-ranking.json', import.meta.url).pathname
const RECORDING = process.env.E2E_RECORD_SEARCH_RANKING === '1'

/** The keyword probe. The route splits this on `/[,\s]+/` before it reaches the cache key. */
const KEYWORD_QUERY = 'deterministic ranking probe'
const KEYWORD_TERMS = KEYWORD_QUERY.split(/[,\s]+/).filter(Boolean)
/**
 * Two sources, so the record exercises `fuseByRank`'s cross-source interleave rather than a single
 * source's score order. Both are seeded `enabled` by `drizzle/0126_search_source_register.sql`, and
 * neither is in `CREDENTIAL_MANDATORY_SOURCES` — an unconfigured source reports `unconfigured` and
 * contributes nothing, which would make the fixture depend on this machine's `.env`.
 */
const KEYWORD_SOURCES = ['github', 'hn'] as const
/**
 * What each connector is asked for, and therefore part of the cache key. Not the response size:
 * every source is asked for this many, so the response holds up to `sources × 30` rows — which is
 * the unbounded shape plan 11 replaces, and why the seed is deliberately larger than one page.
 */
const PROVIDER_PER_PAGE = 30

const SEMANTIC_QUERY = 'a deterministic semantic ranking probe for plan eleven'
const SEMANTIC_OTHER_TEXT = 'e2e-search-ranking-unrelated-direction'
/** Twelve clears `SEMANTIC_MIN_LOCAL_MATCHES` (10), so the local leg answers without degrading. */
const SEMANTIC_ROW_COUNT = 12
/** Mix step per row: row *i* is `probe*(1-i*step) + other*(i*step)`. Coarse on purpose — see above. */
const SEMANTIC_MIX_STEP = 0.03

interface RankingFixture {
  keyword: {
    query: string
    sources: string[]
    /** Every id the unchanged endpoint returned for provider page one, in order. */
    orderedIds: string[]
    /** Per-source health as the endpoint reported it, minus `durationMs`. */
    sourceHealth: Array<{ source: string; health: string; resultCount: number }>
    degraded: boolean
  }
  semantic: {
    query: string
    mode: string
    orderedIds: string[]
  }
}

function dot(a: number[], b: number[]): number {
  return a.reduce((sum, value, index) => sum + value * b[index], 0)
}
function cosineSimilarity(a: number[], b: number[]): number {
  return dot(a, b) / (Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b)))
}

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  owner: Principal
  semanticSourceIds: string[]
}

let harness: Harness
let toreDown = false

/** The fixture is written by one test and read by another — never interleave them. */
test.describe.configure({ mode: 'serial' })

/**
 * Two sources whose scores interleave rather than stacking.
 *
 * `fuseByRank` ranks within each source and gives rank *n* the same reciprocal weight in both, so
 * seeds that made one source uniformly stronger would produce a fixture that only proves "github
 * first, then hn". Alternating follower magnitudes and topic counts makes the recorded order a real
 * fusion of two rankings, which is the thing that must not drift.
 */
function keywordSeed(providerPage: number): CachedSearchBuilder[] {
  const label = `rank-p${providerPage}`
  return [
    ...cachedSearchBuilders(`${label}-gh`, PROVIDER_PER_PAGE, {
      source: 'github',
      followers: (index) => 12_000 - index * 370,
      topics: (index) => Array.from({ length: index % 5 }, (_, t) => `gh-topic-${t}`),
    }),
    ...cachedSearchBuilders(`${label}-hn`, PROVIDER_PER_PAGE, {
      source: 'hn',
      followers: (index) => 9_500 - index * 290,
      topics: (index) => Array.from({ length: (index + 2) % 5 }, (_, t) => `hn-topic-${t}`),
    }),
  ]
}

test.beforeAll(async () => {
  // Disposable DB + migrations + vite dev server boot — far beyond 30s.
  test.setTimeout(300_000)

  ensureFixedTimeEnv()
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  // Must be set BEFORE `startWorkerServer` spawns the app process — it inherits the parent's
  // `process.env` at spawn time (see harness/server.ts).
  process.env.E2E_EMBEDDINGS_SCENARIO = 'success'

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const db = sql
    const ctx: FixtureContext = { baseURL: server.baseURL, sql: db, scope: `w${workerIndex}-searchrank` }
    const clock = fixedClockFromEnv()

    const { principal: owner } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 1, clock })

    // Provider pages one and two, because a federated "page two" is a second upstream request
    // rather than a slice of a set already held — an unseeded page two would leave the cache and
    // reach the live internet.
    for (const providerPage of [1, 2]) {
      await seedSearchCache(
        cache.prefix,
        searchCacheKey(KEYWORD_TERMS, PROVIDER_PER_PAGE, KEYWORD_SOURCES, providerPage),
        keywordSeed(providerPage),
      )
    }

    // Dynamic import: this file's static imports are hoisted above `loadHarnessEnv`, and
    // `embeddings.ts` transitively imports `~/shared/lib/env`, whose module-level parse needs
    // APP_URL/VITE_APP_URL already present.
    const { deterministicE2EVector } = await import('../../src/shared/lib/ai/embeddings')

    // Read the dimension from the migrated column rather than trusting `AI_EMBEDDING_DIM` parity
    // between this process and the spawned app server.
    const [column] = await db<{ atttypmod: number }[]>`
      select atttypmod from pg_attribute
      where attrelid = 'builder_embeddings'::regclass and attname = 'embedding'
    `
    const dim = column.atttypmod

    const probe = deterministicE2EVector(SEMANTIC_QUERY, dim)
    const other = deterministicE2EVector(SEMANTIC_OTHER_TEXT, dim)

    const semanticSourceIds: string[] = []
    const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`
    const seedEmbedding = (sourceId: string, embedding: number[]) => db`
      insert into builder_embeddings
        (id, source, source_id, content_hash, document, profile, embedding, embedded_at, created_at, updated_at)
      values (
        ${`e2e-rank-${sourceId}`}, 'e2e', ${sourceId}, ${`hash-${sourceId}`}, ${`document for ${sourceId}`},
        ${db.json({ username: sourceId, profileUrl: `https://example.test/${sourceId}`, topics: [] })},
        ${toVectorLiteral(embedding)}::vector, now(), now(), now()
      )
    `

    let previous = Number.POSITIVE_INFINITY
    for (let index = 0; index < SEMANTIC_ROW_COUNT; index++) {
      const mix = index * SEMANTIC_MIX_STEP
      // `Math.fround` is not decoration: pgvector stores float4, so two vectors that differ only
      // below single precision are the *same* row content once stored, and their distances tie.
      // Computing the expected similarity from the rounded vector is what makes the assertion below
      // a statement about what Postgres will actually see.
      const vector = probe.map((value, position) => Math.fround(value * (1 - mix) + other[position] * mix))
      const similarity = cosineSimilarity(vector, probe)
      expect(similarity, `row ${index} must clear SEMANTIC_SIMILARITY_THRESHOLD`).toBeGreaterThan(0.6)
      expect(similarity, `row ${index} must rank strictly below row ${index - 1}`).toBeLessThan(previous)
      previous = similarity
      const sourceId = `rank-${String(index).padStart(2, '0')}`
      semanticSourceIds.push(sourceId)
      await seedEmbedding(sourceId, vector)
    }

    // One row the threshold must exclude, so the fixture records a filtered set rather than
    // "everything that was seeded".
    expect(cosineSimilarity(other, probe), 'the noise direction must fall below the threshold').toBeLessThan(0.6)
    await seedEmbedding('rank-noise', other.map(Math.fround))

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql: db,
      owner,
      semanticSourceIds,
    }
  } catch (error) {
    // Never leak the worker's server/database/redis on a failed setup.
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  if (toreDown) return
  toreDown = true
  const h = harness
  if (!h) return
  await disposePrincipal(h.owner).catch(() => undefined)
  await h.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(h.workerIndex)
  const admin = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${h.databaseName} and pid <> pg_backend_pid()
    `
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined)
  }
  await dropWorkerDatabase(h.workerIndex, h.databaseName)
  await dropWorkerRedisNamespace(h.redisPrefix)
  delete process.env.E2E_EMBEDDINGS_SCENARIO
})

function readFixture(): RankingFixture {
  try {
    return JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as RankingFixture
  } catch {
    throw new Error(
      `Missing or unreadable ${FIXTURE_PATH}. Record it with `
      + `E2E_RECORD_SEARCH_RANKING=1 pnpm exec playwright test --project=chromium tests/e2e/search.spec.ts`,
    )
  }
}

/** Recorded pieces accumulate across the two tests; the last one writes the file. */
const recorded: Partial<RankingFixture> = {}

function finishRecording(): void {
  if (!RECORDING) return
  if (!recorded.keyword || !recorded.semantic) return
  // Two spaces and a trailing newline: whatever the shape, the same input has to produce the same
  // bytes, which is the property the plan asks to verify by running this twice.
  writeFileSync(FIXTURE_PATH, `${JSON.stringify(recorded, null, 2)}\n`, 'utf8')
}

interface KeywordResponse {
  builders: Array<{ id: string; source: string }>
  nextCursor: string | null
  total: number | null
  consistency: string
  sources: Array<{ source: string; health: string; resultCount: number; durationMs: number }>
  degraded: boolean
}

async function keywordPage(cursor: string | null): Promise<KeywordResponse> {
  const response = await harness.owner.api!.post('/api/search/builders', {
    data: { keywords: KEYWORD_QUERY, sources: [...KEYWORD_SOURCES], cursor },
  })
  expect(response.ok(), `status ${response.status()}: ${await response.text()}`).toBe(true)
  return await response.json() as KeywordResponse
}

test('keyword search returns a stable fused ranking across two sources', async () => {
  /*
   * Exactly two pages: 60 fused rows from one provider fan-out, sliced at `TABLE_PAGE_SIZE`.
   *
   * The second page's cursor points at provider page *two* and is deliberately not followed —
   * beyond it lie provider pages this spec has not seeded, which would leave the cache and reach
   * the live internet.
   */
  const first = await keywordPage(null)
  expect(first.builders).toHaveLength(50)
  expect(first.nextCursor).not.toBeNull()
  expect(first.total, 'a federation cannot count without exhausting every upstream').toBeNull()
  expect(first.consistency).toBe('provider-best-effort')

  const second = await keywordPage(first.nextCursor)
  expect(second.builders).toHaveLength(10)

  const builders = [...first.builders, ...second.builders]
  const observed: RankingFixture['keyword'] = {
    query: KEYWORD_QUERY,
    sources: [...KEYWORD_SOURCES],
    orderedIds: builders.map((builder) => builder.id),
    // `durationMs` is dropped rather than zeroed — see the file header.
    sourceHealth: first.sources
      .map(({ source, health, resultCount }) => ({ source, health, resultCount }))
      .sort((a, b) => a.source.localeCompare(b.source)),
    degraded: first.degraded,
  }

  // The seed is two sources of 30, and the two slices are that fan-out in its original order.
  expect(observed.orderedIds).toHaveLength(2 * PROVIDER_PER_PAGE)
  expect(new Set(observed.orderedIds).size, 'ids must be unique').toBe(observed.orderedIds.length)
  expect(
    new Set(builders.slice(0, 10).map((builder) => builder.source)).size,
    'the top of the ranking must interleave both sources, or the fixture proves nothing about fusion',
  ).toBe(2)

  if (RECORDING) {
    recorded.keyword = observed
    finishRecording()
    return
  }
  // The whole point of the fixture: the ordering recorded from the unbounded endpoint, reproduced
  // by the bounded one.
  expect(observed).toEqual(readFixture().keyword)
})

test('a keyword cursor is refused once the query changes', async () => {
  const first = await keywordPage(null)
  const response = await harness.owner.api!.post('/api/search/builders', {
    data: { keywords: 'a different query entirely', sources: [...KEYWORD_SOURCES], cursor: first.nextCursor },
  })
  expect(response.status()).toBe(400)
  expect((await response.json()).error).toMatch(/query or filter mismatch/)
})

test('semantic search returns a stable distance ranking @requires-embeddings', async () => {
  const response = await harness.owner.api!.post('/api/search/semantic', {
    data: { query: SEMANTIC_QUERY },
  })
  expect(response.ok(), `status ${response.status()}: ${await response.text()}`).toBe(true)
  const body = await response.json() as {
    mode: string
    builders: Array<{ source: string; sourceId: string }>
    nextCursor: string | null
    total: number | null
    consistency: string
  }

  // Twelve above-threshold rows fit inside one `TABLE_PAGE_SIZE` page, so the walk ends here.
  expect(body.nextCursor).toBeNull()
  expect(body.total).toBeNull()
  // A keyset over a total order, but an approximate candidate set — neither `exact` nor a third
  // party's best effort. See `PageConsistency`.
  expect(body.consistency).toBe('approximate')

  const observed: RankingFixture['semantic'] = {
    query: SEMANTIC_QUERY,
    mode: body.mode,
    orderedIds: body.builders.filter((builder) => builder.source === 'e2e').map((builder) => builder.sourceId),
  }

  // Local leg only — 12 kept matches clear `SEMANTIC_MIN_LOCAL_MATCHES`, so no federated leg ran
  // and no third-party API was contacted.
  expect(observed.mode).toBe('semantic')
  expect(observed.orderedIds).toEqual(harness.semanticSourceIds)
  expect(observed.orderedIds, 'the below-threshold row must not appear').not.toContain('rank-noise')

  if (RECORDING) {
    recorded.semantic = observed
    finishRecording()
    return
  }
  expect(observed).toEqual(readFixture().semantic)
})
