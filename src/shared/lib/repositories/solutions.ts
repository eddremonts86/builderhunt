/**
 * Saved briefs, runs, and feedback (plan 43 Phase 8, "Persist explicit briefs, runs, and feedback").
 *
 * Every function takes a `TenantTransaction` and scopes by `organization_id` in the query as well as relying on
 * RLS. Both, deliberately: RLS is the guarantee, and the explicit predicate is what makes a mistake visible in
 * review rather than only at runtime under a role no test connects as.
 *
 * ## Nothing here writes itself
 *
 * spec.md: "Nothing is saved until you explicitly save a result." Generation does not call `saveRun` — a route
 * handler does, when a user asks. That is why `saveRun` takes an already-composed result rather than producing
 * one, and why `briefId` is optional: a user may keep a result without keeping the brief that made it.
 *
 * ## A saved run is immutable
 *
 * There is no `updateRun`, and the app role has no UPDATE privilege on `solution_runs` or `solution_run_routes`
 * to back that up. A stored recommendation is what an organization was told on a given day; one that could be
 * edited afterwards would be worthless in the dispute it exists for. Deletion stays available — erasure is a
 * right, immutability is about revision.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import type { TenantPrincipal } from '../authorization/permissions'
import type { TenantTransaction } from '../db/client'
import { solutionBriefs, solutionRunFeedback, solutionRunRoutes, solutionRuns } from '../db/schema'
import { solutionBriefSchema, solutionRouteSchema, type RouteType, type SolutionBrief, type SolutionRoute } from '../solutions/contracts'
import { ENTITY_DETAIL_LIMIT } from '../db/read-bounds'

export class SolutionsRepositoryError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'invalid_brief' | 'invalid_route') {
    super(message)
    this.name = 'SolutionsRepositoryError'
  }
}

// ── Briefs ──────────────────────────────────────────────────────────────────

export interface SaveBriefInput {
  id: string
  title: string
  brief: SolutionBrief
}

export async function saveBrief(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: SaveBriefInput,
) {
  // Validated on the way in, not only on the way out. A row that `solutionBriefSchema` would reject is a row the
  // composer cannot consume, and finding that out at read time means the save silently produced a dead record.
  const parsed = solutionBriefSchema.safeParse(input.brief)
  if (!parsed.success) throw new SolutionsRepositoryError('Brief does not match the contract', 'invalid_brief')

  const [row] = await transaction.insert(solutionBriefs).values({
    id: input.id,
    organizationId: principal.organizationId,
    createdByUserId: principal.userId,
    title: input.title,
    brief: parsed.data as unknown as Record<string, unknown>,
  }).returning()
  return row
}

export async function listBriefs(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  limit = 50,
) {
  return transaction.select().from(solutionBriefs)
    .where(eq(solutionBriefs.organizationId, principal.organizationId))
    .orderBy(desc(solutionBriefs.createdAt))
    .limit(limit)
}

export async function findBrief(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  briefId: string,
) {
  const [row] = await transaction.select().from(solutionBriefs)
    .where(and(eq(solutionBriefs.organizationId, principal.organizationId), eq(solutionBriefs.id, briefId)))
    .limit(1)
  return row ?? null
}

export async function updateBrief(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  briefId: string,
  changes: { title?: string; brief?: SolutionBrief },
) {
  if (changes.brief) {
    const parsed = solutionBriefSchema.safeParse(changes.brief)
    if (!parsed.success) throw new SolutionsRepositoryError('Brief does not match the contract', 'invalid_brief')
  }
  const [row] = await transaction.update(solutionBriefs)
    .set({
      ...(changes.title === undefined ? {} : { title: changes.title }),
      ...(changes.brief === undefined ? {} : { brief: changes.brief as unknown as Record<string, unknown> }),
      updatedAt: new Date(),
    })
    .where(and(eq(solutionBriefs.organizationId, principal.organizationId), eq(solutionBriefs.id, briefId)))
    .returning()
  if (!row) throw new SolutionsRepositoryError(`No brief ${briefId}`, 'not_found')
  return row
}

/** Cascades to every run composed from it, which is what an erasure request means by "delete this brief". */
export async function deleteBrief(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  briefId: string,
): Promise<boolean> {
  const deleted = await transaction.delete(solutionBriefs)
    .where(and(eq(solutionBriefs.organizationId, principal.organizationId), eq(solutionBriefs.id, briefId)))
    .returning({ id: solutionBriefs.id })
  return deleted.length > 0
}

