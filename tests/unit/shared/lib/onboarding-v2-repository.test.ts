import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  alerts,
  authUsers,
  builderClaims,
  builderIdentities,
  feedCapabilities,
  onboardingProgress,
  organizations,
  savedQueries,
  userPreferences,
} from '~/shared/lib/db/schema'
import type { TenantTransaction } from '~/shared/lib/db/client'
import {
  advanceOnboarding,
  countActivationEvidence,
  getOnboardingV2State,
  recordActivation,
  toStatusV2,
} from '~/shared/lib/onboarding-v2-repository'
import { onboardingStatusV2Schema } from '~/shared/lib/onboarding-api'

/**
 * The v2 state on top of the v1 row.
 *
 * The properties worth pinning are the ones that decide whether a rollout can be undone: a v1 row
 * still reads, the v1 column keeps moving in step with the v2 one, and an activation records once.
 */

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'org-1'
const USER = 'user-1'

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('onboarding_v2')
  db = disposable.db
  drop = disposable.drop
  await db.insert(organizations).values({ id: ORG, name: 'Org', slug: 'org-1' })
  await db.insert(authUsers).values({ id: USER, name: 'U', email: 'u@example.test', emailVerified: true })
}, 60_000)

afterAll(async () => {
  await drop?.()
})

beforeEach(async () => {
  await db.delete(onboardingProgress)
  await db.delete(userPreferences)
})

const tx = () => db as unknown as TenantTransaction

async function chooseSegment(segment: string) {
  await db.insert(userPreferences).values({
    userId: USER, primarySegment: segment, segmentSource: 'onboarding', segmentSchemaVersion: 1,
  })
}

describe('the route comes from the stored segment', () => {
  it('is general for somebody who never answered', async () => {
    const state = await getOnboardingV2State(tx(), ORG, USER)
    expect(state.preset).toBe('general')
    expect(state.currentStep).toBe('welcome')
  })

  it('follows the segment once chosen', async () => {
    await chooseSegment('investing')
    const state = await getOnboardingV2State(tx(), ORG, USER)
    expect(state.preset).toBe('investing')
  })

  /**
   * Changing your goal halfway is allowed, and being stranded on a step your new flow does not
   * contain is not a state the interface can render — so the person restarts on the route they are
   * on now rather than crashing the page they return to.
   */
  it('restarts somebody whose stored step belongs to a flow they left', async () => {
    await chooseSegment('hiring')
    await db.insert(onboardingProgress).values({
      userId: USER, organizationId: ORG, currentStepKey: 'hiring_search', flowVersion: 2, step: 2,
    })
    expect((await getOnboardingV2State(tx(), ORG, USER)).currentStep).toBe('hiring_search')

    await db.update(userPreferences).set({ primarySegment: 'building' })
    expect((await getOnboardingV2State(tx(), ORG, USER)).currentStep).toBe('welcome')
  })

  /** A row written by v1 has no step key at all, and must still read. */
  it('reads a v1 row without a step key', async () => {
    await db.insert(onboardingProgress).values({ userId: USER, organizationId: ORG, step: 2 })
    const state = await getOnboardingV2State(tx(), ORG, USER)
    expect(state.currentStep).toBe('welcome')
    expect(state.completed).toBe(false)
  })
})

describe('advancing', () => {
  it('moves one step and keeps the v1 column in step', async () => {
    await chooseSegment('hiring')
    const first = await advanceOnboarding(tx(), ORG, USER, 'welcome')
    expect(first.ok).toBe(true)
    expect(first.state.currentStep).toBe('goal')

    const [row] = await db.select().from(onboardingProgress)
    expect(row.currentStepKey).toBe('goal')
    expect(row.flowVersion).toBe(2)
    // A consumer that has not moved to v2 keeps reading something true.
    expect(row.step).toBe(1)
  })

  /**
   * Two refusals, because they mean different things to a caller. `stale_step` says "you are not
   * where you think you are" and the answer is to re-read; the other says the move is illegal on
   * this route, which is a bug. One code for both would make a retry loop look like a broken client.
   */
  it('refuses a stale step distinctly from an illegal one', async () => {
    await chooseSegment('hiring')
    const stale = await advanceOnboarding(tx(), ORG, USER, 'hiring_search')
    expect(stale.ok).toBe(false)
    expect(stale.reason).toBe('stale_step')

    await advanceOnboarding(tx(), ORG, USER, 'welcome')
    const fromDone = await advanceOnboarding(tx(), ORG, USER, 'goal')
    expect(fromDone.ok).toBe(true)
  })

  it('completes at the end of the route', async () => {
    await chooseSegment('other')
    for (const step of ['welcome', 'goal', 'general_search', 'general_save', 'confirmation', 'next_step'] as const) {
      const result = await advanceOnboarding(tx(), ORG, USER, step)
      expect(result.ok, `advancing from ${step}`).toBe(true)
    }
    const [row] = await db.select().from(onboardingProgress)
    expect(row.currentStepKey).toBe('done')
    expect(row.completed).toBe(true)
    expect(row.step).toBe(3)
    expect(row.completedAt).not.toBeNull()
  })
})

