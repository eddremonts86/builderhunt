import { describe, expect, it } from 'vitest'
import { computeEvidenceContentHash } from '~/lib/enrichment/hash'

describe('computeEvidenceContentHash', () => {
  const base = {
    connector: 'github',
    sourceRecordId: 'gh-123',
    payload: { profileUrl: 'https://github.com/octocat', topics: ['webgl', 'rust'] },
  }

  it('is stable under key reordering', () => {
    const a = computeEvidenceContentHash(base)
    const b = computeEvidenceContentHash({
      payload: { topics: ['webgl', 'rust'], profileUrl: 'https://github.com/octocat' },
      sourceRecordId: 'gh-123',
      connector: 'github',
    })
    expect(a).toBe(b)
  })

  it('changes when the payload changes', () => {
    const a = computeEvidenceContentHash(base)
    const b = computeEvidenceContentHash({ ...base, payload: { ...base.payload, bio: 'new bio' } })
    expect(a).not.toBe(b)
  })

  it('changes when the connector changes', () => {
    const a = computeEvidenceContentHash(base)
    const b = computeEvidenceContentHash({ ...base, connector: 'user-submitted' })
    expect(a).not.toBe(b)
  })

  it('changes when the source record id changes', () => {
    const a = computeEvidenceContentHash(base)
    const b = computeEvidenceContentHash({ ...base, sourceRecordId: 'gh-456' })
    expect(a).not.toBe(b)
  })

  it('treats a missing sourceRecordId consistently (null, not undefined-shaped drift)', () => {
    const a = computeEvidenceContentHash({ connector: 'github', payload: base.payload })
    const b = computeEvidenceContentHash({ connector: 'github', sourceRecordId: null, payload: base.payload })
    expect(a).toBe(b)
  })

  it('is a 64-char hex sha256 digest', () => {
    expect(computeEvidenceContentHash(base)).toMatch(/^[0-9a-f]{64}$/)
  })
})
