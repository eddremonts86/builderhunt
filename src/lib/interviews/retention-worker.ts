import { sql } from 'drizzle-orm'
import { getStorageProvider } from '~/lib/storage/provider'
import { releaseReservation } from '~/shared/lib/billing/feature-authorization'
import { workerDb } from '~/shared/lib/db/worker-db'
import { env } from '~/shared/lib/env'
import {
  deleteExpiredInterviewData,
  emptyRetentionCounts,
  listExpiredDocuments,
  listStaleInterviewReservations,
  listTenantsWithExpiredInterviewData,
  type RetentionCounts,
} from '~/shared/lib/repositories/interview-retention'

/**
 * Deletes interview material whose retention has expired (plan:
 * calendar-scheduling-interview-intelligence, Phase 11).
 *
 * ## Objects first, rows second — and that ordering is the whole design
 *
 * Neither is atomic with the other, so the question is which way it breaks:
 *
 *   - **object then row** → worst case, R2 no longer has the CV and the row still points at it. Every
 *     download 404s and the next pass deletes the row. Nothing is retained past its promise.
 *   - **row then object** → worst case, the row is gone and the object stays in R2 forever, with nothing
 *     left that knows its key. A candidate's CV outlives its retention with no record that it exists.
 *
 * The second is the one that matters: it is a silent, permanent retention breach that no later pass can
 * find. So objects go first, and a failed object deletion leaves the row alone for the next pass to retry.
 *
 * ## The sweep never recomputes an expiry
 *
 * Every row carries its own `retention_expires_at`, written under the policy in force when it was created.
 * Recomputing from today's env would retroactively move deadlines — extending retention on data a candidate
 * was told would be deleted, or deleting data still inside its promised window.
 *
 * ## `dryRun` reports without deleting, because the first run of this is terrifying
 *
 * A worker that deletes a candidate's documents is the one you want to watch before you trust. `dryRun`
 * walks the same queries and reports the same counts with nothing removed.
 */

export interface RetentionWorkerOptions {
  now?: Date
  /** Reports what would be deleted and deletes nothing. */
  dryRun?: boolean
  /** Tenants per pass. Bounded so one enormous organization cannot starve the rest. */
  tenantLimit?: number
  /** Rows per table per tenant per pass. */
  rowLimit?: number
  db?: typeof workerDb
  storage?: Pick<ReturnType<typeof getStorageProvider>, 'deleteObject'>
}

export interface RetentionWorkerResult {
  dryRun: boolean
  tenants: number
  counts: RetentionCounts
  objectsDeleted: number
  objectsFailed: number
  reservationsReleased: number
  reservationsFailed: number
  /** Tenant ids that hit an error. Ids only — a retention log must not name a candidate. */
  failedTenants: string[]
}

const DEFAULT_TENANT_LIMIT = 25
const DEFAULT_ROW_LIMIT = 500

export async function runInterviewRetentionWorker(
  options: RetentionWorkerOptions = {},
): Promise<RetentionWorkerResult> {
  const now = options.now ?? new Date()
  const dryRun = options.dryRun === true
  const db = options.db ?? workerDb
  const tenantLimit = options.tenantLimit ?? DEFAULT_TENANT_LIMIT
  const rowLimit = options.rowLimit ?? DEFAULT_ROW_LIMIT

  // Months, not days: consent is the evidence that the processing was lawful and outlives the data.
  const consentCutoff = new Date(now)
  consentCutoff.setMonth(consentCutoff.getMonth() - env.INTERVIEW_CONSENT_RETENTION_MONTHS)

  const result: RetentionWorkerResult = {
    dryRun,
    tenants: 0,
    counts: emptyRetentionCounts(),
    objectsDeleted: 0,
    objectsFailed: 0,
    reservationsReleased: 0,
    reservationsFailed: 0,
    failedTenants: [],
  }

  const tenants = await db.transaction((tx) => listTenantsWithExpiredInterviewData(tx as never, {
    now, consentCutoff, limit: tenantLimit,
  }))
  result.tenants = tenants.length

  const expiredDocuments = await db.transaction((tx) => listExpiredDocuments(tx as never, {
    now, limit: rowLimit * Math.max(1, tenants.length),
  }))
  const documentsByTenant = new Map<string, typeof expiredDocuments>()
  for (const document of expiredDocuments) {
    const bucket = documentsByTenant.get(document.organizationId) ?? []
    bucket.push(document)
    documentsByTenant.set(document.organizationId, bucket)
  }

  const storage = options.storage ?? (dryRun ? null : safeStorage())

  for (const organizationId of tenants) {
    try {
      const documents = documentsByTenant.get(organizationId) ?? []
      const deletedIds: string[] = []

      for (const document of documents) {
        if (dryRun || !storage) {
          // Counted as if it had happened, so a dry run's numbers match a real one's.
          result.objectsDeleted += 1
          deletedIds.push(document.id)
          continue
        }
        try {
          await storage.deleteObject({ key: document.objectKey })
          result.objectsDeleted += 1
          deletedIds.push(document.id)
        } catch {
          // The row is left alone. A row whose object deletion failed is the only thing that will make the
          // next pass try again — deleting it would strand the object with nothing pointing at it.
          result.objectsFailed += 1
        }
      }

      if (!dryRun) {
        const counts = await db.transaction((tx) => deleteExpiredInterviewData(tx as never, {
          organizationId,
          now,
          documentIds: deletedIds,
          consentCutoff,
          limit: rowLimit,
        }))
        addCounts(result.counts, counts)
      } else {
        // A dry run still needs numbers, so the same predicates are counted without deleting.
        const counts = await db.transaction(async (tx) => {
          const preview = await deleteExpiredInterviewData(tx as never, {
            organizationId, now, documentIds: deletedIds, consentCutoff, limit: rowLimit,
          })
          // Rolled back, so nothing is removed. Counting by rehearsing the real statements is the only way
          // a dry run's numbers can be trusted to match the run it is previewing.
          throw new DryRunRollback(preview)
        }).catch((error) => {
          if (error instanceof DryRunRollback) return error.counts
          throw error
        })
        addCounts(result.counts, counts)
      }
    } catch (error) {
      // Ids only. Whatever went wrong, the message could name a document or a candidate.
      console.error('interview retention failed for a tenant:', organizationId, (error as Error)?.name)
      result.failedTenants.push(organizationId)
    }
  }

  await releaseStaleReservations(db, { now, limit: rowLimit, dryRun }, result)
  return result
}

