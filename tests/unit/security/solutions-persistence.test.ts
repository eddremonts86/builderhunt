/**
 * Saved briefs, runs, and feedback against a real disposable Postgres (plan 43 Phase 8).
 *
 * The plan's verify line: "tenant A/B RLS, explicit-save-only, retention/export/deletion, immutable run, and
 * public DTO tests pass."
 *
 * **What this file can and cannot prove.** It connects as the migration superuser, which bypasses RLS and holds
 * every privilege. So the *policies* and the *absent UPDATE grant* are not testable here — they are asserted in
 * `scripts/db/verify-rls-local.mjs` as the real `builderhunt_app` role, and this file's tenant tests prove the
 * second, independent half: that every repository query carries its own `organization_id` predicate. Both
 * matter. A repository that relied on RLS alone would leak the moment a caller reached it outside
 * `withTenantContext`, and RLS alone is invisible in review.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations, solutionBriefs, solutionRunFeedback, solutionRunRoutes, solutionRuns } from '~/shared/lib/db/schema'
import {
  SolutionsRepositoryError,
  countRuns,
  deleteBrief,
  deleteRun,
  findBrief,
  findRun,
  listBriefs,
  listFeedback,
  listRuns,
  recordFeedback,
  saveBrief,
  saveRun,
  toSolutionBriefDto,
  toSolutionRunDto,
  updateBrief,
} from '~/shared/lib/repositories/solutions'
import type { SolutionBrief, SolutionRoute } from '~/shared/lib/solutions/contracts'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG_A = 'sp-org-a'
const ORG_B = 'sp-org-b'
const USER_A = 'sp-user-a'
const USER_B = 'sp-user-b'
const principalA = { organizationId: ORG_A, userId: USER_A, organizationRole: 'owner', requestId: 'req-a' } as never
const principalB = { organizationId: ORG_B, userId: USER_B, organizationRole: 'owner', requestId: 'req-b' } as never

let sequence = 0
const uniqueId = (prefix: string) => `${prefix}-${(sequence += 1)}`

const BRIEF: SolutionBrief = {
  deliverable: { description: 'Translate 200 product pages', domain: 'translation_and_transcription' },
  capabilities: ['translation'],
  inputFormats: [],
  outputFormats: [],
  languages: ['German'],
  integrations: [],
  hardConstraints: [],
  softPreferences: [],
  rankingMode: 'recommended',
}

const route = (routeType: SolutionRoute['routeType']): SolutionRoute => ({
  routeType,
  status: 'available',
  summary: `${routeType} route`,
  fitExplanation: 'It covers translation.',
  steps: ['Do the work'],
  components: [{
    componentId: 'deepl-pro',
    componentVersion: 3,
    role: 'Covers translation',
    coveredCapabilityKeys: ['translation'],
  }],
  mandatoryCapabilitiesCovered: true,
  coverageGapCapabilityKeys: [],
  limitations: [],
  estimate: { costMinCents: 100, costMaxCents: 200, currency: 'EUR', timeMinHours: 1, timeMaxHours: 2, assumptions: [] },
  risks: [],
  humanReviewPoints: [],
  evidenceIds: ['deepl-pro@3'],
})

const runInput = (overrides: Record<string, unknown> = {}) => ({
  id: uniqueId('run'),
  briefSnapshot: BRIEF,
  rankingMode: 'recommended',
  retrievalQueryHash: 'qhash',
  compositionHash: 'chash',
  composerVersion: 'composer-1',
  componentVersionIds: ['deepl-pro@3'],
  evidenceIds: ['deepl-pro@3'],
  sourceStatuses: [],
  warnings: [],
  routes: [{ route: route('ai'), explanationProvenance: 'model' as const }],
  ...overrides,
})


/**
 * Asserts a write was refused *by a named constraint*.
 *
 * Drizzle wraps the driver error, so the constraint name lives on the cause rather than in the message — a
 * plain `.rejects.toThrow(/name/)` passes only by accident and fails here even when the constraint fired
 * correctly. Walking the chain also keeps the assertion honest: a write refused for some other reason no longer
 * counts as proof that this constraint exists. Mirrors the helper in `canonical-human-identity.test.ts`.
 */
