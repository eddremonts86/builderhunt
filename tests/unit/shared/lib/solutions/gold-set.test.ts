/**
 * The gold set's shape and its scoring (plan 43 Phase 0).
 *
 * The evaluator itself needs a database and the whole pipeline; this file tests the part that decides what the
 * numbers *mean*, which is where a wrong answer would be least visible — a scorer that quietly averaged an
 * exclusion violation, or blended the two authorship populations, would produce a report that looks fine.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  goldSetFileSchema,
  interval,
  isCitableAsQualityGate,
  percentile,
  scoreBrief,
  summarize,
  type GoldBrief,
  type GoldScore,
} from '~/shared/lib/solutions/gold-set'

const file = goldSetFileSchema.parse(JSON.parse(readFileSync('tests/fixtures/solutions/gold-set.json', 'utf8')))

const brief = (overrides: Partial<GoldBrief['expected']> = {}): GoldBrief => ({
  id: 'b1',
  authorship: 'synthetic',
  briefText: 'Translate 200 pages into German',
  expected: {
    domain: 'translation_and_transcription',
    capabilityKeys: ['translation'],
    offerableLanes: ['human', 'ai', 'hybrid'],
    hardConstraints: [{ type: 'max_budget', maxCents: 500_000, currency: 'EUR' }],
    unacceptableComponentKinds: [],
    rankingMode: 'recommended',
    ...overrides,
  },
})

const observation = (overrides: Record<string, unknown> = {}) => ({
  briefId: 'b1',
  interpretedCapabilityKeys: ['translation'],
  interpretedDomain: 'translation_and_transcription',
  offeredLanes: ['human', 'ai', 'hybrid'],
  keptConstraintTypes: ['max_budget'],
  componentKinds: ['deepl-pro'],
  latencyMs: 10,
  providerCalls: 1,
  ...overrides,
})

describe('the seeded gold set', () => {
  it('has 60 briefs, every one marked synthetic', () => {
    // tasks.md asks for 60, and the authorship marking is what keeps a seeded record from ever being cited as a
    // human judgment.
    expect(file.briefs).toHaveLength(60)
    expect(file.briefs.every((entry) => entry.authorship === 'synthetic')).toBe(true)
  })

  it('has unique ids and covers every brief domain', () => {
    expect(new Set(file.briefs.map((entry) => entry.id)).size).toBe(60)
    const domains = new Set(file.briefs.map((entry) => entry.expected.domain))
    // A corpus that only exercised one domain would score the product on a slice of it.
    expect(domains.size).toBeGreaterThanOrEqual(4)
  })

  it('exercises the dimensions the plan names', () => {
    // "valid lanes, hard constraints, capability coverage, unacceptable components, and ranking".
    expect(file.briefs.some((entry) => entry.expected.hardConstraints.some((c) => c.type === 'max_budget'))).toBe(true)
    expect(file.briefs.some((entry) => entry.expected.hardConstraints.some((c) => c.type === 'deadline_by'))).toBe(true)
    expect(file.briefs.some((entry) => entry.expected.hardConstraints.some((c) => c.type === 'max_data_sensitivity'))).toBe(true)
    expect(file.briefs.some((entry) => entry.expected.unacceptableComponentKinds.length > 0)).toBe(true)
    expect(new Set(file.briefs.map((entry) => entry.expected.rankingMode)).size).toBe(3)
    expect(file.briefs.some((entry) => entry.expected.capabilityKeys.length > 1)).toBe(true)
  })

  it('carries no personal data', () => {
    /**
     * The evaluator is meant to "fail on malformed or leaked personal data". The corpus is generated from
     * templates precisely so there is none to leak, and this is the assertion that keeps it that way when
     * someone adds a brief by hand.
     */
    const text = file.briefs.map((entry) => entry.briefText).join('\n')
    expect(text).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i)
    // A phone number is an international prefix or a long unbroken run of digits. The obvious loose pattern —
    // digits with separators — flagged every ISO deadline in the corpus, which is the kind of check that gets
    // deleted rather than fixed.
    expect(text).not.toMatch(/\+\d{6,}/)
    expect(text).not.toMatch(/\d{9,}/)
    expect(text).not.toMatch(/https?:\/\//)
  })

  it('states in the file that a synthetic score is not a quality measurement', () => {
    // The caveat travels with the data. A consumer that reads the JSON and not the docs still sees it.
    expect(file.authorshipNote).toMatch(/proves nothing about quality/i)
  })
})