// ── Runs ────────────────────────────────────────────────────────────────────

export interface SaveRunRoute {
  route: SolutionRoute
  explanationProvenance: 'model' | 'deterministic'
  /** Required when the provenance is deterministic, refused when it is not — the CHECK enforces both. */
  explanationFallbackReason?: string | null
}

export interface SaveRunInput {
  id: string
  briefId?: string | null
  briefSnapshot: SolutionBrief
  rankingMode: string
  retrievalQueryHash: string
  compositionHash: string
  composerVersion: string
  interpretPromptVersion?: string | null
  explainPromptVersion?: string | null
  componentVersionIds: string[]
  evidenceIds: string[]
  sourceStatuses: unknown[]
  warnings: string[]
  creditReservationId?: string | null
  creditSettledUnits?: number | null
  routes: SaveRunRoute[]
}

export async function saveRun(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: SaveRunInput,
) {
  for (const entry of input.routes) {
    if (!solutionRouteSchema.safeParse(entry.route).success) {
      throw new SolutionsRepositoryError(`Route ${entry.route.routeType} does not match the contract`, 'invalid_route')
    }
  }

  const [run] = await transaction.insert(solutionRuns).values({
    id: input.id,
    organizationId: principal.organizationId,
    briefId: input.briefId ?? null,
    createdByUserId: principal.userId,
    briefSnapshot: input.briefSnapshot as unknown as Record<string, unknown>,
    rankingMode: input.rankingMode,
    retrievalQueryHash: input.retrievalQueryHash,
    compositionHash: input.compositionHash,
    composerVersion: input.composerVersion,
    interpretPromptVersion: input.interpretPromptVersion ?? null,
    explainPromptVersion: input.explainPromptVersion ?? null,
    componentVersionIds: input.componentVersionIds,
    evidenceIds: input.evidenceIds,
    sourceStatuses: input.sourceStatuses,
    warnings: input.warnings,
    creditReservationId: input.creditReservationId ?? null,
    creditSettledUnits: input.creditSettledUnits ?? null,
  }).returning()

  if (input.routes.length > 0) {
    await transaction.insert(solutionRunRoutes).values(input.routes.map((entry) => ({
      runId: input.id,
      organizationId: principal.organizationId,
      routeType: entry.route.routeType,
      route: entry.route as unknown as Record<string, unknown>,
      status: entry.route.status,
      explanationProvenance: entry.explanationProvenance,
      explanationFallbackReason: entry.explanationFallbackReason ?? null,
    })))
  }

  return run
}

export async function findRun(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  runId: string,
) {
  const [run] = await transaction.select().from(solutionRuns)
    .where(and(eq(solutionRuns.organizationId, principal.organizationId), eq(solutionRuns.id, runId)))
    .limit(1)
  if (!run) return null

  const routes = await transaction.select().from(solutionRunRoutes)
    .where(and(eq(solutionRunRoutes.organizationId, principal.organizationId), eq(solutionRunRoutes.runId, runId)))
    // The routes of one run — "the children of this row", rendered whole on the run detail page.
    .limit(ENTITY_DETAIL_LIMIT)
  return { run, routes }
}

export async function listRuns(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  options: { briefId?: string; limit?: number } = {},
) {
  const where = options.briefId
    ? and(eq(solutionRuns.organizationId, principal.organizationId), eq(solutionRuns.briefId, options.briefId))
    : eq(solutionRuns.organizationId, principal.organizationId)
  return transaction.select().from(solutionRuns)
    .where(where)
    .orderBy(desc(solutionRuns.createdAt))
    .limit(options.limit ?? 50)
}

export async function deleteRun(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  runId: string,
): Promise<boolean> {
  const deleted = await transaction.delete(solutionRuns)
    .where(and(eq(solutionRuns.organizationId, principal.organizationId), eq(solutionRuns.id, runId)))
    .returning({ id: solutionRuns.id })
  return deleted.length > 0
}

// ── Feedback ────────────────────────────────────────────────────────────────

export interface RecordFeedbackInput {
  id: string
  runId: string
  routeType: RouteType
  chosen: boolean
  reason?: string | null
}

/**
 * Records which route someone went with.
 *
 * An upsert on (run, route, user): a person is allowed to change their mind, and the unique index is what stops
 * one enthusiastic user from weighting Phase 9's evaluation corpus by clicking repeatedly.
 */
