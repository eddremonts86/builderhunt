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
 * layer: an unauthenticated caller is rejected identically whatever the
 * body looks like, and no route accepts a client-supplied organizationId.
 *
 * This block used to say "bad input is rejected before any auth/DB work
 * happens", and the assertions below enforced it — an anonymous caller with
 * an invalid body was expected to get 400. That ordering was the defect
 * fixed on 2026-08-03: 400 for a malformed body and 401 for a well-formed
 * one lets someone with no session read the request schema out of status
 * codes. The refusal a stranger sees must not vary with facts they are not
 * entitled to, so 401 is now the answer either way, and
 * `pnpm security:auth-before-validate` fails if the ordering comes back.
 *
 * The 400 path still matters, but it is only observable once a caller is
 * authenticated — which this layer cannot construct, having no session. It
 * is asserted in `tests/e2e/api/organizations.spec.ts` instead. The full role/elevation/atomicity matrix (member vs admin vs
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
  it('answers an invalid role with 401, not 400 — the body is not parsed until the caller is known', async () => {
    // `role: 'owner'` is outside the enum on purpose: ownership moves through transfer-ownership. A 400 here
    // would confirm both that the route exists and that 'owner' is not an accepted value.
    const res = await membersHandlers.PATCH({ request: jsonRequest({ role: 'owner' }, 'PATCH'), params: { memberId: 'user-x' } })
    expect(res.status).toBe(401)
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
  /**
   * All three bodies — absent, empty and well-formed — must produce the identical 401 for a caller with no
   * session. Asserted as one property rather than three cases, because the leak was never any single status: it
   * was the *difference* between them being readable without a session.
   */
  it('answers absent, empty and well-formed targetUserId identically with 401', async () => {
    const [missing, empty, wellFormed] = await Promise.all([
      transferHandlers.POST({ request: jsonRequest({}) }),
      transferHandlers.POST({ request: jsonRequest({ targetUserId: '' }) }),
      transferHandlers.POST({ request: jsonRequest({ targetUserId: 'user-x' }) }),
    ])
    expect([missing.status, empty.status, wellFormed.status]).toEqual([401, 401, 401])
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
