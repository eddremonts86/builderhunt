import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { auth } from '~/shared/lib/auth/better-auth'
import { CURRENT_CONSENT_VERSIONS, getConsentStatus, recordConsent } from '~/shared/lib/legal'

// The required-version map and the needs-acceptance rule live in `~/shared/lib/legal`. This route
// used to keep its own copy, which silently froze at `privacy: 'v1.0'` after the policy moved to
// v1.1 — so the endpoint advertised a superseded version as the one to accept.

const ConsentBody = z.object({
  document: z.enum(['tos', 'privacy', 'cookies']),
  version: z.string().min(1),
})

export const Route = createFileRoute('/api/consent/')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      GET: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          // An anonymous caller is not "up to date", it is unknown — report nothing outstanding
          // rather than the full list, so the signed-out shell never renders an acceptance prompt.
          if (!session?.user?.id) {
            return Response.json({
              userId: null,
              consents: {},
              required: CURRENT_CONSENT_VERSIONS,
              needsAcceptance: [],
            })
          }
          return Response.json(await getConsentStatus(session.user.id))
        } catch (err) {
          console.error('consent status error:', err)
          return Response.json({
            userId: null,
            consents: {},
            required: CURRENT_CONSENT_VERSIONS,
            needsAcceptance: [],
          })
        }
      },
      POST: async ({ request }) => {
        try {
          const session = await auth.api.getSession({ headers: request.headers })
          if (!session?.user?.id) return Response.json({ error: 'Unauthorized' }, { status: 401 })
          const body = await request.json().catch(() => ({}))
          const parsed = ConsentBody.safeParse(body)
          if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 })

          await recordConsent(session.user.id, parsed.data.document, parsed.data.version)
          return Response.json({ ok: true })
        } catch (err) {
          console.error('consent post error:', err)
          return Response.json({ error: 'Failed' }, { status: 500 })
        }
      },
    },
  },
})