export async function recordFeedback(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  input: RecordFeedbackInput,
) {
  const [row] = await transaction.insert(solutionRunFeedback).values({
    id: input.id,
    organizationId: principal.organizationId,
    runId: input.runId,
    routeType: input.routeType,
    createdByUserId: principal.userId,
    chosen: input.chosen,
    reason: input.reason ?? null,
  }).onConflictDoUpdate({
    target: [solutionRunFeedback.runId, solutionRunFeedback.routeType, solutionRunFeedback.createdByUserId],
    set: { chosen: input.chosen, reason: input.reason ?? null, updatedAt: new Date() },
  }).returning()
  return row
}

export async function listFeedback(
  transaction: TenantTransaction,
  principal: TenantPrincipal,
  runId: string,
) {
  return transaction.select().from(solutionRunFeedback)
    .where(and(eq(solutionRunFeedback.organizationId, principal.organizationId), eq(solutionRunFeedback.runId, runId)))
    .orderBy(desc(solutionRunFeedback.createdAt))
    // Feedback left on one run, by hand, one entry at a time.
    .limit(ENTITY_DETAIL_LIMIT)
}

// ── DTOs ────────────────────────────────────────────────────────────────────

export interface SolutionRunDto {
  id: string
  briefId: string | null
  brief: unknown
  rankingMode: string
  routes: unknown[]
  routeProvenance: Array<{ routeType: string; provenance: string; fallbackReason: string | null }>
  componentVersionIds: string[]
  evidenceIds: string[]
  sourceStatuses: unknown[]
  warnings: string[]
  composerVersion: string
  compositionHash: string
  interpretPromptVersion: string | null
  explainPromptVersion: string | null
  createdAt: string
}

/**
 * What a client may see of a stored run.
 *
 * Three things are deliberately absent. `organizationId` tells a client nothing it does not already know and
 * would appear in every log and error report that echoed the payload. `createdByUserId` is another member's
 * identity, and a run list is not a place to learn who on the team is using which feature. `creditReservationId`
 * and `creditSettledUnits` are billing-owned: the balance and the charge belong to the billing surface, and
 * duplicating them here creates a second number that can disagree with it.
 *
 * `compositionHash` and the versions stay, because they are what makes a stored recommendation auditable — a
 * user comparing two runs of the same brief needs to see that the composition actually differed.
 */
export function toSolutionRunDto(
  run: typeof solutionRuns.$inferSelect,
  routes: Array<typeof solutionRunRoutes.$inferSelect>,
): SolutionRunDto {
  const ordered = [...routes].sort((a, b) => ROUTE_ORDER.indexOf(a.routeType) - ROUTE_ORDER.indexOf(b.routeType))
  return {
    id: run.id,
    briefId: run.briefId,
    brief: run.briefSnapshot,
    rankingMode: run.rankingMode,
    routes: ordered.map((row) => row.route),
    routeProvenance: ordered.map((row) => ({
      routeType: row.routeType,
      provenance: row.explanationProvenance,
      fallbackReason: row.explanationFallbackReason,
    })),
    componentVersionIds: run.componentVersionIds,
    evidenceIds: run.evidenceIds,
    sourceStatuses: run.sourceStatuses,
    warnings: run.warnings,
    composerVersion: run.composerVersion,
    compositionHash: run.compositionHash,
    interpretPromptVersion: run.interpretPromptVersion,
    explainPromptVersion: run.explainPromptVersion,
    createdAt: run.createdAt.toISOString(),
  }
}

/** Human, AI, hybrid — the order the composer builds them and the order the UI compares them in. Stored rows
 * come back in whatever order the database returns, which is not an order. */
const ROUTE_ORDER = ['human', 'ai', 'hybrid']

export interface SolutionBriefDto {
  id: string
  title: string
  brief: unknown
  createdAt: string
  updatedAt: string
}

export function toSolutionBriefDto(row: typeof solutionBriefs.$inferSelect): SolutionBriefDto {
  return {
    id: row.id,
    title: row.title,
    brief: row.brief,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** Count of runs an organization holds, for a retention or export summary. */
export async function countRuns(transaction: TenantTransaction, principal: TenantPrincipal): Promise<number> {
  const [row] = await transaction.select({ count: sql<number>`count(*)::int` }).from(solutionRuns)
    .where(eq(solutionRuns.organizationId, principal.organizationId))
  return row?.count ?? 0
}
