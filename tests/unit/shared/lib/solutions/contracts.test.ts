import { describe, expect, it } from 'vitest'
import {
  compatibilityEdgeSchema,
  hardConstraintSchema,
  solutionBriefSchema,
  solutionRouteSchema,
  solutionRunSchema,
} from '~/shared/lib/solutions/contracts'

function validBrief(overrides: Partial<Parameters<typeof solutionBriefSchema.parse>[0]> = {}) {
  return {
    deliverable: { description: 'Translate a 20-page manual into Spanish', domain: 'translation_and_transcription' },
    capabilities: ['translation'],
    inputFormats: ['docx'],
    outputFormats: ['docx'],
    languages: ['en', 'es'],
    rankingMode: 'recommended',
    ...overrides,
  }
}

describe('solutionBriefSchema', () => {
  it('accepts a minimal valid brief for each of the three domains-of-emphasis lanes', () => {
    expect(solutionBriefSchema.parse(validBrief())).toMatchObject({ rankingMode: 'recommended' })
    expect(solutionBriefSchema.parse(validBrief({ deliverable: { description: 'Build a REST API', domain: 'software_and_ai' }, capabilities: ['backend_development'] }))).toBeTruthy()
    expect(solutionBriefSchema.parse(validBrief({ deliverable: { description: 'Clean a dataset', domain: 'research_and_data' }, capabilities: ['data_cleaning'] }))).toBeTruthy()
  })

  it('distinguishes unknown from absent for optional fields', () => {
    const withUnknownBudget = solutionBriefSchema.parse(validBrief({ budget: { status: 'unknown' } }))
    expect(withUnknownBudget.budget).toEqual({ status: 'unknown' })
    const withoutBudget = solutionBriefSchema.parse(validBrief())
    expect(withoutBudget.budget).toBeUndefined()
  })

  it('accepts a known budget value wrapped in the status envelope', () => {
    const brief = solutionBriefSchema.parse(validBrief({ budget: { status: 'known', value: { maxCents: 50000, currency: 'usd' } } }))
    expect(brief.budget).toEqual({ status: 'known', value: { maxCents: 50000, currency: 'usd' } })
  })

  it('rejects an unknown persisted field (closed schema)', () => {
    expect(() => solutionBriefSchema.parse(validBrief({ extraField: 'nope' } as never))).toThrow()
  })

  it('rejects an empty capabilities list', () => {
    expect(() => solutionBriefSchema.parse(validBrief({ capabilities: [] }))).toThrow()
  })

  it('rejects an invalid domain', () => {
    expect(() => solutionBriefSchema.parse(validBrief({ deliverable: { description: 'x', domain: 'medical_diagnosis' } }))).toThrow()
  })

  it('rejects an invalid ranking mode', () => {
    expect(() => solutionBriefSchema.parse(validBrief({ rankingMode: 'cheapest' }))).toThrow()
  })
})

describe('hardConstraintSchema', () => {
  it('accepts every constraint type with its own strict shape', () => {
    expect(hardConstraintSchema.parse({ type: 'max_budget', maxCents: 10000, currency: 'usd' })).toBeTruthy()
    expect(hardConstraintSchema.parse({ type: 'deadline_by', byDate: '2026-08-01' })).toBeTruthy()
    expect(hardConstraintSchema.parse({ type: 'max_data_sensitivity', level: 'confidential' })).toBeTruthy()
    expect(hardConstraintSchema.parse({ type: 'required_capability', capabilityKey: 'translation' })).toBeTruthy()
    expect(hardConstraintSchema.parse({ type: 'required_integration', integrationKey: 'slack' })).toBeTruthy()
    expect(hardConstraintSchema.parse({ type: 'excluded_component', componentId: 'comp_1' })).toBeTruthy()
    expect(hardConstraintSchema.parse({ type: 'disallowed_regulated_domain', domain: 'medical' })).toBeTruthy()
  })

  it('rejects a disallowed_regulated_domain constraint with an empty domain', () => {
    expect(() => hardConstraintSchema.parse({ type: 'disallowed_regulated_domain', domain: '' })).toThrow()
  })

  it('rejects mixing fields from a different constraint type', () => {
    expect(() => hardConstraintSchema.parse({ type: 'max_budget', byDate: '2026-08-01' })).toThrow()
  })
})

describe('compatibilityEdgeSchema', () => {
  function validEdge(overrides: Record<string, unknown> = {}) {
    return {
      id: 'edge_1',
      version: 1,
      type: 'can_perform',
      fromComponentId: 'comp_a',
      toComponentId: 'comp_b',
      evidenceIds: ['ev_1'],
      confidence: 0.9,
      discoveryMethod: 'official_metadata',
      validFrom: '2026-01-01T00:00:00Z',
      lastVerifiedAt: '2026-01-01T00:00:00Z',
      status: 'active',
      ...overrides,
    }
  }

  it('accepts a valid active edge', () => {
    expect(compatibilityEdgeSchema.parse(validEdge())).toBeTruthy()
  })

  it('rejects an edge with missing evidence', () => {
    expect(() => compatibilityEdgeSchema.parse(validEdge({ evidenceIds: [] }))).toThrow()
  })

  it('rejects an invalid graph: a self-referential edge', () => {
    expect(() => compatibilityEdgeSchema.parse(validEdge({ toComponentId: 'comp_a' }))).toThrow()
  })

  it('rejects a semantic-similarity-discovered edge that is auto-activated at full confidence', () => {
    expect(() => compatibilityEdgeSchema.parse(validEdge({ discoveryMethod: 'semantic_similarity_reviewed', confidence: 1 }))).toThrow()
  })

  it('accepts a semantic-similarity-discovered edge only as proposed, not active', () => {
    expect(compatibilityEdgeSchema.parse(validEdge({ discoveryMethod: 'semantic_similarity_reviewed', confidence: 0.6, status: 'proposed' }))).toBeTruthy()
  })

  it('rejects validUntil before validFrom', () => {
    expect(() => compatibilityEdgeSchema.parse(validEdge({ validUntil: '2025-01-01T00:00:00Z' }))).toThrow()
  })
})