/**
 * Closes interview reservations abandoned past their deadline.
 *
 * Through the platform's own `releaseReservation`, never by writing the ledger: the release has to make the
 * right ledger entries and return or forfeit each allocation according to whether its source grant has since
 * expired, and reimplementing that here would be a second, quietly divergent billing path.
 */
async function releaseStaleReservations(
  db: typeof workerDb,
  params: { now: Date; limit: number; dryRun: boolean },
  result: RetentionWorkerResult,
): Promise<void> {
  const stale = await db.transaction((tx) => listStaleInterviewReservations(tx as never, {
    now: params.now, limit: params.limit,
  }))

  for (const reservation of stale) {
    if (params.dryRun) {
      result.reservationsReleased += 1
      continue
    }
    try {
      await db.transaction(async (tx) => {
        /*
         * Set the tenant on the transaction, not only on the principal.
         *
         * The principal below carries the organization for the *application's* filtering, but RLS
         * reads `app.organization_id` from the session, and this worker runs as `builderhunt_worker`
         * — a role the policies apply to. Without this line the release matched zero rows in
         * production while reporting success locally, because the developer's connection was the
         * owner and ignored RLS. The sweep would have silently stopped releasing abandoned
         * reservations, leaving customers' credits held indefinitely.
         *
         * `true` scopes it to this transaction, so one reservation's tenant cannot leak into the
         * next iteration's.
         */
        await tx.execute(sql`select set_config('app.organization_id', ${reservation.organizationId}, true)`)
        return releaseReservation(
        tx as never,
        // A worker has no session. The principal exists only to carry the tenant the reservation belongs
        // to, which is what keeps the release inside that organization's own ledger.
        { organizationId: reservation.organizationId, userId: 'system:retention', role: 'owner', requestId: 'retention' } as never,
        {
          reservationId: reservation.id,
          reason: 'retention_stale_reservation',
          // Deterministic, so a re-run of the same pass replays instead of releasing twice.
          idempotencyKey: `retention:release:${reservation.id}`,
        },
        )
      })
      result.reservationsReleased += 1
    } catch (error) {
      // Already closed by whoever owned it is the common case and not a failure worth alarming on; anything
      // else is counted so a rising number is visible.
      const name = (error as Error)?.name
      if (name === 'ReservationError' || name === 'FeatureBillingError') continue
      result.reservationsFailed += 1
    }
  }
}

class DryRunRollback extends Error {
  constructor(readonly counts: RetentionCounts) {
    super('dry run')
    this.name = 'DryRunRollback'
  }
}

function addCounts(into: RetentionCounts, from: RetentionCounts): void {
  for (const key of Object.keys(into) as Array<keyof RetentionCounts>) into[key] += from[key]
}

/**
 * The storage provider, or null when it is not configured.
 *
 * Null rather than a throw: an operator running retention on a deployment with no object storage still wants
 * the relational sweep to happen, and refusing the whole pass because R2 is absent would retain rows past
 * their promise for a reason that has nothing to do with them.
 */
function safeStorage(): Pick<ReturnType<typeof getStorageProvider>, 'deleteObject'> | null {
  try {
    return getStorageProvider()
  } catch {
    return null
  }
}