async function expectConstraintViolation(write: Promise<unknown>, constraint: string): Promise<void> {
  let thrown: unknown
  try {
    await write
  } catch (error) {
    thrown = error
  }
  expect(thrown, `expected ${constraint} to reject this write, but it succeeded`).toBeDefined()

  const names: string[] = []
  for (let error = thrown; error instanceof Error; error = (error as { cause?: unknown }).cause) {
    const candidate = (error as { constraint_name?: unknown }).constraint_name
    if (typeof candidate === 'string') names.push(candidate)
    names.push(error.message)
  }
  expect(names.join('\n')).toContain(constraint)
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('solutions_persistence')
  db = disposable.db
  drop = disposable.drop
  await db.insert(authUsers).values([
    { id: USER_A, name: 'A', email: 'sp-a@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    { id: USER_B, name: 'B', email: 'sp-b@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
  ])
  await db.insert(organizations).values([
    { id: ORG_A, name: 'Org A', slug: ORG_A },
    { id: ORG_B, name: 'Org B', slug: ORG_B },
  ])
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(solutionRunFeedback)
  await db.delete(solutionRunRoutes)
  await db.delete(solutionRuns)
  await db.delete(solutionBriefs)
})

describe('every query is scoped to one organization', () => {
  it('does not return another tenant’s brief', async () => {
    await saveBrief(db as never, principalA, { id: 'brief-a', title: 'A', brief: BRIEF })
    await saveBrief(db as never, principalB, { id: 'brief-b', title: 'B', brief: BRIEF })

    expect((await listBriefs(db as never, principalA)).map((row) => row.id)).toEqual(['brief-a'])
    expect(await findBrief(db as never, principalA, 'brief-b')).toBeNull()
  })

  it('does not return another tenant’s run', async () => {
    await saveRun(db as never, principalA, runInput({ id: 'run-a' }))
    await saveRun(db as never, principalB, runInput({ id: 'run-b' }))

    expect((await listRuns(db as never, principalA)).map((row) => row.id)).toEqual(['run-a'])
    expect(await findRun(db as never, principalA, 'run-b')).toBeNull()
  })

  it('refuses to update or delete across tenants', async () => {
    await saveBrief(db as never, principalA, { id: 'brief-a', title: 'A', brief: BRIEF })
    // The predicate matches zero rows rather than throwing, which is the same "no such row from here" shape as
    // RLS itself. The assertion that matters is that A's row is untouched.
    await expect(updateBrief(db as never, principalB, 'brief-a', { title: 'hijacked' })).rejects
      .toMatchObject({ code: 'not_found' })
    expect(await deleteBrief(db as never, principalB, 'brief-a')).toBe(false)
    expect((await findBrief(db as never, principalA, 'brief-a'))?.title).toBe('A')
  })

  it('counts only its own runs', async () => {
    await saveRun(db as never, principalA, runInput())
    await saveRun(db as never, principalA, runInput())
    await saveRun(db as never, principalB, runInput())
    expect(await countRuns(db as never, principalA)).toBe(2)
    expect(await countRuns(db as never, principalB)).toBe(1)
  })
})

describe('nothing is saved that was not explicitly saved', () => {
  it('stores a run without requiring a saved brief', async () => {
    /**
     * spec.md: "Nothing is saved until you explicitly save a result." A user may want to keep a result without
     * keeping the brief that made it, and requiring a brief row first would save something nobody asked to
     * keep.
     */
    const run = await saveRun(db as never, principalA, runInput({ briefId: null }))
    expect(run.briefId).toBeNull()
    expect(run.briefSnapshot).toMatchObject({ capabilities: ['translation'] })
    expect(await listBriefs(db as never, principalA)).toHaveLength(0)
  })

  it('refuses a brief the contract would reject', async () => {
    // Validated on the way in, not only on the way out: a row the composer cannot consume is a dead record, and
    // finding that out at read time means the save silently produced one.
    await expect(saveBrief(db as never, principalA, {
      id: 'bad', title: 'Bad', brief: { ...BRIEF, capabilities: [] } as SolutionBrief,
    })).rejects.toBeInstanceOf(SolutionsRepositoryError)
    expect(await listBriefs(db as never, principalA)).toHaveLength(0)
  })

  it('refuses a route the contract would reject', async () => {
    const broken = { ...route('ai'), status: 'unavailable' as const, unavailableReason: undefined }
    await expect(saveRun(db as never, principalA, runInput({
      routes: [{ route: broken, explanationProvenance: 'model' }],
    }))).rejects.toMatchObject({ code: 'invalid_route' })
  })
})

