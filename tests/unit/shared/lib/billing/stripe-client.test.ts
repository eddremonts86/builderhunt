import { describe, expect, it } from 'vitest'
import Stripe from 'stripe'
import { env } from '~/shared/lib/env'
import {
  idempotencyKeyFor,
  isAllowedReturnUrl,
  redactStripeError,
  resolveStripeClientConfig,
  StripeBillingDisabledError,
} from '~/shared/lib/billing/stripe-client'

const validInput = {
  billingEnabled: 'true',
  secretKey: 'sk_test_abc123',
  apiVersion: '2025-01-01.acacia',
}

describe('resolveStripeClientConfig', () => {
  it('resolves a valid test-mode configuration', () => {
    const config = resolveStripeClientConfig(validInput)
    expect(config).toEqual({ secretKey: 'sk_test_abc123', apiVersion: '2025-01-01.acacia', live: false })
  })

  it('flags a live secret key as live mode', () => {
    const config = resolveStripeClientConfig({ ...validInput, secretKey: 'sk_live_abc123' })
    expect(config.live).toBe(true)
  })

  it('fails closed when billing is disabled', () => {
    expect(() => resolveStripeClientConfig({ ...validInput, billingEnabled: 'false' })).toThrow(StripeBillingDisabledError)
  })

  it('fails closed when the secret key is missing', () => {
    expect(() => resolveStripeClientConfig({ ...validInput, secretKey: undefined })).toThrow(StripeBillingDisabledError)
  })

  it('fails closed when the secret key is malformed', () => {
    expect(() => resolveStripeClientConfig({ ...validInput, secretKey: 'not-a-real-key' })).toThrow(StripeBillingDisabledError)
  })

  it('fails closed when the API version is missing', () => {
    expect(() => resolveStripeClientConfig({ ...validInput, apiVersion: undefined })).toThrow(StripeBillingDisabledError)
  })

  // Mixed test/live-mode rejection (a live key outside NODE_ENV=production)
  // is enforced in src/shared/lib/env.ts's zod schema instead of here — that
  // check runs once at process start and prevents the app from booting at
  // all, a stronger guarantee than a per-call check in this module could give.
})

describe('redactStripeError', () => {
  it('extracts only safe fields from a Stripe error', () => {
    const error = new Stripe.errors.StripeCardError({
      type: 'card_error',
      message: 'Your card was declined.',
      code: 'card_declined',
      requestId: 'req_123',
    } as never)
    expect(redactStripeError(error)).toEqual({
      message: 'Your card was declined.',
      type: 'card_error',
      code: 'card_declined',
      requestId: 'req_123',
    })
  })

  it('falls back to a generic message for a non-Stripe error', () => {
    expect(redactStripeError(new Error('boom'))).toEqual({ message: 'boom' })
    expect(redactStripeError('not an error')).toEqual({ message: 'Unknown Stripe error' })
  })
})

describe('isAllowedReturnUrl', () => {
  it('accepts a URL on this app\'s own origin', () => {
    expect(isAllowedReturnUrl(`${env.APP_URL}/settings/billing`)).toBe(true)
    expect(isAllowedReturnUrl(env.APP_URL)).toBe(true)
  })

  it('rejects a completely different origin', () => {
    expect(isAllowedReturnUrl('https://evil.example.com/steal')).toBe(false)
  })

  it('rejects a lookalike host that merely starts with our own (open-redirect via prefix match)', () => {
    const appOrigin = new URL(env.APP_URL)
    expect(isAllowedReturnUrl(`${appOrigin.protocol}//${appOrigin.host}.evil.com/x`)).toBe(false)
  })

  it('rejects a same-host URL on the wrong port or protocol', () => {
    const appOrigin = new URL(env.APP_URL)
    expect(isAllowedReturnUrl(`${appOrigin.protocol}//${appOrigin.hostname}:9999/x`)).toBe(false)
    expect(isAllowedReturnUrl(`http://${appOrigin.host}/x`)).toBe(appOrigin.protocol === 'http:')
  })

  it('rejects an unparseable URL rather than throwing', () => {
    expect(isAllowedReturnUrl('not a url at all')).toBe(false)
    expect(isAllowedReturnUrl('')).toBe(false)
  })

  it('rejects a userinfo-smuggling URL (https://app.test@evil.com) — the origin, not the string, decides', () => {
    const appOrigin = new URL(env.APP_URL)
    expect(isAllowedReturnUrl(`${appOrigin.protocol}//${appOrigin.host}@evil.com/x`)).toBe(false)
  })
})

describe('idempotencyKeyFor', () => {
  it('joins non-empty parts with a colon', () => {
    expect(idempotencyKeyFor('org-a', 'checkout', 'attempt-1')).toBe('org-a:checkout:attempt-1')
  })

  it('drops empty parts', () => {
    expect(idempotencyKeyFor('org-a', '', 'checkout')).toBe('org-a:checkout')
  })
})
