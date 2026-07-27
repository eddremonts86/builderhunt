/**
 * The invitation email's production (Resend) path.
 *
 * A separate file because `env` is validated once at import and `vi.mock` is per-file: stubbing
 * `process.env.RESEND_API_KEY` does nothing, so forcing the Resend branch means replacing the env
 * module, and `email.test.ts` needs the real one for its dev-branch assertions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('~/shared/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/env')>()
  return { ...actual, env: { ...actual.env, RESEND_API_KEY: 're_test_key' } }
})

const { sendInterviewInvitationEmail } = await import('~/shared/lib/email')

const LINK = 'https://app.test/schedule/11111111-1111-4111-8111-111111111111#s3cret-capability-value'
const base = {
  to: 'candidate@example.com',
  roleTitle: 'Senior Rust Engineer',
  organizationName: 'Acme',
  durationMinutes: 45,
  link: LINK,
}

function captureResend(status = 200) {
  const captured: { body: Record<string, unknown> } = { body: {} }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    captured.body = JSON.parse(String((init as RequestInit).body))
    return status === 200
      ? new Response(JSON.stringify({ id: 're_stub' }), { status: 200 })
      : new Response('rate limited', { status })
  })
  return captured
}

describe('invitation email, Resend path', () => {
  beforeEach(() => {
    vi.stubEnv('E2E_MODE', 'false')
    vi.restoreAllMocks()
  })

  it('carries the secret only in the fragment, with no tracking parameters', async () => {
    const captured = captureResend()

    const result = await sendInterviewInvitationEmail(base)

    expect(result.ok).toBe(true)
    const html = String(captured.body.html)
    expect(html).toContain(LINK)
    // A click tracker would rewrite this through a third party, handing them the capability.
    expect(html).not.toMatch(/[?&](utm_|ref=|click|track)/i)
    // Everything before the '#' is what a server or a Referer header can see.
    expect(LINK.split('#')[0]).not.toContain('s3cret-capability-value')
  })

  it('escapes a role title that carries markup', async () => {
    const captured = captureResend()

    await sendInterviewInvitationEmail({ ...base, roleTitle: '<img src=x onerror=alert(1)>' })

    const html = String(captured.body.html)
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('tells the candidate the link cannot be resent', async () => {
    const captured = captureResend()

    await sendInterviewInvitationEmail(base)

    // The organizer cannot re-emit it, so the email has to say so — otherwise a candidate who
    // deletes it waits for a resend that will never arrive.
    expect(String(captured.body.html)).toMatch(/cannot be sent to you again/i)
  })

  it('reports a provider failure instead of claiming success', async () => {
    captureResend(429)

    const result = await sendInterviewInvitationEmail(base)

    // The send route turns this into a rollback. A false success would commit a `sent` invitation
    // that nobody was ever emailed.
    expect(result.ok).toBe(false)
    expect(result.error).toContain('429')
  })
})