describe('a stored run cannot be revised', () => {
  it('exposes no update path', async () => {
    /**
     * The absent UPDATE *grant* is verified as the real role in `verify-rls-local.mjs` — under this superuser
     * connection an update would succeed. What is checkable here is the other half: the repository offers no
     * function that would attempt one, so a caller cannot reach for it by accident.
     */
    // Read from the module itself, so adding an `updateRun` export fails this test rather than passing a
    // hand-maintained list that nobody updates.
    const repository = await import('~/shared/lib/repositories/solutions')
    expect(Object.keys(repository).filter((name) => /^update/.test(name))).toEqual(['updateBrief'])
  })

  it('keeps the brief snapshot after the saved brief is edited', async () => {
    // The point of `brief_snapshot`: editing a saved brief must not retroactively change what a stored
    // recommendation was based on.
    await saveBrief(db as never, principalA, { id: 'brief-a', title: 'A', brief: BRIEF })
    await saveRun(db as never, principalA, runInput({ id: 'run-a', briefId: 'brief-a' }))

    await updateBrief(db as never, principalA, 'brief-a', {
      brief: { ...BRIEF, capabilities: ['summarization'] },
    })

    const stored = await findRun(db as never, principalA, 'run-a')
    expect((stored?.run.briefSnapshot as { capabilities: string[] }).capabilities).toEqual(['translation'])
  })

  it('records why an explanation was deterministic, and refuses the combination that makes no sense', async () => {
    await saveRun(db as never, principalA, runInput({
      id: 'run-fb',
      routes: [{ route: route('human'), explanationProvenance: 'deterministic', explanationFallbackReason: 'provider_failed' }],
    }))
    const stored = await findRun(db as never, principalA, 'run-fb')
    expect(stored?.routes[0].explanationFallbackReason).toBe('provider_failed')

    // A model-written explanation with a fallback reason is a contradiction, and the CHECK says so.
    await expectConstraintViolation(saveRun(db as never, principalA, runInput({
      routes: [{ route: route('ai'), explanationProvenance: 'model', explanationFallbackReason: 'provider_failed' }],
    })), 'solution_run_routes_fallback_reason_check')
  })
})

describe('retention, export, and deletion', () => {
  it('deleting a brief takes its runs and routes with it', async () => {
    await saveBrief(db as never, principalA, { id: 'brief-a', title: 'A', brief: BRIEF })
    await saveRun(db as never, principalA, runInput({ id: 'run-a', briefId: 'brief-a' }))

    expect(await deleteBrief(db as never, principalA, 'brief-a')).toBe(true)
    expect(await findRun(db as never, principalA, 'run-a')).toBeNull()
    expect(await db.select().from(solutionRunRoutes).where(eq(solutionRunRoutes.runId, 'run-a'))).toHaveLength(0)
  })

  it('deleting a run takes its routes and feedback, and leaves the brief', async () => {
    await saveBrief(db as never, principalA, { id: 'brief-a', title: 'A', brief: BRIEF })
    await saveRun(db as never, principalA, runInput({ id: 'run-a', briefId: 'brief-a' }))
    await recordFeedback(db as never, principalA, { id: 'fb-1', runId: 'run-a', routeType: 'ai', chosen: true })

    expect(await deleteRun(db as never, principalA, 'run-a')).toBe(true)
    expect(await db.select().from(solutionRunFeedback)).toHaveLength(0)
    // The brief survives: deleting one result is not deleting the question.
    expect(await findBrief(db as never, principalA, 'brief-a')).not.toBeNull()
  })

  it('exports everything an organization holds and nothing it does not', async () => {
    await saveRun(db as never, principalA, runInput())
    await saveRun(db as never, principalB, runInput())
    const exported = await listRuns(db as never, principalA, { limit: 1000 })
    expect(exported).toHaveLength(1)
    expect(exported.every((row) => row.organizationId === ORG_A)).toBe(true)
  })
})

