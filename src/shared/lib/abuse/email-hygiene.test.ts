import { describe, expect, it } from 'vitest'
import {
  checkSignupEmailGate,
  DisposableEmailRejectedError,
  DISPOSABLE_EMAIL_DOMAINS,
  isDisposableEmailDomain,
  normalizeEmailForDuplicateDetection,
} from './email-hygiene'

describe('normalizeEmailForDuplicateDetection', () => {
  it.each([
    ['jane@example.com', 'jane@example.com'],
    ['Jane@Example.com', 'jane@example.com'],
    ['  jane@example.com  ', 'jane@example.com'],
    ['jane+newsletter@example.com', 'jane@example.com'],
    ['Jane+Sprint-Alerts@Example.COM', 'jane@example.com'],
    ['jane+a+b@example.com', 'jane@example.com'], // strips from the FIRST '+' onward
    ['jane.doe@example.com', 'jane.doe@example.com'], // dots are left alone (not Gmail-specific)
  ])('normalizeEmailForDuplicateDetection(%s) -> %s', (input, expected) => {
    expect(normalizeEmailForDuplicateDetection(input)).toBe(expected)
  })

  it('detects two plus-address variants as duplicates of the same normalized email', () => {
    expect(normalizeEmailForDuplicateDetection('jane+work@example.com'))
      .toBe(normalizeEmailForDuplicateDetection('jane+personal@example.com'))
  })

  it('returns a malformed email (no @) unchanged aside from trim/lowercase', () => {
    expect(normalizeEmailForDuplicateDetection('  NotAnEmail  ')).toBe('notanemail')
  })
})

describe('isDisposableEmailDomain', () => {
  it('has a non-trivial sampled list', () => {
    expect(DISPOSABLE_EMAIL_DOMAINS.size).toBeGreaterThan(20)
  })

  it.each([
    ['test@mailinator.com', true],
    ['test@MAILINATOR.COM', true], // case-insensitive
    ['test@guerrillamail.com', true],
    ['test@10minutemail.com', true],
    ['jane@example.com', false],
    ['jane@builderhunt.com', false],
  ])('isDisposableEmailDomain(%s) -> %s', (email, expected) => {
    expect(isDisposableEmailDomain(email)).toBe(expected)
  })

  it('never treats a malformed email (no @) as disposable', () => {
    expect(isDisposableEmailDomain('not-an-email')).toBe(false)
  })

  it('accepts a custom domain list override', () => {
    const customList = new Set(['onlythis.example'])
    expect(isDisposableEmailDomain('a@onlythis.example', customList)).toBe(true)
    expect(isDisposableEmailDomain('a@mailinator.com', customList)).toBe(false)
  })
})

describe('checkSignupEmailGate', () => {
  it('does not throw for a normal email regardless of the block flag', () => {
    expect(() => checkSignupEmailGate({ email: 'jane@example.com', blockDisposable: true })).not.toThrow()
    expect(() => checkSignupEmailGate({ email: 'jane@example.com', blockDisposable: false })).not.toThrow()
  })

  it('does not throw for a disposable email when blocking is off', () => {
    expect(() => checkSignupEmailGate({ email: 'test@mailinator.com', blockDisposable: false })).not.toThrow()
  })

  it('throws DisposableEmailRejectedError for a disposable email when blocking is on', () => {
    expect(() => checkSignupEmailGate({ email: 'test@mailinator.com', blockDisposable: true }))
      .toThrow(DisposableEmailRejectedError)
  })
})
