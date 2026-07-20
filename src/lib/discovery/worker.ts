/**
 * Proactive Discovery worker (plan: proactive-discovery).
 *
 * Walks DISCOVERY_MATRIX a few cells per run, federated-searches each one,
 * and write-throughs `kind === 'person'` results into the global
 * `builder_embeddings` store via semantic-search's own upsert helper. Pure
 * infrastructure — no LLM calls, no per-user writes. Meant to be hit by an
 * external scheduler every 15 minutes (see run-worker.ts route).
 */
import { eq } from 'drizzle-orm'
import { publicDb } from '~/shared/lib/db/client'
import { discoveryState } from '~/shared/lib/db/schema'
import { searchBuilders } from '~/lib/search'
import { upsertEmbeddingStubs } from '~/lib/semantic/index-writer'
import { getRedis } from '~/shared/lib/redis'
import { log } from '~/shared/lib/log'
import { env } from '~/shared/lib/env'
import { cellAt, DISCOVERY_MATRIX } from './matrix'

const STATE_ID = 'default'
// Daily stub counters only need to outlive the day they're for; a small
// buffer covers clock skew across processes/timezone edge cases.
const STUB_COUNTER_TTL_SECONDS = 2 * 24 * 60 * 60

export interface DiscoveryWorkerResult {
  cellsRun: string[]
  resultsSeen: number
  upserted: number
  cursor: number
  capped: boolean
}

/** Pure: whether `usedToday` has already reached/exceeded `cap`. */
export function isCapped(usedToday: number, cap: number): boolean {
  return usedToday >= cap
}

/** Pure: advances `cursor` by `step`, wrapping into `[0, len)`. Never throws on odd input. */
export function nextCursor(cursor: number, step: number, len: number): number {
  if (len <= 0) return 0
  return (((cursor + step) % len) + len) % len
}

interface DiscoveryStateRow {
  id: string
  cursor: number
  lastCellKey: string | null
  lastRunAt: Date | null
  stats: { runs: number; upserted: number; errors: number }
}

async function loadState(): Promise<DiscoveryStateRow> {
  const [row] = await publicDb.select().from(discoveryState).where(eq(discoveryState.id, STATE_ID)).limit(1)
  if (row) return row as DiscoveryStateRow
  const initial: DiscoveryStateRow = {
    id: STATE_ID,
    cursor: 0,
    lastCellKey: null,
    lastRunAt: null,
    stats: { runs: 0, upserted: 0, errors: 0 },
  }
  await publicDb.insert(discoveryState).values(initial).onConflictDoNothing()
  return initial
}

function dailyStubKey(date = new Date()): string {
  return `discovery:stubs:${date.toISOString().slice(0, 10)}`
}

// In-memory fallback when Redis isn't configured — same trade-off documented
// in rate-limit.ts (per-instance, best-effort, resets on restart).
const memoryStubCounters = new Map<string, number>()

async function peekStubCount(): Promise<number> {
  const key = dailyStubKey()
  const redis = await getRedis()
  if (redis) {
    const raw = await redis.get(key)
    return raw ? Number(raw) : 0
  }
  return memoryStubCounters.get(key) ?? 0
}

async function incrementStubCount(delta: number): Promise<void> {
  if (delta <= 0) return
  const key = dailyStubKey()
  const redis = await getRedis()
  if (redis) {
    const count = await redis.incrby(key, delta)
    if (count === delta) await redis.expire(key, STUB_COUNTER_TTL_SECONDS)
    return
  }
  memoryStubCounters.set(key, (memoryStubCounters.get(key) ?? 0) + delta)
}

/**
 * Runs one pass: `DISCOVERY_CELLS_PER_RUN` cells sequentially (never
 * parallel across cells — pacing), each write-throughed into
 * `builder_embeddings` up to the remaining daily stub allowance. A cell
 * whose search throws is logged and skipped — never aborts the run.
 */
export async function runDiscoveryWorker(): Promise<DiscoveryWorkerResult> {
  const state = await loadState()
  let cursor = state.cursor
  if (cursor < 0 || cursor >= DISCOVERY_MATRIX.length) {
    log.warn('discovery_cursor_reset', { previousCursor: cursor, matrixLength: DISCOVERY_MATRIX.length })
    cursor = 0
  }

  const cellsRun: string[] = []
  let resultsSeen = 0
  let upserted = 0
  let errors = 0
  let capped = false

  for (let i = 0; i < env.DISCOVERY_CELLS_PER_RUN; i++) {
    const cell = cellAt(cursor)
    cellsRun.push(cell.key)
    try {
      const results = await searchBuilders({ keywords: cell.keywords, sources: cell.sources, perPage: 30 })
      const persons = results.filter((builder) => builder.kind === 'person')
      resultsSeen += persons.length

      const usedToday = await peekStubCount()
      if (isCapped(usedToday, env.DISCOVERY_DAILY_STUB_CAP)) {
        capped = true
      } else {
        const allowance = Math.max(0, env.DISCOVERY_DAILY_STUB_CAP - usedToday)
        const toUpsert = persons.slice(0, allowance)
        if (toUpsert.length > 0) {
          await upsertEmbeddingStubs(toUpsert)
          await incrementStubCount(toUpsert.length)
          upserted += toUpsert.length
        }
        if (toUpsert.length < persons.length) capped = true
      }
    } catch (error) {
      errors += 1
      log.error('discovery_worker_cell_error', {
        cell: cell.key,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    cursor = nextCursor(cursor, 1, DISCOVERY_MATRIX.length)
  }

  const lastCellKey = cellsRun[cellsRun.length - 1] ?? null
  const stats = {
    runs: state.stats.runs + 1,
    upserted: state.stats.upserted + upserted,
    errors: state.stats.errors + errors,
  }

  await publicDb.update(discoveryState)
    .set({ cursor, lastCellKey, lastRunAt: new Date(), stats })
    .where(eq(discoveryState.id, STATE_ID))

  const report: DiscoveryWorkerResult = { cellsRun, resultsSeen, upserted, cursor, capped }
  log.info('discovery_worker_run', { ...report })
  return report
}
