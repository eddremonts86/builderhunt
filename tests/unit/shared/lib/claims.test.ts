import { describe, expect, it } from 'vitest'
import { buildClaimInstructions, generateClaimChallenge, isClaimExpired } from '~/shared/lib/claims'

describe('generateClaimChallenge', () => {
  it('is prefixed and reasonably short (fits in a bio field)', () => {
    const challenge = generateClaimChallenge()
    expect(challenge).toMatch(/^bh-verify-[0-9a-f]{12}$/)
    expect(challenge.length).toBeLessThan(30)
  })

  it('is unique across calls', () => {
    const a = generateClaimChallenge()
    const b = generateClaimChallenge()
    expect(a).not.toBe(b)
  })
})

describe('isClaimExpired', () => {
  it('treats null as expired', () => {
    expect(isClaimExpired(null)).toBe(true)
  })

  it('treats a past date as expired', () => {
    expect(isClaimExpired(new Date(Date.now() - 1000))).toBe(true)
  })

  it('treats a future date as not expired', () => {
    expect(isClaimExpired(new Date(Date.now() + 60_000))).toBe(false)
  })
})

describe('buildClaimInstructions', () => {
  it('names the platform for known sources', () => {
    expect(buildClaimInstructions('github', 'bh-verify-abc')).toContain('GitHub')
    expect(buildClaimInstructions('gitlab', 'bh-verify-abc')).toContain('GitLab')
    expect(buildClaimInstructions('devto', 'bh-verify-abc')).toContain('DEV.to')
  })

  it('includes the literal challenge string', () => {
    expect(buildClaimInstructions('github', 'bh-verify-abc')).toContain('bh-verify-abc')
  })

  it('falls back to the raw source name if unrecognized', () => {
    expect(buildClaimInstructions('mystery', 'bh-verify-abc')).toContain('mystery')
  })
})