describe('feedback is bounded', () => {
  it('replaces a person’s earlier answer instead of stacking one', async () => {
    // Without the unique index, one enthusiastic user could weight Phase 9's evaluation corpus by clicking
    // repeatedly.
    await saveRun(db as never, principalA, runInput({ id: 'run-a' }))
    await recordFeedback(db as never, principalA, { id: 'fb-1', runId: 'run-a', routeType: 'ai', chosen: true })
    await recordFeedback(db as never, principalA, { id: 'fb-2', runId: 'run-a', routeType: 'ai', chosen: false, reason: 'Too slow' })

    const rows = await listFeedback(db as never, principalA, 'run-a')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ chosen: false, reason: 'Too slow' })
  })

  it('lets two people disagree about the same route', async () => {
    await saveRun(db as never, principalA, runInput({ id: 'run-a' }))
    await recordFeedback(db as never, principalA, { id: 'fb-1', runId: 'run-a', routeType: 'ai', chosen: true })
    const otherMember = { organizationId: ORG_A, userId: USER_B, organizationRole: 'owner', requestId: 'req-a2' } as never
    await recordFeedback(db as never, otherMember, { id: 'fb-2', runId: 'run-a', routeType: 'ai', chosen: false })
    expect(await listFeedback(db as never, principalA, 'run-a')).toHaveLength(2)
  })

  it('refuses a reason longer than the contract allows', async () => {
    await saveRun(db as never, principalA, runInput({ id: 'run-a' }))
    await expectConstraintViolation(recordFeedback(db as never, principalA, {
      id: 'fb-1', runId: 'run-a', routeType: 'ai', chosen: true, reason: 'x'.repeat(501),
    }), 'solution_run_feedback_reason_length_check')
  })
})

describe('the public DTO', () => {
  it('omits the organization, the author, and everything billing owns', async () => {
    /**
     * Three deliberate absences. `organizationId` tells a client nothing it does not know and would appear in
     * every log that echoed the payload. `createdByUserId` is another member's identity, and a run list is not
     * a place to learn who on the team uses which feature. The credit fields are billing-owned — duplicating a
     * charge here creates a second number that can disagree with the billing surface.
     */
    await saveRun(db as never, principalA, runInput({
      id: 'run-a', creditReservationId: 'res-1', creditSettledUnits: 10,
    }))
    const stored = await findRun(db as never, principalA, 'run-a')
    const dto = toSolutionRunDto(stored!.run, stored!.routes)

    const serialized = JSON.stringify(dto)
    expect(serialized).not.toContain(ORG_A)
    expect(serialized).not.toContain(USER_A)
    expect(serialized).not.toContain('res-1')
    expect(dto).not.toHaveProperty('creditSettledUnits')
  })

  it('keeps what makes a stored recommendation auditable', async () => {
    // A user comparing two runs of the same brief needs to see that the composition actually differed.
    await saveRun(db as never, principalA, runInput({ id: 'run-a' }))
    const stored = await findRun(db as never, principalA, 'run-a')
    const dto = toSolutionRunDto(stored!.run, stored!.routes)
    expect(dto.compositionHash).toBe('chash')
    expect(dto.composerVersion).toBe('composer-1')
    expect(dto.evidenceIds).toEqual(['deepl-pro@3'])
  })

  it('orders routes human, AI, hybrid regardless of storage order', async () => {
    // Stored rows come back in whatever order the database returns, which is not an order. The UI compares
    // three lanes side by side and they must not swap places between two views of the same run.
    await saveRun(db as never, principalA, runInput({
      id: 'run-a',
      routes: [
        { route: route('hybrid'), explanationProvenance: 'model' as const },
        { route: route('ai'), explanationProvenance: 'model' as const },
        { route: route('human'), explanationProvenance: 'model' as const },
      ],
    }))
    const stored = await findRun(db as never, principalA, 'run-a')
    const dto = toSolutionRunDto(stored!.run, stored!.routes)
    expect(dto.routes.map((r) => (r as SolutionRoute).routeType)).toEqual(['human', 'ai', 'hybrid'])
    expect(dto.routeProvenance.map((p) => p.routeType)).toEqual(['human', 'ai', 'hybrid'])
  })

  it('exposes a brief without its owner', async () => {
    const saved = await saveBrief(db as never, principalA, { id: 'brief-a', title: 'A', brief: BRIEF })
    const dto = toSolutionBriefDto(saved)
    expect(JSON.stringify(dto)).not.toContain(USER_A)
    expect(dto.title).toBe('A')
  })
})
