/**
 * Per-surface search indexing: the admin switch, and the three places it has to
 * take effect at once.
 *
 * The value of an end-to-end test here is specific. A robots directive is only
 * honoured if it is in the SERVER-RENDERED response — a tag added after
 * hydration is not a directive — and a page that says `noindex` in its head
 * while `robots.txt` says `Allow` and `sitemap.xml` lists it is three
 * instructions in disagreement. Unit tests cover the pure formatting; only this
 * proves the real response carries it.
 *
 * Runs against a per-worker disposable database + Redis namespace + dedicated
 * app server, like the other suites in this directory.
 */
import { test, expect } from 'playwright/test'
import postgres, { type Sql } from 'postgres'
import { loadHarnessEnv } from './harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from './harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from './harness/cache'
import { startWorkerServer, stopWorkerServer } from './harness/server'
import { e2eEnv } from './harness/env'
import { newApiContext, type StorageState } from './harness/auth'
import type { FixtureContext, Principal } from './harness/fixtures/principals'
import { disposePrincipal } from './harness/fixtures/principals'
import {
  createPlatformAdminPrincipal,
  registerPlatformAdminEnv,
  reservePlatformAdminSeed,
} from './harness/fixtures/platform-admin'

interface Harness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  admin: Principal
  adminState: StorageState
}

let harness: Harness

/** The surfaces the registry governs, mirrored here so a drift is visible. */
const SURFACES = ['blog', 'changelog', 'roadmap'] as const

/** Reads the robots + googlebot directives out of a server-rendered document. */
async function robotsOf(path: string): Promise<{ robots: string | null; googlebot: string | null }> {
  const api = await newApiContext(harness.baseURL)
  try {
    const response = await api.get(path)
    expect(response.status(), `${path} should render`).toBe(200)
    const html = await response.text()
    const read = (name: string) =>
      html.match(new RegExp(`<meta[^>]*name="${name}"[^>]*content="([^"]*)"`))?.[1]
      ?? html.match(new RegExp(`<meta[^>]*content="([^"]*)"[^>]*name="${name}"`))?.[1]
      ?? null
    return { robots: read('robots'), googlebot: read('googlebot') }
  } finally {
    await api.dispose()
  }
}

async function textOf(path: string): Promise<string> {
  const api = await newApiContext(harness.baseURL)
  try {
    const response = await api.get(path)
    expect(response.status()).toBe(200)
    return await response.text()
  } finally {
    await api.dispose()
  }
}

async function setDirectives(
  surface: (typeof SURFACES)[number],
  directives: { noindex: boolean; nofollow: boolean },
): Promise<void> {
  const api = await newApiContext(harness.baseURL, harness.adminState)
  try {
    const response = await api.patch('/api/admin/seo', { data: { surface, ...directives } })
    expect(response.status(), await response.text()).toBe(200)
  } finally {
    await api.dispose()
  }
  // The read path memoizes for a few seconds; wait it out rather than reaching
  // into the cache, so the test exercises what a visitor would actually get.
  await new Promise((resolve) => setTimeout(resolve, 6_000))
}

