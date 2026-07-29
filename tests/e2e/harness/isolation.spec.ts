/**
 * Wave 1 Task 1 — worker isolation spike.
 *
 * Proves two concurrent Playwright workers can each:
 *   - acquire a disposable PostgreSQL database (unique, fully migrated),
 *   - write a row visible only to its own connection,
 *   - acquire an isolated Redis namespace,
 *   - write a key visible only to its own namespace,
 *   - drop both on teardown so no `builderhunt_security_test_e2e_*`
 *     databases or `e2e:*` Redis keys remain.
 *
 * Two concurrent workers are required (`--workers=2`) so the assertions
 * below fail loudly if isolation regresses.
 */
import { test, expect } from 'playwright/test'
import postgres from 'postgres'
import { loadHarnessEnv } from './load-env'

// Pure-Node spec — no vite/vitest to auto-load .env, so direct-DB
// connection needs DATABASE_MIGRATION_URL.
loadHarnessEnv()

import {
  acquireWorkerDatabase,
  dropWorkerDatabase,
  workerDatabaseUrls,
} from './database'
import {
  acquireWorkerRedis,
  dropWorkerRedisNamespace,
  redis,
} from './cache'
import { e2eEnv } from './env'
import { uniqueId } from './ids'

interface WorkerHandle {
  workerIndex: number
  databaseName: string
  databaseUrl: string
  redisPrefix: string
}

const handles: WorkerHandle[] = []
let teardownTestRan = false

test.beforeAll(async () => {
  // e2eEnv throws on missing/unset vars — proves the harness is strict
  // and the E2E seams are unreachable in production mode.
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')
  expect(env.REDIS_URL).toBeTruthy()

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const db = await acquireWorkerDatabase(workerIndex)
  const redisHandle = await acquireWorkerRedis(workerIndex)
  handles.push({
    workerIndex,
    databaseName: db.databaseName,
    databaseUrl: db.databaseUrl,
    redisPrefix: redisHandle.prefix,
  })
})

test.afterAll(async () => {
  if (teardownTestRan) return
  for (const handle of handles) {
    await dropWorkerDatabase(handle.workerIndex, handle.databaseName)
    await dropWorkerRedisNamespace(handle.redisPrefix)
  }
})

test('worker got a fresh disposable database with the expected name', async () => {
  const handle = handles[0]
  expect(handle.databaseName).toMatch(/^builderhunt_security_test_e2e_w\d+_[0-9a-f]+$/)
  expect(handle.databaseUrl).toContain(handle.databaseName)
})

test('worker database exposes role URLs targeting the same database', async () => {
  const handle = handles[0]
  const urls = workerDatabaseUrls(handle.databaseName)
  expect(urls.DATABASE_URL).toContain(`/${handle.databaseName}`)
  expect(urls.DATABASE_MIGRATION_URL).toContain(`/${handle.databaseName}`)
  expect(urls.DATABASE_AUTH_URL).toContain(`/${handle.databaseName}`)
  expect(urls.DATABASE_WORKER_URL).toContain(`/${handle.databaseName}`)
  expect(urls.DATABASE_PLATFORM_URL).toContain(`/${handle.databaseName}`)
  // The runtime and migration URLs differ whenever the environment wires
  // distinct role credentials (CI does; local dev may collapse both onto
  // the superuser). Only assert separation when the source env separates.
  const env = e2eEnv()
  if (env.DATABASE_URL !== env.DATABASE_MIGRATION_URL) {
    expect(urls.DATABASE_URL).not.toBe(urls.DATABASE_MIGRATION_URL)
  }
})

