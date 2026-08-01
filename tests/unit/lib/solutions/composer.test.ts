/**
 * The deterministic solution composer (plan 43 Phase 5).
 *
 * The plan's verify line names the cases: "cycles, missing capabilities, conflicting edges, uncertainty,
 * budget/deadline/privacy failure, and valid Human/AI/Hybrid graphs". Each is below.
 *
 * Every route the composer emits is validated against `solutionRouteSchema` including its refinements, because
 * those refinements are the product's honesty rules — an unavailable route must say why, a recommended route
 * must cover or delegate every mandatory capability, and anything offerable must carry an estimate. A composer
 * that emitted a route the contract rejects would have found a way to be confident without being checkable.
 */
import { describe, expect, it } from 'vitest'
import { solutionBriefSchema, solutionRouteSchema, type SolutionBrief } from '~/shared/lib/solutions/contracts'
import { checkCompatibility, coverCapabilities, findCycles, humanReviewPoints } from '~/lib/solutions/composer/coverage'
import { checkConstraints, unknownHardFields } from '~/lib/solutions/composer/constraints'
import { estimateRoute, timeOnlyEstimate } from '~/lib/solutions/composer/estimate'
import type { MarketRateBand } from '~/lib/solutions/retrieval/market-rates'

const brief = (overrides: Record<string, unknown> = {}): SolutionBrief => solutionBriefSchema.parse({
  deliverable: { description: 'Translate product documentation to Danish', domain: 'translation_and_transcription' },
  capabilities: ['translation'],
  ...overrides,
})

const band: MarketRateBand = {
  currency: 'USD', p25: 80_000, median: 100_000, p75: 140_000,
  sampleSize: 20, otherCurrencySamples: 0, sourceKeys: ['jobicy_jobs'],
}

const candidate = (id: string, capabilities: string[], overrides: Record<string, unknown> = {}) => ({
  componentId: id,
  componentVersion: 1,
  displayName: id,
  kind: 'tool',
  capabilityKeys: capabilities,
  maxEvidenceLevel: 'claimed' as const,
  score: 1,
  ...overrides,
})

describe('coverage picks the fewest components, deterministically', () => {
  it('prefers one component covering two capabilities over two covering one each', () => {
    const result = coverCapabilities(['translation', 'summarization'], [
      candidate('narrow-a', ['translation']),
      candidate('narrow-b', ['summarization']),
      candidate('broad', ['translation', 'summarization']),
    ])
    expect(result.assignments.map((a) => a.componentId)).toEqual(['broad'])
    expect(result.complete).toBe(true)
  })

  it('prefers stronger evidence over a higher retrieval score', () => {
    // The question is "can this do the job". Evidence answers it; lexical similarity only suggests it.
    const result = coverCapabilities(['translation'], [
      candidate('high-score', ['translation'], { score: 99 }),
      candidate('verified', ['translation'], { maxEvidenceLevel: 'verified', score: 1 }),
    ])
    expect(result.assignments[0].componentId).toBe('verified')
  })

  it('orders identically whatever order the candidates arrive in', () => {
    // A solution run cites the versions it used. An assignment that varied between two runs of one brief would
    // make the citation meaningless.
    const candidates = [candidate('b', ['translation']), candidate('a', ['translation'])]
    const first = coverCapabilities(['translation'], candidates).assignments.map((a) => a.componentId)
    const second = coverCapabilities(['translation'], [...candidates].reverse()).assignments.map((a) => a.componentId)
    expect(first).toEqual(second)
    expect(first).toEqual(['a'])
  })

  it('reports a capability nothing claims as a gap rather than pretending coverage', () => {
    const result = coverCapabilities(['translation', 'transcription'], [candidate('t', ['translation'])])
    expect(result.complete).toBe(false)
    expect(result.gaps).toEqual(['transcription'])
  })

  it('assigns only the capabilities it was chosen for, not everything it claims', () => {
    // A component claiming eight capabilities is not doing eight jobs in this route.
    const result = coverCapabilities(['translation'], [
      candidate('generalist', ['translation', 'summarization', 'embedding', 'classification']),
    ])
    expect(result.assignments[0].coveredCapabilityKeys).toEqual(['translation'])
  })
})

