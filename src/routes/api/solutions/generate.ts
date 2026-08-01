/**
 * `POST /api/solutions/generate` — the paid generation flow, streamed (plan 43 Phase 8).
 *
 * ## Why a stream rather than a slow POST
 *
 * A generate run is up to five provider calls and two SQL lanes; a plain request would leave the page with a
 * spinner and no way to tell a slow run from a dead one. Server-sent events carry a `progress` event per stage
 * and then exactly one terminal event, so the UI can say what is happening and the user can cancel with
 * knowledge of what they are cancelling.
 *
 * ## Cancellation is the client disconnecting
 *
 * `request.signal` aborts when the browser drops the connection — which is what "Cancel" does. The signal is
 * handed to the orchestration, which checks it between stages and throws; the throw releases the reservation
 * through the same path as any other failure. Nothing needs a cancel endpoint, and a cancel endpoint would be
 * worse: it would have to find a run by id and would be one more thing to authorize.
 *
 * ## Nothing is persisted here
 *
 * The response is the run; keeping it is a separate, explicit `POST /api/solutions/runs`. spec.md: "Nothing is
 * saved until you explicitly save a result."
 */
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import { rateLimit } from '~/shared/lib/rate-limit'
import { log } from '~/shared/lib/log'
import { FeatureBillingError } from '~/shared/lib/billing/feature-authorization'
import { MAX_BRIEF_TEXT_LENGTH } from '~/shared/lib/solutions/ai-contracts'
import { SolutionsBillingError } from '~/modules/solutions/server/billing'
import { generateSolutions, type GenerationProgress } from '~/modules/solutions/server/generate'

const Body = z.object({
  briefText: z.string().min(1).max(MAX_BRIEF_TEXT_LENGTH),
  clarification: z.object({
    question: z.string().min(1).max(300),
    answer: z.string().min(1).max(1000),
  }).strict().optional(),
  /** Echoed from `GET /api/solutions/billing-state`. The server checks it against the current rate card. */
  confirmation: z.object({
    acceptedUnits: z.number().int().positive(),
    acceptedRateCardVersion: z.number().int().positive(),
  }).strict(),
  /** Stable across a retry of the same intent — that is what makes a duplicate replay instead of double-charge. */
  idempotencyKey: z.string().min(8).max(200),
  operation: z.enum(['generate', 'regenerate']).optional(),
}).strict()

export const Route = createFileRoute('/api/solutions/generate')({
  component: () => null,
  server: {
    handlers: {
      POST: async ({ request }) => {
        let principal
        try {
          principal = await requireTenantPrincipal(request)
        } catch (error) {
          if (error instanceof TenantAuthorizationError) {
            return Response.json({ error: error.message }, { status: error.status })
          }
          throw error
        }

        const parsed = Body.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) {
          return Response.json({ error: 'Invalid request', issues: parsed.error.issues.slice(0, 5) }, { status: 422 })
        }

        // A generation is expensive for us and for the user's balance. Per user rather than per organization, so
        // one member cannot exhaust a team's window.
        const limit = await rateLimit('solutions-generate', `${principal.organizationId}:${principal.userId}`, 30, 60 * 60)
        if (!limit.allowed) {
          return Response.json(
            { error: 'Too many generations this hour. Try again shortly.' },
            { status: 429, headers: { 'Retry-After': String(Math.ceil(limit.resetMs / 1000)) } },
          )
        }

        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
            }
            try {
              const outcome = await withTenantContext(principal, (tx) => generateSolutions(tx, principal, {
                briefText: parsed.data.briefText,
                ...(parsed.data.clarification ? { clarificationAnswer: parsed.data.clarification } : {}),
                confirmation: parsed.data.confirmation,
                idempotencyKey: parsed.data.idempotencyKey,
                ...(parsed.data.operation ? { operation: parsed.data.operation } : {}),
                signal: request.signal,
                onProgress: (progress: GenerationProgress) => send('progress', progress),
              }))
              send('result', outcome)
            } catch (error) {
              // Errors travel as an event, not an HTTP status: the headers are long gone by the time a provider
              // fails. The client reads `event: error` and shows the reason; a stream that just ends is
              // indistinguishable from a dropped connection.
              send('error', toClientError(error))
            } finally {
              controller.close()
            }
          },
        })

        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-store',
            connection: 'keep-alive',
            // Nginx and friends buffer SSE into uselessness without this.
            'x-accel-buffering': 'no',
          },
        })
      },
    },
  },
})

/**
 * What the client is told when a run fails.
 *
 * Coded, because each cause leads somewhere different: `insufficient_entitlement` to an upgrade,
 * `insufficient_credits` to a credit pack, `confirmed_amount_stale` to re-confirming a price that changed
 * underneath them, `cancelled` to nothing at all. A single "generation failed" would send everyone to support.
 */
function toClientError(error: unknown): { code: string; message: string } {
  if (error instanceof SolutionsBillingError) return { code: error.code, message: error.message }
  if (error instanceof FeatureBillingError) return { code: error.code, message: error.message }
  if (error instanceof Error && error.name === 'AbortError') {
    return { code: 'cancelled', message: 'Generation cancelled. You have not been charged.' }
  }
  // Never the raw message: it can carry a provider's response body, and this one is not a known shape.
  log.error('solutions_generate_failed', { error: error instanceof Error ? error.message : String(error) })
  return { code: 'generation_failed', message: 'Generation failed. You have not been charged.' }
}