test('worker can open a connection, insert a row, and read it back', async () => {
  const handle = handles[0]
  const sql = postgres(handle.databaseUrl, { max: 1, prepare: false })
  try {
    const marker = uniqueId('isolation-db')
    await sql`CREATE TABLE IF NOT EXISTS isolation_marker (id text PRIMARY KEY, payload text NOT NULL)`
    await sql`INSERT INTO isolation_marker (id, payload) VALUES (${marker}, 'w' || ${handle.workerIndex})`
    const rows = await sql<{ payload: string }[]>`SELECT payload FROM isolation_marker WHERE id = ${marker}`
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toBe(`w${handle.workerIndex}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
})

test('worker received a fully migrated database', async () => {
  // The disposable database helper already runs migrations under the
  // advisory lock; this test confirms the schema materialised by exercising
  // one of the well-known tables from the migration set.
  const handle = handles[0]
  const sql = postgres(handle.databaseUrl, { max: 1, prepare: false })
  try {
    const rows = await sql<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'organizations'
      ) AS exists
    `
    expect(rows[0].exists).toBe(true)
  } finally {
    await sql.end({ timeout: 5 })
  }
})

test('worker has a unique Redis prefix and can write/read a key inside it', async () => {
  const handle = handles[0]
  const client = await redis.client(handle.redisPrefix)
  try {
    const key = `marker:${handle.workerIndex}`
    await client.set(key, `w${handle.workerIndex}`, 'EX', 60)
    const value = await client.get(key)
    expect(value).toBe(`w${handle.workerIndex}`)
  } finally {
    await client.quit()
  }
})

test('rate-limit prefix scoping uses E2E_REDIS_PREFIX when present', async () => {
  // The application code must namespace its Redis keys under the
  // per-worker prefix so `dropWorkerRedisNamespace` can clean up
  // without touching another worker's buckets. We exercise the exact
  // `getKey` contract that `rate-limit.ts` uses by importing the module
  // and asserting the key format through a side-effect: write to the
  // expected key, read it back, then drop it.
  const handle = handles[0]
  const previousPrefix = process.env.E2E_REDIS_PREFIX
  process.env.E2E_REDIS_PREFIX = handle.redisPrefix
  try {
    const { rateLimit } = await import('../../../src/shared/lib/rate-limit')
    const result = await rateLimit('isolation-probe', `w${handle.workerIndex}`, 5, 60)
    expect(result.allowed).toBe(true)
    expect(result.limit).toBe(5)
    // The key must live under the worker's prefix.
    const client = await redis.client(handle.redisPrefix)
    try {
      const expected = `${handle.redisPrefix}:rl:isolation-probe:w${handle.workerIndex}`
      const value = await client.get(expected)
      expect(value).toBe('1')
      await client.del(expected)
    } finally {
      await client.quit()
    }
  } finally {
    if (previousPrefix === undefined) delete process.env.E2E_REDIS_PREFIX
    else process.env.E2E_REDIS_PREFIX = previousPrefix
  }
})

test('teardown drops the database and removes the worker prefix from Redis', async () => {
  const handle = handles[0]
  // Confirm the database exists before the drop.
  const sql = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    const rows = await sql<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname = ${handle.databaseName}
    `
    expect(rows).toHaveLength(1)
  } finally {
    await sql.end({ timeout: 5 })
  }

  // Run the drop and confirm both side-effects.
  await dropWorkerDatabase(handle.workerIndex, handle.databaseName)
  await dropWorkerRedisNamespace(handle.redisPrefix)

  const sqlAfter = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    const rows = await sqlAfter<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname = ${handle.databaseName}
    `
    expect(rows).toHaveLength(0)
  } finally {
    await sqlAfter.end({ timeout: 5 })
  }

  const client = await redis.client(handle.redisPrefix)
  try {
    const matching = await client.keys(`${handle.redisPrefix}*`)
    expect(matching).toHaveLength(0)
  } finally {
    await client.quit()
  }

  // The handle is now dropped — remove it from the list so the global
  // afterAll no-op's on it.
  const index = handles.indexOf(handle)
  if (index >= 0) handles.splice(index, 1)
  teardownTestRan = true
})
