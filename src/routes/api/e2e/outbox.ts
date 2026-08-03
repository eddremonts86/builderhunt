import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'

/**
 * E2E-only debug seam: exposes the in-process email outbox
 * (`src/shared/lib/email/outbox.ts`) so Playwright specs — which run in a
 * different process from the app server — can assert on emails the server
 * dispatched (password reset, invitations, alert digests, export-ready).
 *
 * Hard-gated on `E2E_MODE=true`: in any other mode every method returns a
 * bare 404 before touching the outbox module, so the route is unreachable
 * in production and indistinguishable from a nonexistent path.
 */
function e2eGate(): Response | null {
  if (process.env.E2E_MODE !== 'true') {
    return new Response(null, { status: 404 })
  }
  return null
}

export const Route = createFileRoute('/api/e2e/outbox')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'DELETE']),

      GET: async () => {
        const gated = e2eGate()
        if (gated) return gated
        const { readOutbox } = await import('~/shared/lib/email/outbox')
        return Response.json({ emails: readOutbox() })
      },
      DELETE: async () => {
        const gated = e2eGate()
        if (gated) return gated
        const { resetOutbox } = await import('~/shared/lib/email/outbox')
        resetOutbox()
        return Response.json({ cleared: true })
      },
    },
  },
})