describe('solutionRouteSchema', () => {
  function validRoute(overrides: Record<string, unknown> = {}) {
    return {
      routeType: 'human',
      status: 'recommended',
      summary: 'A translator handles this end to end',
      fitExplanation: 'Matches the language pair and quality bar',
      steps: ['Assign translator', 'Deliver draft', 'Review'],
      components: [{ componentId: 'comp_1', componentVersion: 1, role: 'translator', coveredCapabilityKeys: ['translation'] }],
      mandatoryCapabilitiesCovered: true,
      estimate: { costMinCents: 1000, costMaxCents: 2000, currency: 'usd', timeMinHours: 1, timeMaxHours: 3 },
      evidenceIds: ['ev_1'],
      ...overrides,
    }
  }

  it('accepts a valid recommended route with full coverage', () => {
    expect(solutionRouteSchema.parse(validRoute())).toBeTruthy()
  })

  it('rejects a recommended route with an uncovered mandatory capability and no human review point', () => {
    expect(() => solutionRouteSchema.parse(validRoute({ mandatoryCapabilitiesCovered: false, coverageGapCapabilityKeys: ['translation'] }))).toThrow()
  })

  it('accepts a recommended route with a coverage gap explicitly delegated to a human review point', () => {
    const route = solutionRouteSchema.parse(validRoute({
      mandatoryCapabilitiesCovered: false,
      coverageGapCapabilityKeys: ['legal_review'],
      humanReviewPoints: ['A human must review the legal terminology before delivery'],
    }))
    expect(route.humanReviewPoints).toHaveLength(1)
  })

  it('rejects an unavailable route with no stated reason', () => {
    expect(() => solutionRouteSchema.parse(validRoute({ status: 'unavailable', unavailableReason: undefined }))).toThrow()
  })

  it('accepts an unavailable route with a reason', () => {
    expect(solutionRouteSchema.parse(validRoute({ status: 'unavailable', unavailableReason: 'No viable human specialist found', mandatoryCapabilitiesCovered: false }))).toBeTruthy()
  })

  it('rejects a route with no evidence', () => {
    expect(() => solutionRouteSchema.parse(validRoute({ evidenceIds: [] }))).toThrow()
  })

  it('rejects an unsafe outbound URL on a component link (non-https)', () => {
    expect(() => solutionRouteSchema.parse(validRoute({
      components: [{ componentId: 'comp_1', componentVersion: 1, role: 'translator', coveredCapabilityKeys: ['translation'], link: 'http://example.com' }],
    }))).toThrow()
  })

  it('rejects an unsafe outbound URL on a component link (private network)', () => {
    expect(() => solutionRouteSchema.parse(validRoute({
      components: [{ componentId: 'comp_1', componentVersion: 1, role: 'translator', coveredCapabilityKeys: ['translation'], link: 'https://192.168.1.5/profile' }],
    }))).toThrow()
  })

  it('accepts a safe https outbound URL on a component link', () => {
    const route = solutionRouteSchema.parse(validRoute({
      components: [{ componentId: 'comp_1', componentVersion: 1, role: 'translator', coveredCapabilityKeys: ['translation'], link: 'https://example.com/profile' }],
    }))
    expect(route.components[0].link).toBe('https://example.com/profile')
  })

  it('rejects an estimate whose min exceeds its max', () => {
    expect(() => solutionRouteSchema.parse(validRoute({ estimate: { costMinCents: 5000, costMaxCents: 1000, currency: 'usd', timeMinHours: 1, timeMaxHours: 2 } }))).toThrow()
  })
})

describe('solutionRunSchema', () => {
  it('accepts a run with up to three routes', () => {
    const route = {
      routeType: 'human' as const,
      status: 'recommended' as const,
      summary: 's',
      fitExplanation: 'f',
      steps: ['a'],
      components: [{ componentId: 'c1', componentVersion: 1, role: 'r', coveredCapabilityKeys: ['k'] }],
      mandatoryCapabilitiesCovered: true,
      estimate: { costMinCents: 100, costMaxCents: 200, currency: 'usd', timeMinHours: 1, timeMaxHours: 2 },
      evidenceIds: ['ev1'],
    }
    const run = solutionRunSchema.parse({
      briefId: 'brief_1',
      rankingMode: 'recommended',
      retrievalQueryHash: 'hash1',
      routes: [route, { ...route, routeType: 'ai' }, { ...route, routeType: 'hybrid' }],
      modelVersion: 'minimax-m3-v1',
      promptVersion: 'interpret-v1',
    })
    expect(run.routes).toHaveLength(3)
  })

  it('rejects more than three routes', () => {
    const route = {
      routeType: 'human' as const,
      status: 'recommended' as const,
      summary: 's',
      fitExplanation: 'f',
      steps: ['a'],
      components: [{ componentId: 'c1', componentVersion: 1, role: 'r', coveredCapabilityKeys: ['k'] }],
      mandatoryCapabilitiesCovered: true,
      estimate: { costMinCents: 100, costMaxCents: 200, currency: 'usd', timeMinHours: 1, timeMaxHours: 2 },
      evidenceIds: ['ev1'],
    }
    expect(() => solutionRunSchema.parse({
      briefId: 'brief_1',
      rankingMode: 'recommended',
      retrievalQueryHash: 'hash1',
      routes: [route, route, route, route],
      modelVersion: 'v1',
      promptVersion: 'v1',
    })).toThrow()
  })
})
