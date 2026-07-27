import { describe, expect, it } from 'vitest'
import { capabilitiesEqual, hashCapability, issueCapability } from './capability'

describe('scheduling invitation capabilities (plan: calendar-scheduling-interview-intelligence, Phase 5)', () => {
  it('issues a 256-bit secret and a hash that is not the secret', () => {
    const { secret, hash } = issueCapability()
    // base64url of 32 bytes, unpadded.
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hash).not.toContain(secret)
    expect(secret).not.toContain(hash)
  })

  it('never issues the same secret twice', () => {
    const seen = new Set(Array.from({ length: 500 }, () => issueCapability().secret))
    expect(seen.size).toBe(500)
  })

  it('hashes deterministically, so a stored hash keeps matching across restarts', () => {
    const { secret, hash } = issueCapability()
    expect(hashCapability(secret)).toBe(hash)
    expect(hashCapability(secret)).toBe(hashCapability(secret))
  })

  it('maps different secrets to different hashes', () => {
    const a = issueCapability()
    const b = issueCapability()
    expect(hashCapability(a.secret)).not.toBe(hashCapability(b.secret))
  })

  it('is domain-separated: the raw sha256 of the secret is not the stored hash', async () => {
    // Guards against a future refactor "simplifying" the hash and silently making capabilities
    // from another subsystem collide with rows in scheduling_invitations.
    const { createHash } = await import('node:crypto')
    const { secret, hash } = issueCapability()
    expect(createHash('sha256').update(secret).digest('hex')).not.toBe(hash)
  })

  describe('strict mode — the input filter in front of the database', () => {
    it('accepts a secret we issued', () => {
      const { secret, hash } = issueCapability()
      expect(hashCapability(secret, { strict: true })).toBe(hash)
    })

    it.each([
      ['empty', ''],
      ['too short', 'abc'],
      ['too long', `${'a'.repeat(44)}`],
      ['base64 padding', `${'a'.repeat(42)}=`],
      ['standard base64 alphabet', `${'a'.repeat(42)}+`],
      ['sql-ish', "' or 1=1 --"],
      ['whitespace', ' '.repeat(43)],
    ])('rejects %s without hashing it', (_label, input) => {
      expect(hashCapability(input, { strict: true })).toBeNull()
    })

    it('rejects a hex hash presented as if it were a secret', () => {
      // Someone who reads a capability_hash out of a backup must not be able to replay it as the
      // secret: it is 64 chars, so the length filter alone stops it.
      const { hash } = issueCapability()
      expect(hashCapability(hash, { strict: true })).toBeNull()
    })
  })

  describe('capabilitiesEqual', () => {
    it('matches identical secrets and rejects different ones', () => {
      const { secret } = issueCapability()
      expect(capabilitiesEqual(secret, secret)).toBe(true)
      expect(capabilitiesEqual(secret, issueCapability().secret)).toBe(false)
    })

    it('rejects length mismatches without throwing', () => {
      // timingSafeEqual throws on unequal lengths; the guard must absorb that rather than turn a
      // malformed request into a 500.
      expect(capabilitiesEqual('short', issueCapability().secret)).toBe(false)
      expect(capabilitiesEqual('', '')).toBe(true)
    })
  })
})
