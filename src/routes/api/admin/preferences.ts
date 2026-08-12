import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import {
  readPlatformAdminPreferences,
  savePlatformAdminPreferences,
} from '~/shared/lib/repositories/platform-admin-preferences'

/**
 * This platform admin's console preferences (plan 57, Admin track — "Persist isolated platform-admin
 * preferences").
 *
 * ## Why the user id comes from the principal and never from the body
 *
 * There is no `userId` parameter on this route, in either direction. A preferences endpoint that accepts one is a
 * preferences endpoint that lets a platform admin read or overwrite another admin's console — and the two-person
 * version of that is worse than it sounds, because the natural way to notice would be someone's layout changing
 * for no reason. `requirePlatformAdminPrincipal` returns who is asking, and that is the only id the queries see.
 *
 * ## Why this is not on `/api/dashboard/preferences`
 *
 * Different table, different role, different scope. The tenant endpoint writes `dashboard_preferences`, which is
 * keyed `(organization_id, user_id)` under RLS; this writes `platform_admin_preferences`, which
 * `builderhunt_app` has no grant on at all. Sharing a route would mean one handler holding both connections and
 * deciding which to use from the request — a decision that is correct until it is not.
 *
 * ## Shared browsers
 *
 * Nothing is stored client-side, which is the point rather than an implementation detail. A layout in
 * `localStorage` survives a sign-out, so on a shared machine the next admin opens the previous admin's console —
 * and on a *tenant's* machine it would be a platform preference sitting in a browser that should have no trace of
 * the admin console at all.
 */

const bodySchema = z
  .object({
    /**
     * Not enums here, deliberately.
     *
     * The repository normalizes against `ADMIN_METRIC_SECTIONS` and friends, and duplicating those unions in a
     * Zod enum means a section added to the contract silently 400s on this route until somebody remembers the
     * second copy. Length is checked so a body cannot carry a URL into a text column; the vocabulary is checked
     * once, where it lives.
     */
    section: z.string().max(32).optional(),
    range: z.string().max(8).optional(),
    variant: z.string().max(32).optional(),
    /**
     * Bounded, and the bound is the point: an unbounded array in a `jsonb` column is a row whose size a client
     * decides. Twenty-four is past the number of widgets that exist and small enough that a malicious body is a
     * 400 rather than a megabyte.
     */
    hiddenWidgetIds: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,62}$/)).max(24).optional(),
  })
  .strict()

export const Route = createFileRoute('/api/admin/preferences')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'PUT']),

      GET: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          return Response.json(await readPlatformAdminPreferences(principal.userId))
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin preferences read failed:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },

      PUT: async ({ request }) => {
        try {
          const principal = await requirePlatformAdminPrincipal(request)
          const parsed = bodySchema.safeParse(await request.json().catch(() => null))
          if (!parsed.success) {
            return Response.json({ error: 'invalid_request', issues: parsed.error.flatten() }, { status: 400 })
          }

          const result = await savePlatformAdminPreferences(principal.userId, parsed.data)
          if (!result.ok) {
            /**
             * 422, not 400 or a silent filter.
             *
             * The body was well-formed and the request was refused on a rule — hiding a required widget — so the
             * client should be able to tell "you sent nonsense" from "you asked for something that is not
             * allowed". A silent filter would report success and then not honour it, and the next read would
             * disagree with what the control showed.
             */
            return Response.json({ error: result.error, widgetId: result.widgetId }, { status: 422 })
          }
          return Response.json(result.preferences)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin preferences write failed:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
