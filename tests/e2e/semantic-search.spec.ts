/**
 * E2E coverage for `POST /api/search/semantic` — closes a gap flagged while
 * fixing the HNSW ordering defect in `findSimilarBuilderEmbeddings`
 * (`src/shared/lib/repositories/public-builder-embeddings.ts`): that fix
 * was proven at the unit level (an EXPLAIN-based regression test plus a
 * manual before/after HTTP comparison run by hand), but no automated E2E
 * spec exercised the route itself. This file is that spec — real Better
 * Auth sign-up, a real `pro` entitlement, a real per-worker disposable
 * Postgres (migrated with the same `builder_embeddings_hnsw_idx` HNSW
 * index production uses), and the real route/service/repository call
 * chain (`semantic.ts` → `semantic-search.ts` → `public-builder-
 * embeddings.ts`).
 *
 * The one seam that IS faked: the embedding HTTP boundary itself
 * (`E2E_EMBEDDINGS_SCENARIO=success`, see `src/shared/lib/ai/embeddings.ts`)
 * — this suite is about proving the retrieval/auth/entitlement/ordering
 * plumbing, not about testing a real embedding provider. `success` maps
 * any input string through `deterministicE2EVector`, a pure FNV-1a hash —
 * same string always yields the identical vector, in this process and in
 * the spawned app server, so we can compute the exact vector the server
 * will embed the query into and seed `builder_embeddings` rows with a
 * known, deliberate relationship to it:
 *
 *   - 9 rows whose embedding IS the query's vector (similarity = 1.0)
 *   - 1 row whose embedding is the elementwise average of the query's
 *     vector and an unrelated one (similarity ≈ 0.71 — distinct and
 *     strictly lower, so ordering is a non-trivial, non-tied assertion)
 *   - 1 row whose embedding is an unrelated vector (similarity ≈ -0.05 —
 *     below `SEMANTIC_SIMILARITY_THRESHOLD`, must be excluded)
 *
 * 9 + 1 = 10 = `SEMANTIC_MIN_LOCAL_MATCHES`, so the route returns
 * `mode: 'semantic'` without falling down the federated degradation
 * ladder — no network egress, no other AI task fired.
 */
import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { config as loadEnv } from 'dotenv'

// Plain Node process — nothing auto-loads `.env` the way vite/vitest do.
loadEnv({ path: '.env' })

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { ensureFixedTimeEnv, fixedClockFromEnv } from './harness/clock'
import { createOwnerPrincipal, disposePrincipal, type FixtureContext, type Principal } from './harness/fixtures/principals'

const QUERY_TEXT = 'experienced rust systems programmer working on databases'
const OTHER_SEED_TEXT = 'e2e-semantic-search-other-seed-text'
const NOISE_SEED_TEXT = 'e2e-semantic-search-noise-seed-text'

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
  expectedMidSimilarity: number
  exactSourceIds: string[]
  midSourceId: string
  noiseSourceId: string
}

let harness: Harness
let toreDown = false