test.beforeAll(async () => {
  test.setTimeout(300_000)
  const env = e2eEnv()
  expect(env.E2E_MODE).toBe('true')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const seed = reservePlatformAdminSeed(`w${workerIndex}-seo`)
  registerPlatformAdminEnv(seed)

  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}seo` }
    const admin = await createPlatformAdminPrincipal(ctx, seed)

    harness = {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      admin,
      adminState: admin.storageState!,
    }
    await fetch(`${server.baseURL}/`).then((r) => r.text()).catch(() => undefined)
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
})

test.beforeEach(async () => {
  test.setTimeout(90_000)
})

test.afterAll(async () => {
  const h = harness
  if (!h) return
  await disposePrincipal(h.admin).catch(() => undefined)
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
})

test.describe('default state: the three content surfaces ship hidden', () => {
  test('the migration seeds every surface as noindex, nofollow', async () => {
    const rows = await harness.sql<{ surface: string; noindex: boolean; nofollow: boolean }[]>`
      select surface, noindex, nofollow from public_surface_indexing order by surface
    `
    expect(rows).toEqual([
      { surface: 'blog', noindex: true, nofollow: true },
      { surface: 'changelog', noindex: true, nofollow: true },
      { surface: 'roadmap', noindex: true, nofollow: true },
    ])
  })

  test('every governed page carries the directive in the server-rendered head', async () => {
    for (const path of ['/blog', '/changelog', '/roadmap']) {
      const meta = await robotsOf(path)
      expect(meta.robots, path).toBe('noindex, nofollow')
      // Google honours its own named tag over the generic one, and __root.tsx
      // sets `googlebot: index, follow` — overriding only `robots` would leave
      // the crawler that matters most still indexing the page.
      expect(meta.googlebot, path).toBe('noindex, nofollow')
    }
  })

  test('a child page inherits its surface, so one switch covers the whole section', async () => {
    // Any real post: the blog list links to it, so the crawl path is the same.
    // `atom` is excluded because /blog/atom.xml is on that page too and is a
    // feed, not a post (it is covered by its own header test below).
    const html = await textOf('/blog')
    const slug = [...html.matchAll(/\/blog\/([a-z0-9-]{4,})(?![\w.-])/g)]
      .map((match) => match[1])
      .find((candidate) => candidate !== 'atom')
    expect(slug, 'the blog list should link at least one post').toBeTruthy()
    const meta = await robotsOf(`/blog/${slug}`)
    expect(meta.robots).toBe('noindex, nofollow')
    expect(meta.googlebot).toBe('noindex, nofollow')
  })

  test('robots.txt disallows them for every named agent, not only for *', async () => {
    const body = await textOf('/robots.txt')
    for (const path of ['/blog', '/changelog', '/roadmap']) {
      expect(body).toContain(`Disallow: ${path}`)
      expect(body).not.toContain(`Allow: ${path}`)
    }
    // A named group replaces the `*` group for that agent rather than adding to
    // it, so each AI crawler needs its own copy of the rules.
    for (const agent of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
      const group = body.split(`User-agent: ${agent}`)[1] ?? ''
      expect(group.split('User-agent:')[0], agent).toContain('Disallow: /blog')
    }
  })

  test('the Atom feed carries the directive as a header, since XML has no meta', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      const response = await api.get('/blog/atom.xml')
      expect(response.status()).toBe(200)
      expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow')
    } finally {
      await api.dispose()
    }
  })

  test('sitemap.xml omits hidden surfaces entirely, index and children alike', async () => {
    const xml = await textOf('/sitemap.xml')
    expect(xml).not.toContain('/blog')
    expect(xml).not.toContain('/changelog')
    expect(xml).not.toContain('/roadmap')
    // Still a valid, non-empty sitemap — the untouched surfaces are there.
    expect(xml).toContain('/pricing')
    expect(xml).toContain('/status')
  })
})

test.describe('a platform admin can open a surface up, and close it again', () => {
  test.afterEach(async () => {
    await setDirectives('changelog', { noindex: true, nofollow: true })
  })

  test('flipping noindex off propagates to the head, robots.txt and sitemap.xml together', async () => {
    await setDirectives('changelog', { noindex: false, nofollow: false })

    const meta = await robotsOf('/changelog')
    // Both directives off means no tag at all — the same instruction as
    // `index, follow`, and it leaves the root route's richer preview values.
    expect(meta.robots).toContain('index, follow')
    expect(meta.robots).not.toContain('noindex')

    const robots = await textOf('/robots.txt')
    expect(robots).toContain('Allow: /changelog')
    expect(robots).toContain('Disallow: /blog')

    const xml = await textOf('/sitemap.xml')
    expect(xml).toContain('/changelog')
    expect(xml).not.toContain('/blog')
  })

  test('nofollow alone keeps the page indexable and listed', async () => {
    await setDirectives('changelog', { noindex: false, nofollow: true })

    const meta = await robotsOf('/changelog')
    expect(meta.robots).toBe('nofollow')
    expect(meta.googlebot).toBe('nofollow')

    // A nofollow-but-indexable page is still one we want crawled and listed.
    expect(await textOf('/sitemap.xml')).toContain('/changelog')
    expect(await textOf('/robots.txt')).toContain('Allow: /changelog')
  })

  test('the change is recorded against the admin who made it', async () => {
    await setDirectives('changelog', { noindex: false, nofollow: false })
    const [row] = await harness.sql<{ updated_by: string | null }[]>`
      select updated_by from public_surface_indexing where surface = 'changelog'
    `
    expect(row.updated_by).toBe(harness.admin.userId)
  })
})

test.describe('the endpoint is platform-admin only', () => {
  test('an anonymous caller cannot read or change the settings', async () => {
    const api = await newApiContext(harness.baseURL)
    try {
      expect((await api.get('/api/admin/seo')).status()).toBeGreaterThanOrEqual(401)
      const patch = await api.patch('/api/admin/seo', {
        data: { surface: 'blog', noindex: false, nofollow: false },
      })
      expect(patch.status()).toBeGreaterThanOrEqual(401)
    } finally {
      await api.dispose()
    }
    // …and nothing changed.
    const [row] = await harness.sql<{ noindex: boolean }[]>`
      select noindex from public_surface_indexing where surface = 'blog'
    `
    expect(row.noindex).toBe(true)
  })

  test('an unknown surface is rejected rather than creating a row nothing reads', async () => {
    const api = await newApiContext(harness.baseURL, harness.adminState)
    try {
      const response = await api.patch('/api/admin/seo', {
        data: { surface: 'pricing', noindex: true, nofollow: true },
      })
      expect(response.status()).toBe(400)
    } finally {
      await api.dispose()
    }
    const rows = await harness.sql`select surface from public_surface_indexing where surface = 'pricing'`
    expect(rows).toHaveLength(0)
  })
})
