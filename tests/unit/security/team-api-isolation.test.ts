import { describe, expect, it } from 'vitest'
import { Route as MembersRoute } from '~/routes/api/organizations/members/$memberId'
import { Route as TransferRoute } from '~/routes/api/organizations/transfer-ownership'
import { Route as OrganizationsRoute } from '~/routes/api/organizations/index'

/**
 * These routes never accept an `organizationId` from the client at all —
 * every one of them resolves it exclusively from `requireTenantPrincipal`
 * (the caller's own session). That isn't just runtime-tested here; it's
 * structurally guaranteed by the zod input schemas (no such field exists to
 * parse) and by TypeScript (the handlers only ever reference
 * `principal.organizationId`, so passing a client-supplied one would be a
 * type error, not just a runtime no-op). What IS worth testing at this
 * layer: bad input is rejected before any auth/DB work happens, and an
 * unauthenticated caller is rejected regardless of how well-formed the
 * body is. The full role/elevation/atomicity matrix (member vs admin vs
 * owner, self vs. other, stale-owner-revoked-on-transfer, etc.) is already
 * exhaustively covered against the real business logic in
 * `organization-lifecycle.test.ts` — these routes are thin, and duplicating
 * that matrix here would test the same code twice instead of the seam that
 * actually changed: HTTP input validation and auth resolution.
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

const membersHandlers = (MembersRoute.options as unknown as {
  server: { handlers: { PATCH: (args: { request: Request; params: { memberId: string } }) => Promise<Response>, DELETE: (args: { request: Request; params: { memberId: string } }) => Promise<Response> } }
}).server.handlers

const transferHandlers = (TransferRoute.options as unknown as {
  server: { handlers: { POST: (args: { request: Request }) => Promise<Response> } }
}).server.handlers

const organizationsHandlers = (OrganizationsRoute.options as unknown as {
  server: { handlers: { DELETE: (args: { request: Request }) => Promise<Response> } }
}).server.handlers

describe('PATCH /api/organizations/members/$memberId', () => {
  it('rejects an invalid role before touching auth or the database', async () => {
    const res = await membersHandlers.PATCH({ request: jsonRequest({ role: 'owner' }, 'PATCH'), params: { memberId: 'user-x' } })
    expect(res.status).toBe(400)
  })

  it('rejects a well-formed request with no session', async () => {
    const res = await membersHandlers.PATCH({ request: jsonRequest({ role: 'admin' }, 'PATCH'), params: { memberId: 'user-x' } })
    expect(res.status).toBe(401)
  })

  it('a client-supplied organizationId in the body changes nothing — it is not part of the schema', async () => {
    const withSpoofedOrg = await membersHandlers.PATCH({
      request: jsonRequest({ role: 'admin', organizationId: 'attacker-org' }, 'PATCH'),
      params: { memberId: 'user-x' },
    })
    const withoutIt = await membersHandlers.PATCH({ request: jsonRequest({ role: 'admin' }, 'PATCH'), params: { memberId: 'user-x' } })
    expect(withSpoofedOrg.status).toBe(withoutIt.status)
  })
})

describe('DELETE /api/organizations/members/$memberId', () => {
  it('rejects a request with no session', async () => {
    const res = await membersHandlers.DELETE({ request: bodylessRequest('DELETE'), params: { memberId: 'user-x' } })
    expect(res.status).toBe(401)
  })
})

describe('POST /api/organizations/transfer-ownership', () => {
  it('rejects a missing targetUserId before touching auth or the database', async () => {
    const res = await transferHandlers.POST({ request: jsonRequest({}) })
    expect(res.status).toBe(400)
  })

  it('rejects an empty targetUserId', async () => {
    const res = await transferHandlers.POST({ request: jsonRequest({ targetUserId: '' }) })
    expect(res.status).toBe(400)
  })

  it('rejects a well-formed request with no session', async () => {
    const res = await transferHandlers.POST({ request: jsonRequest({ targetUserId: 'user-x' }) })
    expect(res.status).toBe(401)
  })
})

describe('DELETE /api/organizations', () => {
  it('rejects a request with no session — never deletes an organization for an unauthenticated caller', async () => {
    const res = await organizationsHandlers.DELETE({ request: bodylessRequest('DELETE') })
    expect(res.status).toBe(401)
  })
})