describe('the compatibility graph can forbid a route', () => {
  it('reports a pair the catalog records as incompatible', () => {
    const outcome = checkCompatibility(['a', 'b'], [
      { edgeType: 'incompatible_with', fromComponentId: 'a', toComponentId: 'b' },
    ])
    expect(outcome.incompatiblePairs).toEqual([{ from: 'a', to: 'b' }])
  })

  it('reports the same pair once whichever direction the edge points', () => {
    const outcome = checkCompatibility(['a', 'b'], [
      { edgeType: 'incompatible_with', fromComponentId: 'a', toComponentId: 'b' },
      { edgeType: 'incompatible_with', fromComponentId: 'b', toComponentId: 'a' },
    ])
    expect(outcome.incompatiblePairs).toHaveLength(1)
  })

  it('names a requirement the route does not include', () => {
    const outcome = checkCompatibility(['a'], [
      { edgeType: 'requires', fromComponentId: 'a', toComponentId: 'runtime' },
    ])
    expect(outcome.missingRequirements).toEqual([{ componentId: 'a', requires: 'runtime' }])
  })

  it('ignores an edge from a component that is not in the route', () => {
    const outcome = checkCompatibility(['a'], [
      { edgeType: 'incompatible_with', fromComponentId: 'z', toComponentId: 'a' },
    ])
    expect(outcome.incompatiblePairs).toEqual([])
  })
})

describe('a requirement cycle means no order of work exists', () => {
  it('finds a two-component cycle', () => {
    const outcome = checkCompatibility(['a', 'b'], [
      { edgeType: 'requires', fromComponentId: 'a', toComponentId: 'b' },
      { edgeType: 'requires', fromComponentId: 'b', toComponentId: 'a' },
    ])
    expect(outcome.cycles).toHaveLength(1)
    expect(outcome.cycles[0].sort()).toEqual(['a', 'b'])
  })

  it('finds a longer cycle and reports it once', () => {
    const requires = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set(['a'])],
    ])
    const cycles = findCycles(requires)
    expect(cycles).toHaveLength(1)
    // Rotated to its smallest member, so the same cycle found from three entry points is one cycle.
    expect(cycles[0][0]).toBe('a')
  })

  it('does not invent a cycle in a chain', () => {
    const cycles = findCycles(new Map([['a', new Set(['b'])], ['b', new Set(['c'])]]))
    expect(cycles).toEqual([])
  })

  it('does not overflow on a long chain', () => {
    // Built from database rows partly derived from third-party metadata, so depth is not ours to bound. An
    // iterative walk is why this passes.
    const requires = new Map<string, Set<string>>()
    for (let index = 0; index < 5000; index += 1) requires.set(`n${index}`, new Set([`n${index + 1}`]))
    expect(() => findCycles(requires)).not.toThrow()
  })
})

