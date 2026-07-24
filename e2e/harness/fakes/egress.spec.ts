/**
 * Wave 1 Task 4 — egress guard unit tests (Playwright-run, node-only).
 *
 * Proves the shim blocks every live third-party endpoint the codebase
 * knows about (Resend, Stripe, MiniMax) plus DNS-rebinding-style hosts,
 * while local traffic passes through and uninstall restores the original
 * `fetch` identity.
 */
import { test, expect } from 'playwright/test'
import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env' })

import { evaluateEgress, resolveAllowlist } from './_allowlist'
import { EgressBlockedError, installEgressGuard, isEgressGuardInstalled, uninstallEgressGuard } from './egress'

test.describe('install/uninstall', () => {
  test.afterEach(() => {
    uninstallEgressGuard()
  })

  test('install is refused outside E2E mode', () => {
    const previous = process.env.E2E_MODE
    process.env.E2E_MODE = 'false'
    try {
      expect(() => installEgressGuard()).toThrow(/E2E-only/)
      expect(isEgressGuardInstalled()).toBe(false)
    } finally {
      process.env.E2E_MODE = previous
    }
  })

  test('a second install is a safe no-op and uninstall restores the original fetch', () => {
    const original = globalThis.fetch
    installEgressGuard()
    const guarded = globalThis.fetch
    expect(guarded).not.toBe(original)

    installEgressGuard()
    expect(globalThis.fetch).toBe(guarded)

    uninstallEgressGuard()
    expect(globalThis.fetch).toBe(original)
    expect(isEgressGuardInstalled()).toBe(false)
  })
})

test.describe('blocking', () => {
  test.beforeAll(() => {
    installEgressGuard()
  })

  test.afterAll(() => {
    uninstallEgressGuard()
  })

  const blockedUrls = [
    'https://api.resend.com/emails',
    'https://api.stripe.com/v1/checkout/sessions',
    'https://api.minimax.io/v1/embeddings',
    'https://files.stripe.network/anything',
    'https://attacker.example.com/exfil', // DNS-rebinding-style host
  ]

  for (const url of blockedUrls) {
    test(`blocks ${new URL(url).hostname}`, async () => {
      const error = await fetch(url).then(
        () => null,
        (caught: unknown) => caught,
      )
      expect(error).toBeInstanceOf(EgressBlockedError)
      expect((error as EgressBlockedError).reason).toBe(`host: ${new URL(url).hostname}`)
    })
  }

  test('blocks the Postgres port even on an allowlisted host', async () => {
    const error = await fetch('http://127.0.0.1:5432/anything').then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(EgressBlockedError)
    expect((error as EgressBlockedError).reason).toBe('port: 5432')
  })

  test('local app traffic passes through', async ({ baseURL }) => {
    const response = await fetch(new URL('/api/health', baseURL ?? 'http://localhost:3130'))
    expect(response.ok).toBe(true)
  })
})

test.describe('allowlist policy (pure)', () => {
  test('is host-based, derived from DATABASE_MIGRATION_URL endpoint only', () => {
    const allowlist = resolveAllowlist('postgresql://user:secret@db.internal:6432/builderhunt')
    expect(allowlist.hosts.has('db.internal')).toBe(true)
    expect(allowlist.hosts.has('localhost')).toBe(true)
    expect(allowlist.hosts.has('127.0.0.1')).toBe(true)
    // The credentials never leak into the allowlist structure.
    expect(JSON.stringify([...allowlist.hosts])).not.toContain('secret')

    expect(evaluateEgress(new URL('http://db.internal:6432/x'), allowlist)).toEqual({ allowed: false, reason: 'port: 6432' })
    expect(evaluateEgress(new URL('http://db.internal:8080/x'), allowlist)).toEqual({ allowed: true })
    expect(evaluateEgress(new URL('https://api.resend.com/emails'), allowlist)).toEqual({ allowed: false, reason: 'host: api.resend.com' })
  })
})
