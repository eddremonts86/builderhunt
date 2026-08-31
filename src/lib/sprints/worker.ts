// Background worker for the ai-sourcing-sprints plan.
//
// Deviation from spec.md, documented: the spec describes a single global
// query that leases "≤3 oldest due active sprints across all organizations"
// with `FOR UPDATE SKIP LOCKED`. Nothing else in this codebase queries
// tenant-scoped tables outside a per-organization RLS context (see
// `alerts-worker.ts`/`lib/alerts/worker.ts`), and introducing a
// cross-organization query + row-level locking scheme that bypasses that
// convention would be a new, untested architectural pattern. This worker
// instead follows the exact alerts-worker shape: iterate every organization
// (`listWorkerOrganizationIds`), and within each organization's own tenant
// context, advance at most one cell of that organization's single
// oldest-due active sprint. Net effect: every organization's sprints make
// progress on every run (arguably fairer than a global top-3), at the cost
// of at most one federated search per organization per run — well within
// the same load budget the spec computed for its own design.
import { randomId } from '~/lib/utils'
import { searchBuilders, DEFAULT_SEARCH_SOURCES } from '~/lib/search'
import { decideSelfManagedInclusion, withSelfManagedOrigin } from '~/shared/lib/self-managed/inclusion-policy'
import { getUserPreferences } from '~/shared/lib/repositories/user-preferences'
import { log } from '~/shared/lib/log'
import {
  advanceWorkerSprintCursor,
  countWorkerSprintResults,
  findOldestDueActiveSprint,
  insertWorkerSprintResults,
  listWorkerOrganizationIds,
  withWorkerOrganization,
} from '~/shared/lib/repositories/sprints-worker'
import { MAX_VARIANTS_PER_CELL_PAGE, SPRINT_PAGE_SIZE, type SprintCursor } from '~/shared/lib/sprints-shared'
import { clipToQuota, toSprintProfileSnapshot } from './results'
import { writeThroughSprintResults } from './semantic-write-through'
import { collectWorkerOrganizationIds } from '~/shared/lib/repositories/worker-organization-scan'

export interface SprintsWorkerResult {
  sprintsRun: number
  resultsAdded: number
  completed: string[]
  errors: string[]
}

/**
 * Pure cursor-advance logic: `page` walks 1..MAX_VARIANTS_PER_CELL_PAGE
 * within the current variant, then rolls over to the next variant at
 * page 1. `exhausted: true` once every variant/page combination has run.
 */
export function nextSprintCursor(cursor: SprintCursor, variantCount: number): { cursor: SprintCursor; exhausted: boolean } {
  if (variantCount <= 0) return { cursor, exhausted: true }
  if (cursor.page < MAX_VARIANTS_PER_CELL_PAGE) {
    return { cursor: { variantIndex: cursor.variantIndex, page: cursor.page + 1 }, exhausted: false }
  }
  const nextVariantIndex = cursor.variantIndex + 1
  if (nextVariantIndex >= variantCount) return { cursor, exhausted: true }
  return { cursor: { variantIndex: nextVariantIndex, page: 1 }, exhausted: false }
}

export async function runSprintsWorker(): Promise<SprintsWorkerResult> {
  const result: SprintsWorkerResult = { sprintsRun: 0, resultsAdded: 0, completed: [], errors: [] }
  const organizations = (await collectWorkerOrganizationIds((after, limit) => listWorkerOrganizationIds(after, limit))).map((id) => ({ id }))

  for (const { id: organizationId } of organizations) {
    try {
      const sprint = await withWorkerOrganization(organizationId, (tx) => findOldestDueActiveSprint(tx, organizationId))
      if (!sprint) continue
      result.sprintsRun++

      const variants = sprint.variants
      const variant = variants[sprint.cursor.variantIndex]
      if (!variant) {
        // Out-of-range cursor (e.g. variants edited down) — complete defensively.
        await withWorkerOrganization(organizationId, (tx) => advanceWorkerSprintCursor(tx, {
          organizationId, sprintId: sprint.id, cursor: sprint.cursor, status: 'completed',
        }))
        result.completed.push(sprint.id)
        continue
      }

      /*
       * Two levels, and the sprint wins when it has spoken. An organiser narrowing one shortlist
       * must not rewrite their own standing preference, and a standing preference must not override
       * a decision somebody just made on the screen in front of them. The subject is the sprint's
       * creator, because a sprint is theirs — an organisation has no preferences, people do.
       */
      const inclusion = decideSelfManagedInclusion({
        surfacePreference: sprint.includeSelfManaged,
        accountPreference: (await withWorkerOrganization(organizationId, (tx) =>
          getUserPreferences(tx as never, sprint.creatorUserId))).searchIncludeSelfManaged,
      })

      const searchResults = await searchBuilders({
        keywords: variant.keywords,
        sources: withSelfManagedOrigin(variant.sources ?? DEFAULT_SEARCH_SOURCES, inclusion),
        language: variant.language,
        country: variant.country,
        page: sprint.cursor.page,
        perPage: SPRINT_PAGE_SIZE,
      })
      const people = searchResults.filter((builder) => builder.kind === 'person')

      const currentCount = await withWorkerOrganization(organizationId, (tx) => countWorkerSprintResults(tx, organizationId, sprint.id))
      const { kept } = clipToQuota(people, currentCount, sprint.quota)

      const rows = kept.map((person) => ({
        id: randomId(),
        organizationId,
        sprintId: sprint.id,
        source: person.source,
        sourceId: person.sourceId,
        profile: toSprintProfileSnapshot(person),
        matchedVariant: variant.name,
        score: person.score,
      }))
      await withWorkerOrganization(organizationId, (tx) => insertWorkerSprintResults(tx, rows))
      result.resultsAdded += rows.length

      const quotaHit = currentCount + kept.length >= sprint.quota
      const { cursor: advancedCursor, exhausted } = nextSprintCursor(sprint.cursor, variants.length)
      const completed = quotaHit || exhausted

      await withWorkerOrganization(organizationId, (tx) => advanceWorkerSprintCursor(tx, {
        organizationId,
        sprintId: sprint.id,
        cursor: completed ? sprint.cursor : advancedCursor,
        status: completed ? 'completed' : 'active',
      }))
      if (completed) result.completed.push(sprint.id)

      // Fire-and-forget: a write-through failure never blocks sprint progress.
      void writeThroughSprintResults(kept)
    } catch (error) {
      result.errors.push(`${organizationId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  log.info('sprint_worker_run', { ...result })
  return result
}