describe('scoreBrief', () => {
  it('scores a perfect run at 1 across the board', () => {
    const score = scoreBrief(brief(), observation())
    expect(score).toMatchObject({
      capabilityRecall: 1, domainCorrect: true, laneRecall: 1, constraintRetention: 1, respectedExclusions: true,
    })
  })

  it('measures recall, not precision, on capabilities', () => {
    // An interpretation that found the required capability *and* two others has not failed the brief: extra
    // capabilities widen retrieval rather than breaking it. Precision would punish a reasonable reading.
    const score = scoreBrief(brief(), observation({ interpretedCapabilityKeys: ['translation', 'summarization'] }))
    expect(score.capabilityRecall).toBe(1)
  })

  it('penalises a dropped constraint', () => {
    /**
     * The metric that matters most. A `max_budget` the interpretation silently discarded means every route was
     * composed without it — the user's limit stopped applying and nothing said so.
     */
    const score = scoreBrief(brief(), observation({ keptConstraintTypes: [] }))
    expect(score.constraintRetention).toBe(0)
  })

  it('fails a brief outright when an excluded component appears', () => {
    // Not a fraction: averaging would let a recommender that surfaced a job posting in one route out of sixty
    // still look 98% clean.
    const score = scoreBrief(
      brief({ unacceptableComponentKinds: ['human_role:jobindex'] }),
      observation({ componentKinds: ['human_role'] }),
    )
    expect(score.respectedExclusions).toBe(false)
  })

  it('treats an empty expectation as satisfied', () => {
    const score = scoreBrief(brief({ hardConstraints: [] }), observation({ keptConstraintTypes: [] }))
    expect(score.constraintRetention).toBe(1)
  })

  it('gives no credit for a lane that was not offered', () => {
    const score = scoreBrief(brief(), observation({ offeredLanes: ['human'] }))
    expect(score.laneRecall).toBeCloseTo(1 / 3, 6)
  })
})

describe('summarize', () => {
  const scores: GoldScore[] = [
    { briefId: 'a', authorship: 'synthetic', capabilityRecall: 1, domainCorrect: true, laneRecall: 1, constraintRetention: 1, respectedExclusions: true, latencyMs: 10, providerCalls: 1 },
    { briefId: 'b', authorship: 'synthetic', capabilityRecall: 0, domainCorrect: false, laneRecall: 0.5, constraintRetention: 0, respectedExclusions: false, latencyMs: 30, providerCalls: 2 },
    { briefId: 'c', authorship: 'human', capabilityRecall: 1, domainCorrect: true, laneRecall: 1, constraintRetention: 1, respectedExclusions: true, latencyMs: 20, providerCalls: 1 },
  ]

  it('never blends the two populations', () => {
    /**
     * The rule the whole authorship split exists for. A single mean over synthetic and human records would be
     * quoted as "quality", and the synthetic half of it is circular — the generator and the grader share
     * assumptions.
     */
    const synthetic = summarize(scores, 'synthetic')!
    const human = summarize(scores, 'human')!
    expect(synthetic.count).toBe(2)
    expect(human.count).toBe(1)
    expect(synthetic.capabilityRecall.mean).toBe(0.5)
    expect(human.capabilityRecall.mean).toBe(1)
  })

  it('returns null for a population with no records', () => {
    expect(summarize(scores.filter((s) => s.authorship === 'synthetic'), 'human')).toBeNull()
  })

  it('counts exclusion failures rather than averaging them', () => {
    expect(summarize(scores, 'synthetic')!.exclusionFailures).toBe(1)
  })

  it('reports a wider interval for a smaller sample', () => {
    // So a 12-brief segment is visibly less certain than a 60-brief one rather than looking equally precise.
    const few = interval([0, 1])
    const many = interval([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1])
    expect(few.halfWidth).toBeGreaterThan(many.halfWidth)
  })

  it('reports a p95 that some run actually had', () => {
    // Nearest-rank, not interpolated: an interpolated p95 is a latency nobody observed.
    expect(percentile([5, 10, 20, 40], 0.95)).toBe(40)
    expect(percentile([5, 10, 20, 40], 0.5)).toBe(10)
  })
})

describe('isCitableAsQualityGate', () => {
  it('refuses a synthetic-only report', () => {
    // tasks.md: only human-authored judgments may be cited as a quality gate.
    expect(isCitableAsQualityGate([summarize([
      { briefId: 'a', authorship: 'synthetic', capabilityRecall: 1, domainCorrect: true, laneRecall: 1, constraintRetention: 1, respectedExclusions: true, latencyMs: 1, providerCalls: 0 },
    ], 'synthetic'), null])).toBe(false)
  })

  it('accepts a report that includes human judgments', () => {
    expect(isCitableAsQualityGate([null, summarize([
      { briefId: 'c', authorship: 'human', capabilityRecall: 1, domainCorrect: true, laneRecall: 1, constraintRetention: 1, respectedExclusions: true, latencyMs: 1, providerCalls: 0 },
    ], 'human')])).toBe(true)
  })
})