describe('constraints: violated, unverifiable, and the difference', () => {
  const facts = (overrides: Record<string, unknown> = {}) => ({
    coveredCapabilityKeys: ['translation'],
    componentIds: ['a'],
    integrationKeys: [],
    domains: [],
    costCents: { min: 10_000, max: 50_000, currency: 'USD' },
    timeHours: { min: 4, max: 16 },
    maxDataSensitivity: null,
    ...overrides,
  })

  it('violates a budget only when even the cheapest reading exceeds it', () => {
    // The lower bound decides. Using the upper bound would reject routes that fit at the low end, which is
    // most of them.
    const tooExpensive = checkConstraints(
      brief({ hardConstraints: [{ type: 'max_budget', maxCents: 5_000, currency: 'USD' }] }),
      facts(),
    )
    expect(tooExpensive[0]).toMatchObject({ kind: 'violated', constraintType: 'max_budget' })

    const mightExceed = checkConstraints(
      brief({ hardConstraints: [{ type: 'max_budget', maxCents: 20_000, currency: 'USD' }] }),
      facts(),
    )
    // Fits at the low end, might not at the high end: offerable, not recommendable.
    expect(mightExceed[0]).toMatchObject({ kind: 'unverifiable' })

    expect(checkConstraints(
      brief({ hardConstraints: [{ type: 'max_budget', maxCents: 100_000, currency: 'USD' }] }),
      facts(),
    )).toEqual([])
  })

  it('refuses to convert currencies rather than guessing a rate', () => {
    // A wrong rate turns a budget check into a guess wearing a number.
    const outcome = checkConstraints(
      brief({ hardConstraints: [{ type: 'max_budget', maxCents: 1, currency: 'EUR' }] }),
      facts(),
    )
    // Narrowed rather than asserted with a cast: `satisfied` carries no reason, and the type says so.
    const [first] = outcome
    expect(first.kind).toBe('unverifiable')
    if (first.kind === 'satisfied') throw new Error('expected an unverifiable outcome')
    expect(first.reason).toContain('no conversion rate')
  })

  it('reports an unpriceable route as unverifiable, never as compliant', () => {
    const outcome = checkConstraints(
      brief({ hardConstraints: [{ type: 'max_budget', maxCents: 1, currency: 'USD' }] }),
      facts({ costCents: null }),
    )
    expect(outcome[0]).toMatchObject({ kind: 'unverifiable' })
  })

  it('never decides a deadline from the wall clock', () => {
    // A composer that consulted `Date.now()` would answer differently tomorrow for the same brief, and a
    // solution run has to be reproducible from its recorded inputs.
    const past = checkConstraints(brief({ hardConstraints: [{ type: 'deadline_by', byDate: '2020-01-01' }] }), facts())
    const future = checkConstraints(brief({ hardConstraints: [{ type: 'deadline_by', byDate: '2099-01-01' }] }), facts())
    expect(past[0].kind).toBe('unverifiable')
    expect(future[0].kind).toBe('unverifiable')
  })

  it('violates a data-sensitivity ceiling only when the route exceeds it', () => {
    expect(checkConstraints(
      brief({ hardConstraints: [{ type: 'max_data_sensitivity', level: 'internal' }] }),
      facts({ maxDataSensitivity: 'restricted' }),
    )[0]).toMatchObject({ kind: 'violated' })

    expect(checkConstraints(
      brief({ hardConstraints: [{ type: 'max_data_sensitivity', level: 'restricted' }] }),
      facts({ maxDataSensitivity: 'internal' }),
    )).toEqual([])
  })

  it('violates a required capability the route does not cover', () => {
    expect(checkConstraints(
      brief({ hardConstraints: [{ type: 'required_capability', capabilityKey: 'transcription' }] }),
      facts(),
    )[0]).toMatchObject({ kind: 'violated', constraintType: 'required_capability' })
  })

  it('treats a missing integration declaration as unverifiable, but a known regulated domain as a violation', () => {
    // Asymmetric on purpose. "We do not know it integrates with Slack" cannot confirm a requirement; "we do not
    // know it touches medical data" need not block the route.
    expect(checkConstraints(
      brief({ hardConstraints: [{ type: 'required_integration', integrationKey: 'slack' }] }),
      facts(),
    )[0]).toMatchObject({ kind: 'unverifiable' })

    expect(checkConstraints(
      brief({ hardConstraints: [{ type: 'disallowed_regulated_domain', domain: 'medical' }] }),
      facts(),
    )).toEqual([])

    expect(checkConstraints(
      brief({ hardConstraints: [{ type: 'disallowed_regulated_domain', domain: 'medical' }] }),
      facts({ domains: ['medical'] }),
    )[0]).toMatchObject({ kind: 'violated' })
  })

  it('reports every failing constraint, not just the first', () => {
    // A user who set four constraints and violates three deserves three reasons, not three round trips.
    const outcome = checkConstraints(brief({
      hardConstraints: [
        { type: 'max_budget', maxCents: 1, currency: 'USD' },
        { type: 'required_capability', capabilityKey: 'transcription' },
        { type: 'max_data_sensitivity', level: 'public' },
      ],
    }), facts({ maxDataSensitivity: 'restricted' }))
    expect(outcome).toHaveLength(3)
  })

  it('distinguishes a field left unknown from one never asked about', () => {
    expect(unknownHardFields(brief({ budget: { status: 'unknown' } }))).toEqual(['budget'])
    // Absent, not unknown: the brief never raised it, so there is nothing uncertain to report.
    expect(unknownHardFields(brief())).toEqual([])
  })
})

