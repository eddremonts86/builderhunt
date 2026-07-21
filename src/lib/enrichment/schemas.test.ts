import { describe, expect, it } from 'vitest'
import { containsProhibitedContent, EnrichmentEvidencePayloadSchema, EvidenceRefreshBody, EvidenceReviewBody } from './schemas'

describe('EvidenceRefreshBody', () => {
  it('accepts a valid minimal body', () => {
    const result = EvidenceRefreshBody.safeParse({ connectors: ['github'] })
    expect(result.success).toBe(true)
  })

  it('rejects an empty connectors array', () => {
    expect(EvidenceRefreshBody.safeParse({ connectors: [] }).success).toBe(false)
  })

  it('rejects more than 10 connectors', () => {
    const connectors = Array.from({ length: 11 }, (_, i) => `connector-${i}`)
    expect(EvidenceRefreshBody.safeParse({ connectors }).success).toBe(false)
  })

  it('rejects duplicate connector ids (case-insensitive)', () => {
    const result = EvidenceRefreshBody.safeParse({ connectors: ['github', 'GitHub'] })
    expect(result.success).toBe(false)
  })

  it('rejects more than 10 submitted URLs', () => {
    const submittedUrls = Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`)
    expect(EvidenceRefreshBody.safeParse({ connectors: ['github'], submittedUrls }).success).toBe(false)
  })

  it('rejects a non-URL submitted string', () => {
    const result = EvidenceRefreshBody.safeParse({ connectors: ['github'], submittedUrls: ['not a url'] })
    expect(result.success).toBe(false)
  })
})

describe('EvidenceReviewBody', () => {
  it.each(['accepted', 'rejected'])('accepts %s', (resolution) => {
    expect(EvidenceReviewBody.safeParse({ resolution }).success).toBe(true)
  })

  it('rejects an arbitrary resolution value', () => {
    expect(EvidenceReviewBody.safeParse({ resolution: 'maybe' }).success).toBe(false)
  })
})

describe('EnrichmentEvidencePayloadSchema', () => {
  it('accepts a clean minimal fixture', () => {
    const result = EnrichmentEvidencePayloadSchema.safeParse({
      profileUrl: 'https://github.com/octocat',
      topics: ['webgl'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects an unknown field (e.g. email) — .strict() structural block', () => {
    const result = EnrichmentEvidencePayloadSchema.safeParse({
      profileUrl: 'https://github.com/octocat',
      topics: [],
      email: 'someone@example.com',
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown field (e.g. phone)', () => {
    const result = EnrichmentEvidencePayloadSchema.safeParse({
      profileUrl: 'https://github.com/octocat',
      topics: [],
      phone: '+1 555 0100',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-URL profileUrl', () => {
    const result = EnrichmentEvidencePayloadSchema.safeParse({ profileUrl: 'not-a-url', topics: [] })
    expect(result.success).toBe(false)
  })

  it('rejects an oversized bio', () => {
    const result = EnrichmentEvidencePayloadSchema.safeParse({
      profileUrl: 'https://github.com/octocat',
      topics: [],
      bio: 'x'.repeat(2001),
    })
    expect(result.success).toBe(false)
  })

  it('rejects more than 20 topics', () => {
    const result = EnrichmentEvidencePayloadSchema.safeParse({
      profileUrl: 'https://github.com/octocat',
      topics: Array.from({ length: 21 }, (_, i) => `topic-${i}`),
    })
    expect(result.success).toBe(false)
  })
})

describe('containsProhibitedContent', () => {
  it('flags an email address hidden in an allowed free-text field', () => {
    expect(containsProhibitedContent({ bio: 'reach me at someone@example.com' })).toBe(true)
  })

  it('flags a phone-shaped string', () => {
    expect(containsProhibitedContent({ headline: 'call +1 555 010 0199' })).toBe(true)
  })

  it('allows clean free text', () => {
    expect(containsProhibitedContent({ bio: 'I build tools for developers' })).toBe(false)
  })

  it('scans array fields (e.g. topics) too', () => {
    expect(containsProhibitedContent({ topics: ['rust', 'contact someone@example.com'] })).toBe(true)
  })
})