describe('activation', () => {
  it('is not reached by walking the flow', async () => {
    await chooseSegment('hiring')
    const reached = await recordActivation(tx(), ORG, USER, {
      trackedBuilders: 0, sourcingSprints: 0, savedSearchesWithAlert: 0, builderClaims: 0,
    })
    expect(reached).toBeNull()
  })

  it('records the kind that was actually reached', async () => {
    await chooseSegment('hiring')
    await db.insert(onboardingProgress).values({ userId: USER, organizationId: ORG, step: 0 })

    const reached = await recordActivation(tx(), ORG, USER, {
      trackedBuilders: 3, sourcingSprints: 0, savedSearchesWithAlert: 0, builderClaims: 0,
    }, 'ref-1')

    expect(reached).toBe('tracked_builders')
    const [row] = await db.select().from(onboardingProgress)
    expect(row.activationType).toBe('tracked_builders')
    expect(row.activationRefId).toBe('ref-1')
    expect(row.activatedAt).not.toBeNull()
  })

  /**
   * A route can activate somebody who has no progress row at all — the investing branch arms a
   * saved search straight from the goal step, and nothing before it has written a step. This was an
   * `UPDATE`, which matched zero rows there and reported success; the activation simply vanished.
   */
  it('records an activation for somebody with no progress row yet', async () => {
    await chooseSegment('investing')

    const reached = await recordActivation(tx(), ORG, USER, {
      trackedBuilders: 0, sourcingSprints: 0, savedSearchesWithAlert: 1, builderClaims: 0,
    }, 'q-1')

    expect(reached).toBe('saved_search_alert')
    const [row] = await db.select().from(onboardingProgress)
    expect(row.activationType).toBe('saved_search_alert')
    expect(row.activatedAt).not.toBeNull()
  })

  /**
   * The first real act is the one that counts. A later activation of another kind would move
   * `activated_at` and quietly corrupt every time-to-activation figure computed from it.
   */
  it('never overwrites the first one', async () => {
    await chooseSegment('hiring')
    await db.insert(onboardingProgress).values({ userId: USER, organizationId: ORG, step: 0 })

    await recordActivation(tx(), ORG, USER, {
      trackedBuilders: 3, sourcingSprints: 0, savedSearchesWithAlert: 0, builderClaims: 0,
    })
    const [before] = await db.select().from(onboardingProgress)

    const again = await recordActivation(tx(), ORG, USER, {
      trackedBuilders: 0, sourcingSprints: 1, savedSearchesWithAlert: 0, builderClaims: 0,
    })

    expect(again).toBe('tracked_builders')
    const [after] = await db.select().from(onboardingProgress)
    expect(after.activationType).toBe('tracked_builders')
    expect(after.activatedAt?.toISOString()).toBe(before.activatedAt?.toISOString())
  })
})

/**
 * What counts as evidence (plan: phase-2/03-onboarding-segmentado, investing branch).
 *
 * The route used to derive `savedSearchesWithAlert` from "does a saved query exist", which was the
 * same fact as `trackedBuilders` under another name — it would have recorded an investing activation
 * for somebody whose search nobody was watching.
 */