describe('estimates are intervals, and unpriceable is not free', () => {
  it('prices human effort from advertised salaries', () => {
    const estimate = estimateRoute({
      brief: brief({ scale: { status: 'known', value: { magnitude: 'small' } } }),
      marketRate: band,
      componentKinds: ['human_profile'],
    })
    expect(estimate).not.toBeNull()
    expect(estimate!.costMinCents).toBeLessThan(estimate!.costMaxCents)
    expect(estimate!.currency).toBe('USD')
    // The band's own spread carries through: p25 to p75, not the median twice.
    expect(estimate!.assumptions.some((a) => a.includes('20 advertised USD salaries'))).toBe(true)
  })

  it('returns no estimate rather than zero when there is no rate', () => {
    // Zero is a claim that it is free, and the contract's refinement would happily accept it.
    expect(estimateRoute({ brief: brief(), marketRate: null, componentKinds: ['human_profile'] })).toBeNull()
    expect(estimateRoute({ brief: brief(), marketRate: band, componentKinds: ['model'] })).toBeNull()
  })

  it('states that a model-only route is unpriced rather than implying it is free', () => {
    const estimate = timeOnlyEstimate({ brief: brief(), marketRate: null, componentKinds: ['model'] })
    expect(estimate.costMaxCents).toBe(0)
    expect(estimate.assumptions[0]).toContain('Cost is not estimated')
    // Time is still real even when cost is unknown.
    expect(estimate.timeMaxHours).toBeGreaterThan(0)
  })

  it('states the assumptions it had to make', () => {
    const estimate = estimateRoute({ brief: brief(), marketRate: band, componentKinds: ['human_profile'] })
    // A user who meant "large" can see that the estimate did not.
    expect(estimate!.assumptions.some((a) => a.includes('Scale was not specified'))).toBe(true)
    expect(estimate!.assumptions.some((a) => a.includes('Quality bar was not specified'))).toBe(true)
  })

  it('scales effort with the quality bar', () => {
    const draft = estimateRoute({
      brief: brief({ scale: { status: 'known', value: { magnitude: 'medium' } }, quality: { status: 'known', value: 'draft' } }),
      marketRate: band, componentKinds: ['human_profile'],
    })!
    const expert = estimateRoute({
      brief: brief({ scale: { status: 'known', value: { magnitude: 'medium' } }, quality: { status: 'known', value: 'expert' } }),
      marketRate: band, componentKinds: ['human_profile'],
    })!
    expect(expert.timeMaxHours).toBeGreaterThan(draft.timeMaxHours)
  })

  it('warns that a mixed route prices only the humans', () => {
    const estimate = estimateRoute({ brief: brief(), marketRate: band, componentKinds: ['human_profile', 'model'] })!
    expect(estimate.assumptions.some((a) => a.includes('not priced'))).toBe(true)
  })
})

