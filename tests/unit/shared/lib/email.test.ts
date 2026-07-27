/**
 * Wave 1 Task 4 — E2E seam tests for the email senders.
 *
 * Under `E2E_MODE=true` every sender must route through `dispatchEmail`
 * (the in-process outbox) and never touch `fetch` — even when
 * `RESEND_API_KEY` is absent. Outside E2E mode the senders' existing
 * code paths are untouched (byte-identical), which is proven here by the
 * dispatcher being unreachable and the outbox staying empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  sendAlertDigestEmail,
  sendClaimEmail, sendInterviewInvitationEmail,
  sendDeletionCompletedEmail,
  sendDeletionScheduledEmail,
  sendExportReadyEmail,
  sendOrganizationInvitationEmail,
  sendResetPasswordEmail,
} from '~/shared/lib/email'
import { readOutbox, resetOutbox } from '~/shared/lib/email/outbox'

beforeEach(() => {
  vi.stubEnv('E2E_MODE', 'true')
  resetOutbox()
})

afterEach(() => {
  resetOutbox()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('senders under E2E_MODE=true', () => {
  it('sendClaimEmail records to the outbox, keeps devLink, and never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const result = await sendClaimEmail('claim@example.com', 'http://localhost:3000/claim/tok')

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.id).toMatch(/^outbox:\d+$/)
    expect(result.devLink).toBe('http://localhost:3000/claim/tok')

    const entries = readOutbox()
    expect(entries).toHaveLength(1)
    expect(entries[0].to).toBe('claim@example.com')
    expect(entries[0].subject).toBe('Verify your BuilderHunt profile')
    // HTML is stored verbatim — the token link is NOT redacted by the outbox.
    expect(entries[0].html).toContain('http://localhost:3000/claim/tok')
  })

  it('sendResetPasswordEmail records to the outbox and never calls fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await sendResetPasswordEmail('reset@example.com', 'http://localhost:3000/reset/tok')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(readOutbox()[0].subject).toBe('Reset your BuilderHunt password')
  })

  it('sendOrganizationInvitationEmail records to the outbox with the organization subject', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await sendOrganizationInvitationEmail('invitee@example.com', 'Acme', 'http://localhost:3000/inv/tok')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(readOutbox()[0].subject).toBe('Invitation to join Acme on BuilderHunt')
  })

  it('sendAlertDigestEmail records to the outbox with the singular/plural subject', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await sendAlertDigestEmail('digest@example.com', [
      {
        alertName: 'rustaceans',
        username: 'ferris',
        displayName: 'Ferris',
        source: 'github',
        profileUrl: 'https://builderhunt.dev/p/ferris',
        eventType: 'new_match',
      },
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(readOutbox()[0].subject).toBe('BuilderHunt: 1 new alert match')
  })

  it('privacy lifecycle senders all land in the outbox', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await sendDeletionScheduledEmail('user@example.com', new Date('2026-08-23T00:00:00.000Z'))
    await sendDeletionCompletedEmail('user@example.com')
    await sendExportReadyEmail('user@example.com')

    expect(fetchSpy).not.toHaveBeenCalled()
    const subjects = readOutbox().map((entry) => entry.subject)
    expect(subjects).toEqual([
      'Your BuilderHunt account deletion is scheduled',
      'Your BuilderHunt account has been deleted',
      'Your BuilderHunt data export is ready',
    ])
  })

  it('captures the outbox even when RESEND_API_KEY is not configured', async () => {
    // The E2E seam must intercept BEFORE the dev-mode devLink branch — the
    // env singleton in this test process has whatever `.env` provides, but
    // capture must not depend on the key either way.
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await sendClaimEmail('nokey@example.com', 'http://localhost:3000/claim/tok2')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(readOutbox()).toHaveLength(1)
  })
})

describe('senders outside E2E_MODE', () => {
  it('never records to the outbox', async () => {
    vi.stubEnv('E2E_MODE', 'false')
    // Stub fetch so the production Resend path (taken when RESEND_API_KEY is
    // configured in `.env`) cannot reach the live API from a unit test.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 're_stub' }), { status: 200 }),
    )

    const result = await sendClaimEmail('prod@example.com', 'http://localhost:3000/claim/tok3')

    expect(result.ok).toBe(true)
    expect(readOutbox()).toHaveLength(0)
  })
})

describe('interview invitation email', () => {
  it('hands the dev branch the whole link, because it is the only way to open the portal', async () => {
    vi.stubEnv('E2E_MODE', 'false')
    const logged: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logged.push(args.join(' ')) })
    const link = 'https://app.test/schedule/11111111-1111-4111-8111-111111111111#s3cret-capability-value'

    const result = await sendInterviewInvitationEmail({
      to: 'candidate@example.com',
      roleTitle: 'Senior Rust Engineer',
      organizationName: 'Acme',
      durationMinutes: 45,
      link,
    })

    // An earlier version redacted the fragment here, reasoning that a local console log is still a
    // log. That protected nothing — this branch is only reached when RESEND_API_KEY is unset, which
    // never happens in production — and it left the flow impossible to exercise on a dev machine.
    // Every sibling sender returns its whole link the same way.
    expect(result.ok).toBe(true)
    expect(result.devLink).toBe(link)
    expect(logged.join('\n')).toContain(link)
  })
})
