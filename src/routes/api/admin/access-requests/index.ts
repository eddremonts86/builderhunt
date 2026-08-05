/**
 * The approve/revoke surface for invite-only sign-up (waitlist-launch plan).
 *
 * `GET` lists the queue, `POST` records a decision. Both are platform-admin only — an approved row in
 * `access_requests` is the allowlist the sign-up gate reads, so being able to write here is being able
 * to let someone into the product.
 *
 * ## Why `platformDb` and not `publicDb`
 *
 * `drizzle/0147_access_requests_grants.sql` gives `builderhunt_app` (the plain web-runtime role,
 * `DATABASE_URL`) only INSERT and SELECT: the public request form may add a row and check for a
 * duplicate, and that is all it may ever do. UPDATE — which is what approving and revoking are — is
 * granted to `builderhunt_platform`. So the decision path has to run on `platformDb`, or Postgres
 * refuses it. That is the intended shape: the privilege boundary is enforced by the database, not by
 * remembering to check a role in application code.
 *
 * ## Every decision is audited
 *
 * Approvals and revocations land in `security_audit_events` through `auditPlatformAdminAction`, the
 * same sink platform-admin claim revocation uses. Letting a person into a closed beta, and taking that
 * away, is exactly the kind of privileged act that has to be answerable a month later.
 *
 * The invite token is **not** returned in the response body of an approval, and is not logged. It goes
 * to the approved address by email and nowhere else — see `approveAccess`.
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import {
  approveAccess,
  isPlausibleEmail,
  listAccessRequests,
  normalizeAccessEmail,
  rejectAccess,
  revokeAccess,
} from '~/shared/lib/access-requests'
import {
  auditPlatformAdminAction,
  platformAdminErrorResponse,
  requirePlatformAdminPrincipal,
} from '~/shared/lib/auth/platform-admin'
import { platformDb } from '~/shared/lib/db/client'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'

const STATUSES = ['pending', 'approved', 'rejected', 'revoked'] as const

const QuerySchema = z.object({
  status: z.enum(STATUSES).optional(),
})

const DecisionSchema = z.object({
  email: z.string().min(3).max(254),
  action: z.enum(['approve', 'reject', 'revoke']),
  /** Operator note — why. Stored, never shown to the requester. */
  note: z.string().max(500).optional(),
})

export const Route = createFileRoute('/api/admin/access-requests/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const url = new URL(request.url)
          const parsed = QuerySchema.safeParse(Object.fromEntries(url.searchParams))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_query', issues: parsed.error.issues }, { status: 422 })
          }
          const rows = await listAccessRequests(platformDb, parsed.data.status)
          return Response.json({
            requests: rows.map((row) => ({
              email: row.email,
              status: row.status,
              requestedAt: row.requestedAt,
              decidedAt: row.decidedAt,
              decidedByUserId: row.decidedByUserId,
              note: row.note,
              // Whether a live invite exists, never the hash itself — a hash in a response body is
              // still material an attacker can work against offline.
              hasLiveInvite: Boolean(row.inviteTokenHash),
              inviteExpiresAt: row.inviteExpiresAt,
              inviteConsumedAt: row.inviteConsumedAt,
            })),
          })
        } catch (error) {
          const denied = platformAdminErrorResponse(error)
          if (denied) return denied
          throw error
        }
      },

      POST: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const body = await request.json().catch(() => null)
          const parsed = DecisionSchema.safeParse(body)
          if (!parsed.success) {
            return Response.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 422 })
          }
          const email = normalizeAccessEmail(parsed.data.email)
          if (!isPlausibleEmail(email)) {
            return Response.json({ error: 'invalid_email' }, { status: 422 })
          }

          if (parsed.data.action === 'reject') {
            // Distinct from revoke: this records "we said no" and never touches an invite, because a
            // pending row has none. `rejectAccess` refuses an already-approved row, so declining
            // someone who was granted access has to go through revocation instead — which is the path
            // that also kills their outstanding link.
            const rejected = await rejectAccess(platformDb, {
              email,
              decidedByUserId: principal.userId,
              note: parsed.data.note,
            })
            await auditPlatformAdminAction(principal, {
              action: 'access_request.reject',
              targetType: 'access_request',
              targetId: email,
              result: rejected ? 'allowed' : 'failed',
              details: { note: parsed.data.note ?? null },
            })
            if (!rejected) {
              return Response.json(
                { error: 'not_rejectable', detail: 'No pending request for that address, or it is already approved — revoke instead.' },
                { status: 409 },
              )
            }
            return Response.json({ email, status: 'rejected' })
          }

          if (parsed.data.action === 'revoke') {
            const revoked = await revokeAccess(platformDb, {
              email,
              decidedByUserId: principal.userId,
              note: parsed.data.note,
            })
            await auditPlatformAdminAction(principal, {
              action: 'access_request.revoke',
              targetType: 'access_request',
              targetId: email,
              result: revoked ? 'allowed' : 'failed',
              details: { note: parsed.data.note ?? null },
            })
            if (!revoked) return Response.json({ error: 'not_found' }, { status: 404 })
            return Response.json({ email, status: 'revoked' })
          }

          // `createIfMissing`: an operator deciding to let a specific person in is the normal way a
          // closed beta grows, so approving an address that never submitted the form has to work.
          // 0147 gave this role only SELECT and UPDATE, which made that silently do nothing; 0149
          // grants the INSERT, with the reasoning recorded there. The id is minted here so the domain
          // module stays free of id policy.
          const approval = await approveAccess(platformDb, {
            email,
            decidedByUserId: principal.userId,
            note: parsed.data.note,
            createIfMissing: true,
            id: crypto.randomUUID(),
          })
          await auditPlatformAdminAction(principal, {
            action: 'access_request.approve',
            targetType: 'access_request',
            targetId: email,
            result: approval ? 'allowed' : 'failed',
            // Deliberately no token, and no hash, in the audit details.
            details: { note: parsed.data.note ?? null, inviteExpiresAt: approval?.expiresAt ?? null },
          })
          if (!approval) return Response.json({ error: 'not_found' }, { status: 404 })

          // TODO(waitlist-launch): send the invite email here. Until that lands, `approval.token` is
          // the only copy of the token and it is dropped on this line — the person is allowlisted and
          // can sign up, they just do not get a link. Nothing is stored that could recover it, which
          // is by design; a resend mints a new one.
          return Response.json({
            email,
            status: 'approved',
            inviteExpiresAt: approval.expiresAt,
            emailSent: false,
          })
        } catch (error) {
          const denied = platformAdminErrorResponse(error)
          if (denied) return denied
          throw error
        }
      },
    },
  },
})