// The free-tier denial test flips the seeded organization's entitlement
// tier and restores it — must run after the semantic-match test, never
// interleaved with it.
test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // Disposable DB + migrations + vite dev server boot — far beyond 30s.
  test.setTimeout(300_000)

  ensureFixedTimeEnv()
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  // Must be set BEFORE `startWorkerServer` spawns the app process — it
  // inherits the parent's `process.env` at spawn time (see harness/server.ts).
  process.env.E2E_EMBEDDINGS_SCENARIO = 'success'

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    // `sql` stays `let ... | undefined` so the catch below can close a
    // connection opened before a later step threw. The body uses this const
    // instead: a closure (`seedRow`) cannot carry the non-undefined narrowing,
    // so the tagged-template call would not typecheck through the mutable one.
    const db = sql
    const ctx: FixtureContext = { baseURL: server.baseURL, sql: db, scope: `w${workerIndex}-semsearch` }
    const clock = fixedClockFromEnv()

    const { principal: owner } = await createOwnerPrincipal(ctx, { tier: 'pro', seatLimit: 1, clock })

    // Dynamic import: this file's static imports are hoisted above the
    // `loadEnv` call above (ESM import-hoisting), but `embeddings.ts`
    // transitively imports `~/shared/lib/env`, whose module-level parse
    // needs APP_URL/VITE_APP_URL already in `process.env` — a dynamic
    // import runs at this line, after `loadEnv` has already populated them.
    const { deterministicE2EVector } = await import('../../src/shared/lib/ai/embeddings')

    // Read the dimension from the migrated column rather than trusting
    // `AI_EMBEDDING_DIM` parity between this process and the spawned app
    // server — same defensive rationale as the unit regression test in
    // `public-builder-embeddings.test.ts`.
    const [column] = await db<{ atttypmod: number }[]>`
      select atttypmod from pg_attribute
      where attrelid = 'builder_embeddings'::regclass and attname = 'embedding'
    `
    const dim = column.atttypmod

    const probe = deterministicE2EVector(QUERY_TEXT, dim)
    const other = deterministicE2EVector(OTHER_SEED_TEXT, dim)
    const noise = deterministicE2EVector(NOISE_SEED_TEXT, dim)
    const vMid = probe.map((value, index) => (value + other[index]) / 2)
    const expectedMidSimilarity = cosineSimilarity(vMid, probe)
    // Sanity checks on the fixed hash's output for these literal strings —
    // deterministic and stable forever, but if `deterministicE2EVector`
    // ever changes shape, fail here with a clear message instead of a
    // confusing assertion mismatch three steps down in the real test.
    expect(expectedMidSimilarity, 'mid vector similarity must clear the semantic threshold').toBeGreaterThan(0.6)
    expect(expectedMidSimilarity, 'mid vector must be distinguishable from an exact match').toBeLessThan(0.99)
    expect(cosineSimilarity(noise, probe), 'noise vector must fall below the semantic threshold').toBeLessThan(0.6)

    const toVectorLiteral = (vector: number[]): string => `[${vector.join(',')}]`
    const exactSourceIds = Array.from({ length: 9 }, (_, i) => `exact-${i}`)
    const midSourceId = 'mid-match'
    const noiseSourceId = 'noise'

    const seedRow = (sourceId: string, embedding: number[]) => db`
      insert into builder_embeddings
        (id, source, source_id, content_hash, document, profile, embedding, embedded_at, created_at, updated_at)
      values (
        ${`e2e-embed-${sourceId}`}, 'e2e', ${sourceId}, ${`hash-${sourceId}`}, ${`document for ${sourceId}`},
        ${db.json({ username: sourceId, profileUrl: `https://example.test/${sourceId}`, topics: [] })},
        ${toVectorLiteral(embedding)}::vector, now(), now(), now()
      )
    `
    for (const sourceId of exactSourceIds) await seedRow(sourceId, probe)
    await seedRow(midSourceId, vMid)
    await seedRow(noiseSourceId, noise)

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql: db,
      owner,
      expectedMidSimilarity,
      exactSourceIds,
      midSourceId,
      noiseSourceId,
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

/*
 * Excluded from CI (`--grep-invert=@requires-embeddings` in quality.yml).
 *
 * It passes locally and returns `mode: "keyword-fallback"` on the runner, so
 * the search degrades exactly as designed rather than breaking — but the
 * assertion below is about the semantic path, and a green result that never
 * exercised it would be worse than an honest exclusion. The likely difference
 * is that a developer machine has a real embedding provider configured while
 * CI has none, so locally the test passes through the provider and never
 * proves the `E2E_EMBEDDINGS_SCENARIO=success` fake works at all. Diagnosing
 * that is tracked in plans/phase-1/53-exhaustive-local-e2e-design; do not silence
 * it by weakening the assertion.
 */
test('a pro-tier user gets HNSW-ordered semantic matches, correctly thresholded @requires-embeddings', async () => {
  const response = await harness.owner.api!.post('/api/search/semantic', {
    data: { query: QUERY_TEXT, perPage: 30 },
  })
  expect(response.ok(), `status ${response.status()}: ${await response.text()}`).toBe(true)
  const body = await response.json() as {
    mode: string
    builders: Array<{ source: string; sourceId: string; similarity?: number }>
  }

  // Enough local matches (10 >= SEMANTIC_MIN_LOCAL_MATCHES) — no federated
  // fallback, no query-translate call.
  expect(body.mode).toBe('semantic')

  const ourBuilders = body.builders.filter((b) => b.source === 'e2e')
  const ourIds = ourBuilders.map((b) => b.sourceId)

  // The below-threshold row never appears.
  expect(ourIds).not.toContain(harness.noiseSourceId)

  // All 9 exact matches and the 1 mid match are present — exactly once each.
  for (const sourceId of harness.exactSourceIds) expect(ourIds).toContain(sourceId)
  expect(ourIds).toContain(harness.midSourceId)
  expect(ourIds).toHaveLength(harness.exactSourceIds.length + 1)

  // Ordering: the exact matches (similarity 1.0) all outrank the mid match
  // (similarity ≈ 0.71) — a real, non-tied similarity-descending check.
  const midIndex = ourIds.indexOf(harness.midSourceId)
  expect(midIndex).toBe(ourBuilders.length - 1)
  for (let i = 0; i < midIndex; i++) {
    expect(ourBuilders[i].similarity, `exact match "${ourBuilders[i].sourceId}"`).toBeCloseTo(1, 5)
  }
  expect(ourBuilders[midIndex].similarity, 'mid match similarity').toBeCloseTo(harness.expectedMidSimilarity, 5)
})

test('a free-tier organization is denied before any retrieval happens', async () => {
  await harness.sql`update organization_entitlements set tier = 'free' where organization_id = ${harness.owner.organizationId}`
  try {
    const response = await harness.owner.api!.post('/api/search/semantic', { data: { query: QUERY_TEXT } })
    expect(response.status()).toBe(403)
    expect((await response.json()).error).toBe('plan')
  } finally {
    await harness.sql`update organization_entitlements set tier = 'pro' where organization_id = ${harness.owner.organizationId}`
  }
})
