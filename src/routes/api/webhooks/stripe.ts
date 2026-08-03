import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { receiveStripeWebhook, WebhookRejectedError } from '~/shared/lib/billing/webhook-inbox'

/**
 * Stripe webhook receipt — no user session, no CSRF/same-origin check (Stripe cannot hold a
 * session or send an Origin header we'd recognize); `Stripe-Signature` verification is the entire
 * authentication mechanism here. Reads raw bytes and never parses JSON before
 * `receiveStripeWebhook` has verified the signature over those exact bytes.
 */
export const Route = createFileRoute('/api/webhooks/stripe')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        const rawBody = await request.text()
        const signatureHeader = request.headers.get('stripe-signature')

        try {
          const receipt = await receiveStripeWebhook({ rawBody, signatureHeader })
          return Response.json({ received: true, eventId: receipt.eventId }, { status: 200 })
        } catch (error) {
          if (error instanceof WebhookRejectedError) {
            // Never log the raw body or signature header — log only the typed rejection code.
            console.error('Stripe webhook rejected:', error.code)
            return Response.json({ error: error.code }, { status: 400 })
          }
          console.error('Stripe webhook processing error:', error instanceof Error ? error.message : 'unknown error')
          return Response.json({ error: 'internal_error' }, { status: 500 })
        }
      },
    },
  },
})
