import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sendOrganizationInvitationEmail } from '~/shared/lib/email'
import { readOutbox, resetOutbox } from '~/shared/lib/email/outbox'
import {
  INVITATION_INTENT_EMAIL_LEAD,
  INVITATION_INTENTS,
} from '~/shared/lib/organizations/invitation-personalization'

/**
 * Plan 59, task 9 — the personalized invitation email.
 *
 * Goes through the real sender, using the E2E outbox seam rather than a mock, so the assertions are
 * against the HTML a recipient would receive.
 */
const previousMode = process.env.E2E_MODE

beforeEach(() => {
  process.env.E2E_MODE = 'true'
  resetOutbox()
})

afterEach(() => {
  resetOutbox()
  if (previousMode === undefined) delete process.env.E2E_MODE
  else process.env.E2E_MODE = previousMode
})

async function send(personalization?: Parameters<typeof sendOrganizationInvitationEmail>[3]) {
  resetOutbox()
  await sendOrganizationInvitationEmail('invitee@example.com', 'Acme', 'https://x.test/team/invite/abc', personalization)
  const [message] = readOutbox()
  return message
}

describe('the invitation email', () => {
  it('keeps its subject, link and expiry guidance unchanged', async () => {
    const message = await send({ intent: 'hiring', roleTitle: null })
    expect(message.subject).toBe('Invitation to join Acme on BuilderHunt')
    expect(message.html).toContain('https://x.test/team/invite/abc')
    expect(message.html).toContain('expires in 7 days')
    expect(message.html).toContain('Sign in with the invited email address')
  })

  it('carries the lead sentence for each intent, from the shared copy map', async () => {
    // The same map the recipient's review card reads. Two copies would let the email and the card
    // describe different reasons for one invitation.
    for (const intent of INVITATION_INTENTS) {
      const message = await send({ intent, roleTitle: null })
      expect(message.html).toContain(INVITATION_INTENT_EMAIL_LEAD[intent])
    }
  })

  it('falls back to the other lead when no personalization is passed at all', async () => {
    const message = await send()
    expect(message.html).toContain(INVITATION_INTENT_EMAIL_LEAD.other)
  })

  it('includes the role title as the sender description, not as a fact', async () => {
    // Nobody verified this string. "They described the role as …" is the difference between reporting
    // what the sender typed and asserting something about the recipient.
    const message = await send({ intent: 'hiring', roleTitle: 'Staff Engineer' })
    expect(message.html).toContain('They described the role as')
    expect(message.html).toContain('Staff Engineer')
  })

  it('omits the role line entirely when there is no title', async () => {
    const message = await send({ intent: 'hiring', roleTitle: null })
    expect(message.html).not.toContain('They described the role as')
  })

  it('escapes a role title containing markup', async () => {
    const message = await send({ intent: 'hiring', roleTitle: '<img src=x onerror=alert(1)>' })
    expect(message.html).not.toContain('<img src=x')
    expect(message.html).toContain('&lt;img src=x')
  })

  it('escapes an organization name containing markup', async () => {
    await sendOrganizationInvitationEmail('a@b.test', '<script>alert(1)</script>', 'https://x.test/i/1', {
      intent: 'other',
      roleTitle: null,
    })
    const [message] = readOutbox()
    expect(message.html).not.toContain('<script>')
    expect(message.html).toContain('&lt;script&gt;')
  })

  it('makes no tier, credit or plan promise', async () => {
    // The recipient is not a member yet and effective entitlements change — beta mode can be switched
    // off the day after this email is sent.
    for (const intent of INVITATION_INTENTS) {
      const message = await send({ intent, roleTitle: 'Partner' })
      expect(message.html).not.toMatch(/\b(pro max|team plan|credits?|unlimited|\$\d)/i)
    }
  })
})
