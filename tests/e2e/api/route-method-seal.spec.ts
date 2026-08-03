/**
 * No API route may answer an HTML page to a method it does not implement.
 *
 * On a TanStack Start file route, a method with no handler falls through to the route *component*. Every route
 * under `src/routes/api/` declares `component: () => null`, so an unimplemented method answered **200 with an
 * empty HTML document** — not 404, not 405. That shipped and was hit twice: `PATCH /api/solutions/runs/:id`
 * silently reported success against a documented "saved runs are immutable" guarantee, and a monitor pointed at a
 * POST-only admin trigger recorded the worker as healthy on a `GET` that never ran it.
 *
 * ## Why one exotic method covers every route
 *
 * The fix is a single `ANY` handler per route — the framework resolves `handlers[method] ?? handlers['ANY']`. To
 * prove it is present, this spec sends `PROPFIND` (a real WebDAV method, valid HTTP, implemented by nothing here)
 * to every route file on disk. Any route missing its `ANY` has nowhere to send that request but the component,
 * and answers 200 with HTML — which is exactly what is asserted against.
 *
 * The alternative was a hand-maintained table of (route, unimplemented method) pairs. That table would have to
 * know each route's handlers to pick a method it lacks, and would silently stop covering a route the day someone
 * implemented the method it happened to probe. Enumerating the filesystem instead means a new route file is
 * covered the moment it is added, with nothing to remember to update.
 *
 * ## What a passing response looks like
 *
 * Not 200, and not HTML. Beyond that the status is the route's own business and deliberately not pinned here: a
 * public route answers 405 with `Allow`, an admin trigger answers 401 because its seal runs the cron-or-admin
 * guard first (so a stranger gets the same refusal for every verb), and the E2E-only debug seam answers 404 by
 * design. Pinning exact statuses would turn this into a test of each route's authorization instead of a test of
 * the seal. Where a route does answer 405, RFC 9110 requires `Allow`, so that is checked.
 *
 * Companion to `scripts/check-api-route-methods.mjs`, which enforces the same property statically and also
 * verifies that each hand-written `Allow` list matches the handlers the file declares. This spec is the runtime
 * half: it proves the framework actually consults `ANY`, which no amount of source reading can establish.
 */
import { test, expect, request as playwrightRequest, type APIRequestContext } from 'playwright/test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { loadHarnessEnv } from '../harness/load-env'

loadHarnessEnv()

import { acquireWorkerDatabase, dropWorkerDatabase } from '../harness/database'
import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../harness/cache'
import { startWorkerServer, stopWorkerServer } from '../harness/server'

const API_ROOT = 'src/routes/api'

/** A method no route implements, so it always lands on the seal. */
const UNIMPLEMENTED_METHOD = 'PROPFIND'

function listRouteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return listRouteFiles(full)
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

/**
 * The request path a route file serves, taken from the id the file itself declares.
 *
 * Deriving it from the filename instead does not work, and failing to do so is worth recording: TanStack treats a
 * dot in a filename as a path separator, so `solutions/runs.$runId.ts` serves `/api/solutions/runs/$runId`, and
 * escapes a literal dot as `[.]`, so `calendar/export[.]ics.ts` serves `/api/calendar/export.ics`. A first
 * attempt at this spec guessed from the path on disk and produced three URLs that matched no route — all three
 * answered 404 with an HTML body, which looks exactly like the fallthrough defect being tested for.
 *
 * Param values are arbitrary: the seal answers before any lookup, so a placeholder that matches nothing is
 * enough, and using one keeps this spec independent of fixture data.
 */
function pathForRouteFile(file: string): string {
  const source = readFileSync(file, 'utf8')
  const declared = source.match(/createFileRoute\('([^']+)'\)/)
  if (!declared) throw new Error(`${relative(API_ROOT, file)} declares no createFileRoute id`)
  return declared[1]
    .split('/')
    .map((segment) => {
      if (segment === '$') return 'seal-probe'
      return segment.startsWith('$') ? 'seal-probe-id' : segment
    })
    .join('/')
}

const ROUTES = listRouteFiles(API_ROOT)
  .map((file) => ({ file: relative(API_ROOT, file), path: pathForRouteFile(file) }))
  .sort((a, b) => a.file.localeCompare(b.file))

let api: APIRequestContext
let workerIndex: number
let databaseName: string
let redisPrefix: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.setTimeout(300_000)
  workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)
  databaseName = database.databaseName
  redisPrefix = cache.prefix
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    api = await playwrightRequest.newContext({ baseURL: server.baseURL })
  } catch (error) {
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(redisPrefix).catch(() => undefined)
    throw error
  }
})

test.afterAll(async () => {
  await api?.dispose()
  await stopWorkerServer(workerIndex).catch(() => undefined)
  await dropWorkerDatabase(workerIndex, databaseName).catch(() => undefined)
  await dropWorkerRedisNamespace(redisPrefix).catch(() => undefined)
})

test('there are routes to check', () => {
  // Guards against the enumeration silently finding nothing — a passing suite over an empty list proves nothing.
  expect(ROUTES.length).toBeGreaterThan(150)
})

test('no route answers an HTML page to a method it does not implement', async () => {
  const leaks: string[] = []
  const missingAllow: string[] = []

  for (const route of ROUTES) {
    const response = await api.fetch(route.path, { method: UNIMPLEMENTED_METHOD })
    const status = response.status()
    const contentType = response.headers()['content-type'] ?? ''

    if (status === 200 || contentType.includes('text/html'))
      leaks.push(`${route.file} → ${UNIMPLEMENTED_METHOD} ${route.path} answered ${status} ${contentType}`)

    if (status === 405 && !response.headers()['allow'])
      missingAllow.push(`${route.file} → 405 without an Allow header (RFC 9110 requires it)`)
  }

  expect(leaks, `${leaks.length} route(s) fall through to the route component`).toEqual([])
  expect(missingAllow).toEqual([])
})