describe('counting the evidence', () => {
  const OTHER_USER = 'user-2'

  beforeAll(async () => {
    await db.insert(authUsers).values({ id: OTHER_USER, name: 'V', email: 'v@example.test', emailVerified: true })
  })

  beforeEach(async () => {
    await db.delete(feedCapabilities)
    await db.delete(alerts)
    await db.delete(builderClaims)
    await db.delete(savedQueries)
    await db.delete(builderIdentities)
  })

  async function savedQuery(id: string, userId = USER) {
    await db.insert(savedQueries).values({
      id, organizationId: ORG, userId, name: id, keywords: ['fintech'],
    })
  }

  it('counts nothing for somebody who has done nothing', async () => {
    const evidence = await countActivationEvidence(tx(), ORG, USER, 0)
    expect(evidence).toEqual({
      trackedBuilders: 0, sourcingSprints: 0, savedSearchesWithAlert: 0, builderClaims: 0,
    })
  })

  /** A saved search on its own is not armed — nothing delivers it. */
  it('does not count a saved search nobody is watching', async () => {
    await savedQuery('q-bare')
    expect((await countActivationEvidence(tx(), ORG, USER, 0)).savedSearchesWithAlert).toBe(0)
  })

  it('counts an alert tied to the saved search', async () => {
    await savedQuery('q-1')
    await db.insert(alerts).values({
      id: 'a-1', organizationId: ORG, userId: USER, queryId: 'q-1', name: 'a', keywords: ['fintech'],
    })
    expect((await countActivationEvidence(tx(), ORG, USER, 0)).savedSearchesWithAlert).toBe(1)
  })

  /**
   * An alert with no `queryId` watches keywords, not a saved search. It is a real feature and a real
   * row — it is just not the thing this activation is about.
   */
  it('ignores an alert that is not tied to a saved search', async () => {
    await db.insert(alerts).values({
      id: 'a-loose', organizationId: ORG, userId: USER, name: 'a', keywords: ['fintech'],
    })
    expect((await countActivationEvidence(tx(), ORG, USER, 0)).savedSearchesWithAlert).toBe(0)
  })

  it('ignores a disabled alert', async () => {
    await savedQuery('q-2')
    await db.insert(alerts).values({
      id: 'a-2', organizationId: ORG, userId: USER, queryId: 'q-2', name: 'a', keywords: [], enabled: false,
    })
    expect((await countActivationEvidence(tx(), ORG, USER, 0)).savedSearchesWithAlert).toBe(0)
  })

  /**
   * The free path. `/api/alerts` answers 402 without `paidActionsAllowed`, and a brand-new
   * organization is on `free` — counting only alerts would have made this route's activation rate a
   * measure of conversion to Pro rather than of the route.
   */
  it('counts a minted feed capability as armed', async () => {
    await savedQuery('q-3')
    await db.insert(feedCapabilities).values({
      id: 'cap-1', organizationId: ORG, queryId: 'q-3', capabilityHash: 'hash-1',
    })
    expect((await countActivationEvidence(tx(), ORG, USER, 0)).savedSearchesWithAlert).toBe(1)
  })

  it('stops counting a revoked feed capability', async () => {
    await savedQuery('q-4')
    await db.insert(feedCapabilities).values({
      id: 'cap-2', organizationId: ORG, queryId: 'q-4', capabilityHash: 'hash-2', revokedAt: new Date(),
    })
    expect((await countActivationEvidence(tx(), ORG, USER, 0)).savedSearchesWithAlert).toBe(0)
  })

  /**
   * A saved search belongs to the organization, but an activation belongs to a person. Without this,
   * one teammate arming a search would mark every colleague as activated, and the investing funnel
   * would read as a success the moment one person used the product.
   */
  it('does not credit somebody for a teammate having armed a search', async () => {
    await savedQuery('q-theirs', OTHER_USER)
    await db.insert(alerts).values({
      id: 'a-theirs', organizationId: ORG, userId: OTHER_USER, queryId: 'q-theirs', name: 'a', keywords: [],
    })
    await db.insert(feedCapabilities).values({
      id: 'cap-theirs', organizationId: ORG, queryId: 'q-theirs', capabilityHash: 'hash-theirs',
    })

    expect((await countActivationEvidence(tx(), ORG, USER, 0)).savedSearchesWithAlert).toBe(0)
    expect((await countActivationEvidence(tx(), ORG, OTHER_USER, 0)).savedSearchesWithAlert).toBe(2)
  })

  /**
   * Pending counts. The spec asks for "claim verified, or — if verification is asynchronous — claim
   * started with a clear next step", and this product's verification is asynchronous.
   */
  it('counts a pending claim, and not a rejected one', async () => {
    await db.insert(builderIdentities).values([
      { id: 'bi-1', source: 'github', sourceId: '1', username: 'a', profileUrl: 'https://x.test/a' },
      { id: 'bi-2', source: 'github', sourceId: '2', username: 'b', profileUrl: 'https://x.test/b' },
    ])
    await db.insert(builderClaims).values([
      {
        id: 'bc-1', builderIdentityId: 'bi-1', subjectUserId: USER,
        evidenceSource: 'github', evidenceReference: 'a', status: 'pending',
      },
      {
        id: 'bc-2', builderIdentityId: 'bi-2', subjectUserId: USER,
        evidenceSource: 'github', evidenceReference: 'b', status: 'rejected',
      },
    ])

    expect((await countActivationEvidence(tx(), ORG, USER, 0)).builderClaims).toBe(1)
  })

  /** v1 already reads `onboarding_selected_builders`; a second count here could disagree with it. */
  it('passes the tracked-builder count straight through', async () => {
    expect((await countActivationEvidence(tx(), ORG, USER, 3)).trackedBuilders).toBe(3)
  })
})

describe('the wire shape', () => {
  it('validates against its own schema, legacy reading included', async () => {
    await chooseSegment('building')
    const state = await getOnboardingV2State(tx(), ORG, USER)
    const payload = toStatusV2(state, true)

    expect(onboardingStatusV2Schema.safeParse(payload).success).toBe(true)
    expect(payload.preset).toBe('building')
    expect(payload.flow).toContain('building_claim')
    expect(payload.legacy.step).toBe(0)
  })
})