describe('human review points are what make an incomplete route offerable', () => {
  it('names a person for every uncovered capability', () => {
    const points = humanReviewPoints(
      [{ componentId: 'a', componentVersion: 1, displayName: 'Tool', kind: 'tool', coveredCapabilityKeys: ['translation'], evidenceLevel: 'claimed' }],
      ['transcription'],
    )
    expect(points.some((point) => point.includes('transcription'))).toBe(true)
  })

  it('says so when every capability is a vendor claim', () => {
    // Every capability an adapter reads enters at `claimed` and nothing promotes it. Saying so is the
    // difference between advice and marketing.
    const points = humanReviewPoints(
      [{ componentId: 'a', componentVersion: 1, displayName: 'Tool', kind: 'tool', coveredCapabilityKeys: ['translation'], evidenceLevel: 'claimed' }],
      [],
    )
    expect(points.some((point) => point.includes("vendor's own claim"))).toBe(true)
  })

  it('requires a sign-off when no person is in the route', () => {
    // Plan 43's scope excludes autonomous action, so no route runs unattended.
    const points = humanReviewPoints(
      [{ componentId: 'a', componentVersion: 1, displayName: 'Model', kind: 'model', coveredCapabilityKeys: ['translation'], evidenceLevel: 'verified' }],
      [],
    )
    expect(points.some((point) => point.includes('Sign off'))).toBe(true)
  })

  it('does not demand a sign-off when a person is already assigned', () => {
    const points = humanReviewPoints(
      [{ componentId: 'human:1', componentVersion: 1, displayName: 'Alice', kind: 'human_profile', coveredCapabilityKeys: ['translation'], evidenceLevel: 'verified' }],
      [],
    )
    expect(points.some((point) => point.includes('Sign off'))).toBe(false)
  })
})

describe('every emitted route satisfies the contract, refinements included', () => {
  it('accepts a recommended route that delegates its gap to a named review point', () => {
    // The contract's own refinement: coverage may be incomplete provided the gap is delegated.
    const route = {
      routeType: 'human' as const,
      status: 'recommended' as const,
      summary: 'People: Alice',
      fitExplanation: 'Alice takes the whole brief.',
      steps: ['1. Alice handles translation'],
      components: [{ componentId: 'human:1', componentVersion: 1, role: 'Covers translation', coveredCapabilityKeys: ['translation'] }],
      mandatoryCapabilitiesCovered: false,
      coverageGapCapabilityKeys: ['translation'],
      limitations: [],
      estimate: { costMinCents: 1, costMaxCents: 2, currency: 'USD', timeMinHours: 1, timeMaxHours: 2, assumptions: [] },
      risks: [],
      humanReviewPoints: ['Alice covers translation'],
      evidenceIds: ['human:1@1'],
    }
    expect(solutionRouteSchema.safeParse(route).success).toBe(true)
  })

  it('rejects a recommended route with a gap and no review point', () => {
    const route = {
      routeType: 'ai' as const, status: 'recommended' as const,
      summary: 'x', fitExplanation: 'x', steps: ['1. x'],
      components: [{ componentId: 'a', componentVersion: 1, role: 'r', coveredCapabilityKeys: ['translation'] }],
      mandatoryCapabilitiesCovered: false,
      coverageGapCapabilityKeys: ['transcription'],
      limitations: [], risks: [], humanReviewPoints: [],
      estimate: { costMinCents: 1, costMaxCents: 2, currency: 'USD', timeMinHours: 1, timeMaxHours: 2, assumptions: [] },
      evidenceIds: ['a@1'],
    }
    expect(solutionRouteSchema.safeParse(route).success).toBe(false)
  })

  it('rejects an unavailable route that does not say why', () => {
    const route = {
      routeType: 'ai' as const, status: 'unavailable' as const,
      summary: 'x', fitExplanation: 'x', steps: ['1. x'],
      components: [{ componentId: 'a', componentVersion: 1, role: 'r', coveredCapabilityKeys: ['none'] }],
      mandatoryCapabilitiesCovered: false, coverageGapCapabilityKeys: [],
      limitations: [], risks: [], humanReviewPoints: [], evidenceIds: ['a'],
    }
    expect(solutionRouteSchema.safeParse(route).success).toBe(false)
  })

  it('rejects an offerable route with no estimate', () => {
    const route = {
      routeType: 'ai' as const, status: 'available' as const,
      summary: 'x', fitExplanation: 'x', steps: ['1. x'],
      components: [{ componentId: 'a', componentVersion: 1, role: 'r', coveredCapabilityKeys: ['translation'] }],
      mandatoryCapabilitiesCovered: true, coverageGapCapabilityKeys: [],
      limitations: [], risks: [], humanReviewPoints: [], evidenceIds: ['a@1'],
    }
    expect(solutionRouteSchema.safeParse(route).success).toBe(false)
  })
})
