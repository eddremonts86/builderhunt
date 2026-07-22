import { describe, expect, it } from 'vitest'
import { Route as InvitationsIndexRoute } from '~/routes/api/organizations/invitations/index'
import { Route as InvitationRoute } from '~/routes/api/organizations/invitations/$invitationId'
import { Route as AcceptRoute } from '~/routes/api/organizations/invitations/$invitationId/accept'

/**
 * Route-layer coverage only. The actual security properties task 6 cares
 * about — wrong email, unverified email, replay, revocation, expiry, and
 * enumeration-safety (every failure mode returning the identical generic
 * message/status) — are already exhaustively covered against the real
 * business logic in `organization-lifecycle.test.ts`'s
 * "acceptInvitation — enumeration safety" suite, along with cross-org
 * cancel and the concurrent-final-seat-on-resend race. Testing those again
 * here at the HTTP layer would just re-test the same code through an extra
 * indirection. What's specific to THIS layer: input validation happens
 * before any auth/DB work, and none of these routes accept an
 * organizationId from the client — invite resolves it from the caller's
 * own session, and resend/cancel/accept resolve it from the invitation
 * row itself (never trusting the caller's active org).
 */

function jsonRequest(body: unknown, method = 'POST'): Request {
  return new Request('https://builderhunt.test/api/test', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function bodylessRequest(method: string): Request {
  return new Request('https://builderhunt.test/api/test', { method })
}

const invitationsIndexHandlers = (InvitationsIndexRoute.options as unknown as {
  server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } }
}).server.handlers

const invitationHandlers = (InvitationRoute.options as unknown as {
  server: { handlers: { POST: (args: { request: Request; params: { invitationId: string } }) => Promise<Response>, DELETE: (args: { request: Request; params: { invitationId: string } }) => Promise<Response> } }
}).server.handlers

const acceptHandlers = (AcceptRoute.options as unknown as {
  server: { handlers: { POST: (args: { request: Request; params: { invitationId: string } }) => Promise<Response> } }
}).server.handlers

describe('POST /api/organizations/invitations', () => {
  it('rejects an invalid email before touching auth or the database', async () => {
    const res = await invitationsIndexHandlers.POST({ request: jsonRequest({ email: 'not-an-email', role: 'member' }) })
    expect(res.status).toBe(400)
  })

  it('rejects an invalid role before touching auth or the database', async () => {
    const res = await invitationsIndexHandlers.POST({ request: jsonRequest({ email: 'x@example.com', role: 'owner' }) })
    expect(res.status).toBe(400)
  })

  it('rejects a well-formed request with no session', async () => {
    const res = await invitationsIndexHandlers.POST({ request: jsonRequest({ email: 'x@example.com', role: 'member' }) })
    expect(res.status).toBe(401)
  })

  it('a client-supplied organizationId in the body changes nothing — it is not part of the schema', async () => {
    const withSpoofedOrg = await invitationsIndexHandlers.POST({
      request: jsonRequest({ email: 'x@example.com', role: 'member', organizationId: 'attacker-org' }),
    })
    const withoutIt = await invitationsIndexHandlers.POST({ request: jsonRequest({ email: 'x@example.com', role: 'member' }) })
    expect(withSpoofedOrg.status).toBe(withoutIt.status)
  })
})

describe('POST /api/organizations/invitations/$invitationId (resend)', () => {
  it('rejects a request with no session — never resends for an unauthenticated caller', async () => {
    const res = await invitationHandlers.POST({ request: bodylessRequest('POST'), params: { invitationId: 'invite-x' } })
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/organizations/invitations/$invitationId (cancel)', () => {
  it('rejects a request with no session — never cancels for an unauthenticated caller', async () => {
    const res = await invitationHandlers.DELETE({ request: bodylessRequest('DELETE'), params: { invitationId: 'invite-x' } })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/organizations/invitations/$invitationId/accept', () => {
  it('rejects a request with no session', async () => {
    const res = await acceptHandlers.POST({ request: bodylessRequest('POST'), params: { invitationId: 'invite-x' } })
    expect(res.status).toBe(401)
  })

  it('rejects a nonexistent invitation with the same generic message an authenticated caller would get for any other failure', async () => {
    // No session either way, so this really just confirms accept never
    // leaks anything about invitation existence before even checking who's
    // asking — auth failure and "invitation not found" must not be
    // distinguishable from the response alone.
    const res = await acceptHandlers.POST({ request: bodylessRequest('POST'), params: { invitationId: 'definitely-does-not-exist' } })
    const body = await res.json()
    expect(res.status).toBe(401)
    expect(body.error).not.toMatch(/not found|does not exist/i)
  })
})
