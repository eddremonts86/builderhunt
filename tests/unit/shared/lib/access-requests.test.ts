import { describe, expect, it } from 'vitest'

import {
  AccessNotAllowlistedError,
  checkSignupEmailGate,
  DisposableEmailRejectedError,
} from '~/shared/lib/abuse/email-hygiene'
import {
  generateInviteToken,
  hashInviteToken,
  inviteTokenMatches,
  isInviteExpired,
  isPlausibleEmail,
  normalizeAccessEmail,
} from '~/shared/lib/access-requests'

const SECRET = 'a-test-secret-with-more-than-32-characters'

describe('normalizeAccessEmail', () => {
  it('lowercases and trims, so the same person is one row', () => {
    expect(normalizeAccessEmail('  Edd@Example.COM ')).toBe('edd@example.com')
  })

  /**
   * The tempting "improvement" here is to strip dots and `+tag` suffixes the way Gmail treats them.
   * It must not: this table decides who gets in, and collapsing two addresses that a provider treats
   * as different people would *grant* access rather than restrict it. `a.b@x.com` approved would
   * silently admit `ab@x.com`.
   */
  it('does not collapse dots or plus-tags into the same identity', () => {
    expect(normalizeAccessEmail('a.b@x.com')).not.toBe(normalizeAccessEmail('ab@x.com'))
    expect(normalizeAccessEmail('a+beta@x.com')).not.toBe(normalizeAccessEmail('a@x.com'))
  })
})

describe('isPlausibleEmail', () => {
  it.each(['edd@example.com', 'a.b+c@sub.example.co.uk'])('accepts %s', (value) => {
    expect(isPlausibleEmail(value)).toBe(true)
  })

  it.each(['', 'no-at-sign', 'a@b', 'a@@b.com', 'spaces in@x.com', `${'x'.repeat(250)}@x.com`])(
    'rejects %s',
    (value) => {
      expect(isPlausibleEmail(value)).toBe(false)
    },
  )
})

describe('invite tokens', () => {
  it('mints a token with real entropy and never returns the same one twice', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => generateInviteToken()))
    expect(tokens.size).toBe(50)
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(40)
  })

  it('hashes deterministically under one secret, and differently under another', () => {
    const token = generateInviteToken()
    expect(hashInviteToken(token, SECRET)).toBe(hashInviteToken(token, SECRET))
    expect(hashInviteToken(token, SECRET)).not.toBe(hashInviteToken(token, `${SECRET}-other`))
  })

  it('the hash does not contain the token — it is what gets stored', () => {
    // The whole point: a database dump must not yield working invite links.
    const token = generateInviteToken()
    expect(hashInviteToken(token, SECRET)).not.toContain(token)
  })

  it('matches the right token and rejects a wrong one', () => {
    const token = generateInviteToken()
    const stored = hashInviteToken(token, SECRET)
    expect(inviteTokenMatches(token, stored, SECRET)).toBe(true)
    expect(inviteTokenMatches(generateInviteToken(), stored, SECRET)).toBe(false)
  })

  it('rejects a malformed stored hash instead of throwing', () => {
    // `timingSafeEqual` throws on a length mismatch; a truncated or garbage column value must read as
    // "does not match", not as a 500 on the sign-up route.
    const token = generateInviteToken()
    expect(inviteTokenMatches(token, 'abc', SECRET)).toBe(false)
    expect(inviteTokenMatches(token, '', SECRET)).toBe(false)
  })
})

describe('isInviteExpired', () => {
  it('treats a missing expiry as expired, not as forever', () => {
    // Fail-closed: a null expiry means the sweep cleared this invite, or it was never set.
    expect(isInviteExpired(null)).toBe(true)
  })

  it('is expired at and after the boundary, live before it', () => {
    expect(isInviteExpired(new Date(Date.now() - 1000))).toBe(true)
    expect(isInviteExpired(new Date(Date.now() + 60_000))).toBe(false)
  })
})

describe('checkSignupEmailGate — the invite gate', () => {
  const base = { email: 'stranger@example.com', blockDisposable: false }

  it('is a complete no-op when the gate is off', () => {
    // This is the state local dev and the e2e harness run in. If this ever throws, every fixture that
    // creates a user starts failing and it looks like a test bug rather than a config change.
    expect(() => checkSignupEmailGate({ ...base })).not.toThrow()
    expect(() => checkSignupEmailGate({ ...base, allowlistEnabled: false, emailAllowlisted: false })).not.toThrow()
  })

  it('refuses an email that is not allowlisted when the gate is on', () => {
    expect(() => checkSignupEmailGate({ ...base, allowlistEnabled: true, emailAllowlisted: false }))
      .toThrow(AccessNotAllowlistedError)
  })

  it('admits an allowlisted email', () => {
    expect(() => checkSignupEmailGate({ ...base, allowlistEnabled: true, emailAllowlisted: true })).not.toThrow()
  })

  it('says the same thing whatever the reason, so sign-up is not an oracle', () => {
    // Never-asked, pending and revoked all arrive as `emailAllowlisted: false`. Anyone could otherwise
    // discover which addresses have access by trying to register them.
    let message = ''
    try {
      checkSignupEmailGate({ ...base, allowlistEnabled: true, emailAllowlisted: false })
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/invite-only/i)
    expect(message).not.toMatch(/pending|revoked|already|unknown|not found/i)
  })

  it('reports a disposable address as disposable, not as un-allowlisted', () => {
    // Both are refusals but they mean different things to whoever reads the logs, so the order in
    // checkSignupEmailGate is deliberate.
    expect(() => checkSignupEmailGate({
      email: 'throwaway@mailinator.com',
      blockDisposable: true,
      allowlistEnabled: true,
      emailAllowlisted: false,
    })).toThrow(DisposableEmailRejectedError)
  })
})
