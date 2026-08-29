import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { auth } from '~/shared/lib/auth/better-auth'
import { withAccountSubjectContext } from '~/shared/lib/db/tenant-context'
import { getUserPreferences, setSearchIncludeSelfManaged } from '~/shared/lib/repositories/user-preferences'

/**
 * The opt-out for self-managed profiles in matching surfaces
 * (plan: phase-2/07-perfiles-autogestionados).
 *
 * ## Its own route, not a field on `PATCH /api/me/preferences`
 *
 * That route is gated behind `USER_SEGMENTATION_ENABLED` and refuses the whole request when the
 * flag is off. Folding this in would make an opt-out disappear with an unrelated feature flag —
 * and an opt-out somebody cannot exercise is not one. The two preferences live in the same table
 * and answer different questions.
 *
 * ## It changes what a list contains, and nothing else
 *
 * No permission moves. Nothing is granted or revoked, and the rank of the rows that were going to
 * be there anyway does not change — the origin is appended to a source list, never inserted into
 * one. Turning it off is a narrower search, not a different one.
 *
 * There is no way to write `null` back. "Never asked" is a state the product observes, not one it
 * offers: a setter that could restore it would make the difference between an unanswered question
 * and a considered "no" depend on which call happened last.
 */
const bodySchema = z.object({ include: z.boolean() }).strict()

export const Route = createFileRoute('/api/me/preferences/self-managed')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PATCH']),

      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const userId = session.user.id

          const preferences = await withAccountSubjectContext(userId, (transaction) =>
            getUserPreferences(transaction, userId))

          return Response.json({
            // The stored tri-state, unflattened: a client that wants to say "using the default"
            // rather than "on" needs to be able to tell the two apart.
            include: preferences.searchIncludeSelfManaged,
            effective: preferences.searchIncludeSelfManaged !== false,
          })
        } catch (error) {
          console.error('self-managed preference read error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },

      PATCH: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'unauthorized' }, { status: 401 })
          const userId = session.user.id

          const parsed = bodySchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) {
            return Response.json(
              { error: parsed.error.issues[0]?.message ?? 'invalid request' },
              { status: 400 },
            )
          }

          await withAccountSubjectContext(userId, (transaction) =>
            setSearchIncludeSelfManaged(transaction, { userId, include: parsed.data.include }))

          return Response.json({ include: parsed.data.include, effective: parsed.data.include })
        } catch (error) {
          console.error('self-managed preference write error:', (error as Error)?.name)
          return Response.json({ error: 'failed' }, { status: 500 })
        }
      },
    },
  },
})
