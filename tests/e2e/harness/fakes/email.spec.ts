/**
 * Wave 1 Task 4 — email fake unit tests (Playwright-run, node-only; the
 * Vitest include globs cover `src/**`/`test/**` only, so unit-style specs
 * under `e2e/` run under the Playwright runner, same as isolation.spec.ts).
 */
import { test, expect } from 'playwright/test'
import { loadHarnessEnv } from '../load-env'

loadHarnessEnv()

import {
  installEmailFake,
  isEmailFakeInstalled,
  readOutbox,
  resetEmailFake,
  uninstallEmailFake,
} from './email'

test.beforeEach(() => {
  if (!isEmailFakeInstalled()) installEmailFake()
  resetEmailFake()
})

test.afterAll(() => {
  uninstallEmailFake()
})

test.describe('install semantics', () => {
  test('a second install without uninstall is rejected', () => {
    expect(() => installEmailFake()).toThrow(/already installed/)
  })

  test('install is refused outside E2E mode', () => {
    uninstallEmailFake()
    const previous = process.env.E2E_MODE
    process.env.E2E_MODE = 'false'
    try {
      expect(() => installEmailFake()).toThrow(/E2E-only/)
    } finally {
      process.env.E2E_MODE = previous
      installEmailFake()
    }
  })
})

test.describe('capture', () => {
  test('multi-send capture preserves order and sequence', async () => {
    const email = await import('../../../../src/shared/lib/email')

    const first = await email.sendClaimEmail('one@example.com', 'http://localhost:3000/claim/1')
    const second = await email.sendResetPasswordEmail('two@example.com', 'http://localhost:3000/reset/2')
    const third = await email.sendOrganizationInvitationEmail('three@example.com', 'Acme', 'http://localhost:3000/inv/3')

    expect(first.id).toBe('outbox:1')
    expect(second.id).toBe('outbox:2')
    expect(third.id).toBe('outbox:3')

    const entries = readOutbox()
    expect(entries.map((entry) => entry.to)).toEqual(['one@example.com', 'two@example.com', 'three@example.com'])
    expect(entries.map((entry) => entry.subject)).toEqual([
      'Verify your BuilderHunt profile',
      'Reset your BuilderHunt password',
      'Invitation to join Acme on BuilderHunt',
    ])
    // Capture timing is recorded and monotonic non-decreasing.
    const times = entries.map((entry) => Date.parse(entry.sentAt))
    expect(times.every((time) => Number.isFinite(time))).toBe(true)
    expect(times[0]).toBeLessThanOrEqual(times[1])
    expect(times[1]).toBeLessThanOrEqual(times[2])
  })

  test('capture never touches fetch — works with or without RESEND_API_KEY', async () => {
    const email = await import('../../../../src/shared/lib/email')
    const realFetch = globalThis.fetch
    const forbiddenFetch: typeof fetch = () => {
      throw new Error('fetch must not be called while the email fake is installed')
    }
    Object.defineProperty(globalThis, 'fetch', { value: forbiddenFetch, configurable: true, writable: true })
    try {
      const result = await email.sendClaimEmail('nofetch@example.com', 'http://localhost:3000/claim/nf')
      expect(result.ok).toBe(true)
      expect(readOutbox()).toHaveLength(1)
    } finally {
      Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true })
    }
  })

  test('reset empties the outbox and restarts the sequence', async () => {
    const email = await import('../../../../src/shared/lib/email')
    await email.sendExportReadyEmail('reset@example.com')
    expect(readOutbox()).toHaveLength(1)

    resetEmailFake()
    expect(readOutbox()).toHaveLength(0)

    const next = await email.sendDeletionCompletedEmail('reset@example.com')
    expect(next.id).toBe('outbox:1')
  })

  test('dispatchEmail is unreachable outside E2E mode', async () => {
    const email = await import('../../../../src/shared/lib/email')
    const previous = process.env.E2E_MODE
    process.env.E2E_MODE = 'false'
    try {
      await expect(email.dispatchEmail({ to: 'x@example.com', subject: 'S', html: '<p></p>' })).rejects.toThrow(/E2E-only/)
    } finally {
      process.env.E2E_MODE = previous
    }
    expect(readOutbox()).toHaveLength(0)
  })
})
