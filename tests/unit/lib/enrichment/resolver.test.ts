import { describe, expect, it } from 'vitest'
import { RESOLVER_VERSION, resolveEnrichmentCandidate, type ResolverInput } from '~/lib/enrichment/resolver'
import type { EnrichmentTarget } from '~/lib/enrichment/types'

const target: EnrichmentTarget = {
  builderIdentityId: 'identity-1',
  source: 'github',
  sourceId: 'gh-123',
  username: 'octocat',
  displayName: 'Ada Lovelace',
  profileUrl: 'https://github.com/octocat',
  knownOrganization: 'Acme Corp',
  knownLocation: 'Berlin, Germany',
  submittedUrls: [],
}

function baseInput(overrides: Partial<ResolverInput> = {}): ResolverInput {
  return {
    target,
    candidate: { profileUrl: 'https://github.com/octocat', topics: [] },
    ...overrides,
  }
}

describe('resolveEnrichmentCandidate — thresholds', () => {
  it('exact stable source ID alone (10000 bps, 1 signal) lands in review, not accepted', () => {
    const result = resolveEnrichmentCandidate(baseInput({ candidateSourceRecordId: 'gh-123' }))
    expect(result.confidenceBps).toBe(10000)
    expect(result.matchSignals).toEqual(['exact_stable_source_id'])
    expect(result.resolution).toBe('review')
  })

  it('exact stable source ID + exact username (2 independent signals) accepts', () => {
    const result = resolveEnrichmentCandidate(baseInput({
      candidateSourceRecordId: 'gh-123',
      candidate: { profileUrl: 'https://github.com/octocat', username: 'octocat', topics: [] },
    }))
    expect(result.confidenceBps).toBe(10000)
    expect(result.matchSignals.length).toBeGreaterThanOrEqual(2)
    expect(result.resolution).toBe('accepted')
  })

  it('verified-owner-submitted alone (10000 bps, 1 signal) auto-accepts (spec §5.3 exception)', () => {
    const result = resolveEnrichmentCandidate(baseInput({ isVerifiedOwnerSubmitted: true }))
    expect(result.confidenceBps).toBe(10000)
    expect(result.matchSignals).toEqual(['verified_owner_cross_link'])
    expect(result.resolution).toBe('accepted')
  })

  it('exact username without reciprocal link (4000 bps) is below review threshold alone', () => {
    const result = resolveEnrichmentCandidate(baseInput({
      candidate: { profileUrl: 'https://github.com/octocat', username: 'octocat', topics: [] },
    }))
    expect(result.confidenceBps).toBe(4000)
    expect(result.resolution).toBe('rejected')
  })

  it('exact username + reciprocal link (9500) is below 2-signal accept, lands in review', () => {
    const result = resolveEnrichmentCandidate(baseInput({
      hasReciprocalLink: true,
      candidate: { profileUrl: 'https://github.com/octocat', username: 'octocat', topics: [] },
    }))
    expect(result.confidenceBps).toBe(9500)
    expect(result.matchSignals).toEqual(['exact_username_reciprocal_link'])
    expect(result.resolution).toBe('review')
  })

  it('reciprocal-link username + full name + org (>= 9000, 3 signals) accepts', () => {
    const result = resolveEnrichmentCandidate(baseInput({
      hasReciprocalLink: true,
      candidate: {
        profileUrl: 'https://github.com/octocat',
        username: 'octocat',
        displayName: 'Ada Lovelace',
        organization: 'Acme Corp',
        topics: [],
      },
    }))
    expect(result.confidenceBps).toBe(10000) // capped at MAX_BPS
    expect(result.matchSignals.length).toBeGreaterThanOrEqual(2)
    expect(result.resolution).toBe('accepted')
  })

  it('organization + location agreement (3000 bps) rejects — below review threshold', () => {
    const result = resolveEnrichmentCandidate(baseInput({
      candidate: {
        profileUrl: 'https://github.com/octocat',
        organization: 'Acme Corp',
        location: 'Berlin, Germany',
        topics: [],
      },
    }))
    expect(result.confidenceBps).toBe(3000)
    expect(result.resolution).toBe('rejected')
  })

  it('no signals at all (0 bps) rejects', () => {
    const result = resolveEnrichmentCandidate(baseInput())
    expect(result.confidenceBps).toBe(0)
    expect(result.matchSignals).toEqual([])
    expect(result.resolution).toBe('rejected')
  })
})

describe('resolveEnrichmentCandidate — contradictions', () => {
  it('a conflicting stable source ID forces rejection regardless of score', () => {
    const result = resolveEnrichmentCandidate(baseInput({
      isVerifiedOwnerSubmitted: true,
      contradictsStableId: true,
    }))
    expect(result.resolution).toBe('rejected')
    expect(result.contradictions).toContain('conflicting_stable_source_id')
  })

  it('a verified-owner rejection forces rejection regardless of score', () => {
    const result = resolveEnrichmentCandidate(baseInput({
      candidateSourceRecordId: 'gh-123',
      verifiedOwnerRejected: true,
    }))
    expect(result.resolution).toBe('rejected')
    expect(result.contradictions).toContain('verified_owner_rejected')
  })

  it('materially different name + different org caps the score at 6900', () => {
    const result = resolveEnrichmentCandidate(baseInput({
      isVerifiedOwnerSubmitted: true,
      candidate: {
        profileUrl: 'https://github.com/octocat',
        displayName: 'Someone Else',
        organization: 'Other Company',
        topics: [],
      },
    }))
    expect(result.confidenceBps).toBeLessThanOrEqual(6900)
    expect(result.contradictions).toContain('name_and_organization_mismatch')
  })

  it('missing candidate data never contributes agreement (no name/org present -> no contradiction, no signal)', () => {
    const result = resolveEnrichmentCandidate(baseInput({
      candidate: { profileUrl: 'https://github.com/octocat', topics: [] },
    }))
    expect(result.scoreComponents.exact_full_name).toBeUndefined()
    expect(result.scoreComponents.organization_agreement).toBeUndefined()
    expect(result.contradictions).toEqual([])
  })
})

describe('resolveEnrichmentCandidate — determinism and versioning', () => {
  it('is deterministic: identical input produces identical output', () => {
    const input = baseInput({ candidateSourceRecordId: 'gh-123', hasReciprocalLink: true })
    const a = resolveEnrichmentCandidate(input)
    const b = resolveEnrichmentCandidate(input)
    expect(a).toEqual(b)
  })

  it('stamps the current resolver version', () => {
    const result = resolveEnrichmentCandidate(baseInput())
    expect(result.resolverVersion).toBe(RESOLVER_VERSION)
  })
})
