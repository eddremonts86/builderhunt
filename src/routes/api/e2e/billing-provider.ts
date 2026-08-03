import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'

/**
 * E2E-only debug seam: tells the in-process `FakeBillingProvider` that a subscription exists.
 *
 * ## The gap this closes
 *
 * `seedActiveSubscription` in the Playwright harness writes our own rows — `billing_customers`,
 * `billing_subscriptions` — with a `stripe_subscription_id` it invents. Under `E2E_MODE` the provider behind
 * every billing route is the deterministic in-memory fake, which therefore has never heard of that id. So
 * `POST /api/billing/subscription/preview` and `/cancel` reach `previewSubscriptionChange`/`cancelSubscription`,
 * miss the provider's map, and answer **500** — with no scenario set at all.
 *
 * That is worse than a plain gap. `billing-subscription-change-scenarios.spec.ts` asserted `>= 400` on a
 * declined change, and a 500 satisfies it, so the test passed while proving nothing about declines. Two tests
 * sat `fixme` for exactly this reason.
 *
 * ## Why a route rather than a provider method
 *
 * The fake lives in the *server* process; a Playwright spec runs in another one and cannot reach its memory —
 * the same split `setServerBillingScenario` solves over Redis. A tiny HTTP seam is the honest equivalent, and
 * `api/e2e/outbox.ts` already established the shape: hard-gated on `E2E_MODE`, a bare 404 otherwise.
 *
 * ## Why `changeSubscription` is the seeding call
 *
 * No new fake-provider surface is added. `changeSubscription` is the one method that already tolerates an
 * unknown subscription id and materializes it — which is precisely how the unit suite seeds the same provider
 * (`tests/unit/shared/lib/billing/subscription-changes.test.ts`'s own `seedActiveSubscription` calls it for
 * this purpose). Reusing that idiom keeps one seeding path instead of two that could drift.
 *
 * `scenario: 'success'` is passed explicitly, not left to default. The E2E subclass defaults a create call's
 * scenario from the Redis channel, so a spec that seeded *after* setting `decline` would have its own fixture
 * throw — a confusing failure in `beforeAll` rather than in the test. Seeding is setup and must be immune to
 * whatever the test under way is simulating.
 */
function e2eGate(): Response | null {
  if (process.env.E2E_MODE !== 'true') {
    return new Response(null, { status: 404 })
  }
  return null
}

const SeedBody = z.object({
  /** The `stripe_subscription_id` already written to `billing_subscriptions` — the provider is being told it is real. */
  subscriptionId: z.string().min(1),
  priceId: z.string().min(1).optional(),
}).strict()

export const Route = createFileRoute('/api/e2e/billing-provider')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['POST']),

      POST: async ({ request }) => {
        const gated = e2eGate()
        if (gated) return gated

        const parsed = SeedBody.safeParse(await request.json().catch(() => ({})))
        if (!parsed.success) {
          return Response.json({ error: 'Invalid body', issues: parsed.error.flatten() }, { status: 400 })
        }

        const { getBillingProvider } = await import('~/shared/lib/billing/stripe-provider')
        const subscription = await getBillingProvider().changeSubscription({
          subscriptionId: parsed.data.subscriptionId,
          newPriceId: parsed.data.priceId ?? 'price_e2e_seed',
          idempotencyKey: `e2e-seed-${parsed.data.subscriptionId}`,
          scenario: 'success',
        })
        return Response.json({ seeded: subscription.id, status: subscription.status })
      },
    },
  },
})
