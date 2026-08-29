import { indexSelfManagedProfile, removeSelfManagedFromIndex } from './self-managed-index'
import { SELF_MANAGED_ENTITY_KIND } from '~/shared/lib/semantic/entity-kinds'
import { listIndexedSourceIds } from '~/shared/lib/repositories/public-builder-embeddings'
import { withJobRun, type JobRunOutcome } from '~/shared/lib/repositories/platform-operations'
import { workerDb } from '~/shared/lib/db/worker-db'
import { log } from '~/shared/lib/log'

/**
 * Reconciles the semantic index against the profiles that should be in it
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## A backstop, not the mechanism
 *
 * Publishing, editing and deleting all write through on the request path — this exists for what
 * write-through misses: a process that died between the row write and the index write, an event
 * that fired while the database was unreachable, a profile whose attachment turned `clean` in a
 * worker pass that then failed. Reconciliation that is *the* mechanism would make every publish
 * wait for a cron tick; reconciliation that is a backstop can run rarely and still be correct.
 *
 * ## Both directions, because only one of them is urgent
 *
 * Missing rows are added and orphaned rows are removed in the same pass. Removal already happens
 * immediately on the request path — a profile that withdrew and stays findable has been told the
 * delete worked and shown that it did not — so what this pass catches is the write that never
 * landed, not the one that has not landed yet.
 *
 * ## Bounded, and it says so when the bound bites
 *
 * Each statement is paged, and the whole pass stops at `MAX_PER_RUN` in either direction. A
 * truncated pass logs how far it got: a cap that silently covers the first thousand profiles reads
 * exactly like a pass that found nothing left to do.
 */
export const SELF_MANAGED_INDEX_JOB_KEY = 'self-managed.semantic-index'

const PAGE = 100
/** Two orders of magnitude above today's corpus, and a ceiling a runaway pass cannot walk past. */
const MAX_PER_RUN = 5000

export interface SelfManagedIndexWorkerResult extends JobRunOutcome {
  scanned: number
  indexed: number
  unchanged: number
  removed: number
  truncated: boolean
  processedCount: number
  failedCount: number
}

export interface SelfManagedIndexWorkerOptions {
  now?: Date
  db?: typeof workerDb
  page?: number
  maxPerRun?: number
}

export async function runSelfManagedSemanticIndexWorker(
  options: SelfManagedIndexWorkerOptions = {},
): Promise<SelfManagedIndexWorkerResult> {
  const now = options.now ?? new Date()
  const db = options.db ?? workerDb
  const page = options.page ?? PAGE
  const maxPerRun = options.maxPerRun ?? MAX_PER_RUN

  return withJobRun({ jobKey: SELF_MANAGED_INDEX_JOB_KEY, now, db }, async () => {
    const { listIndexableProfiles } = await import('~/shared/lib/repositories/self-managed-profiles')

    const result: SelfManagedIndexWorkerResult = {
      scanned: 0,
      indexed: 0,
      unchanged: 0,
      removed: 0,
      truncated: false,
      processedCount: 0,
      failedCount: 0,
    }

    // Forward pass: every public profile has a row, and its document is current.
    const eligible = new Set<string>()
    let after: string | null = null
    for (;;) {
      const batch = await db.transaction((transaction) =>
        listIndexableProfiles(transaction as never, { after, limit: page }))
      if (batch.length === 0) break

      for (const profile of batch) {
        eligible.add(profile.id)
        result.scanned += 1
        // `true` means the content hash moved, which is also what marks the row pending re-embed.
        // An unchanged profile costs one upsert and no provider call.
        if (await indexSelfManagedProfile(profile, db as never)) result.indexed += 1
        else result.unchanged += 1
      }

      after = batch[batch.length - 1]!.id
      if (batch.length < page) break
      if (result.scanned >= maxPerRun) {
        result.truncated = true
        break
      }
    }

    // Reverse pass: nothing is indexed that should not be. Skipped when the forward pass was
    // truncated — `eligible` is then a partial set, and deleting against a partial set would
    // remove live profiles the pass simply had not reached yet.
    if (!result.truncated) {
      let cursor: string | null = null
      let walked = 0
      for (;;) {
        const indexed: string[] = await listIndexedSourceIds({
          entityKind: SELF_MANAGED_ENTITY_KIND,
          after: cursor,
          limit: page,
        }, db as never)
        if (indexed.length === 0) break

        for (const sourceId of indexed) {
          if (!eligible.has(sourceId)) result.removed += await removeSelfManagedFromIndex(sourceId, db as never)
        }

        walked += indexed.length
        cursor = indexed[indexed.length - 1]!
        if (indexed.length < page) break
        if (walked >= maxPerRun) {
          result.truncated = true
          break
        }
      }
    }

    result.processedCount = result.scanned + result.removed
    if (result.truncated) {
      log.warn('self_managed_index_truncated', { scanned: result.scanned, maxPerRun })
    }
    return result
  })
}
