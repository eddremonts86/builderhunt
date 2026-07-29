// /api/lists — list (paginated), create.
//
// List metadata is tenant-owned. Every handler goes through the
// principal-scoped repository so the visibility check is enforced
// at the same place that the DTO boundary lives.

import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import {
  createBuilderListForPrincipal,
  listVisibleBuilderLists,
} from '~/shared/lib/repositories/builder-lists'
import { rateLimit } from '~/shared/lib/rate-limit'
import { SharedResourceError, stripOrganizationAuthority, VisibilitySchema } from '~/shared/lib/shared-resources/contracts'

const CreateBody = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  visibility: VisibilitySchema,
})

export const Route = createFileRoute('/api/lists/')({
  component: () => null,
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const lists = await withTenantContext(principal, (tx) =>
            listVisibleBuilderLists(tx, principal),
          )
          return Response.json(lists.map((list) => ({
            id: list.id,
            organizationId: list.organizationId,
            createdByUserId: list.createdByUserId,
            name: list.name,
            description: list.description,
            visibility: list.visibility,
            createdAt: list.createdAt,
            updatedAt: list.updatedAt,
          })))
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Lists list error:', error)
          return Response.json({ error: 'Failed to fetch lists' }, { status: 500 })
        }
      },
      POST: async ({ request }) => {
        try {
          const principal = await requireTenantPrincipal(request)
          const limitResult = await rateLimit('builder-list-create', `${principal.organizationId}:${principal.userId}`, 20, 24 * 60 * 60)
          if (!limitResult.allowed) {
            return Response.json(
              { error: 'Too many lists created today. Try again tomorrow.' },
              { status: 429, headers: { 'Retry-After': String(Math.ceil(limitResult.resetMs / 1000)) } },
            )
          }
          const raw = await request.json().catch(() => ({}))
          // Strip every common tenant-key variant so a client cannot
          // override the principal's organizationId. The route
          // always uses principal.organizationId; the body's value
          // (if any) is data, never authority.
          const sanitized = stripOrganizationAuthority(raw as Record<string, unknown>)
          const parsed = CreateBody.safeParse(sanitized)
          if (!parsed.success) {
            return Response.json({ error: 'Invalid body', issues: parsed.error.issues }, { status: 422 })
          }
          const list = await withTenantContext(principal, (tx) =>
            createBuilderListForPrincipal(tx, principal, parsed.data),
          )
          return Response.json(list, { status: 201 })
        } catch (error) {
          if (error instanceof SharedResourceError) {
            return Response.json({ error: error.code, message: error.message }, { status: error.status })
          }
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          console.error('Lists create error:', error)
          return Response.json({ error: 'Failed to create list' }, { status: 500 })
        }
      },
    },
  },
})
