import { config } from 'dotenv'

/**
 * Load the same env file chain the dev server loads, in the same order.
 *
 * Playwright does not hand a worker process the dev server's environment, so each entry point that
 * needs the database URLs loads them itself. Nine of those call sites loaded only `.env`, while Vite
 * — and therefore the app a developer actually clicks through — loads `.env` *and* `.env.local`,
 * with the latter winning. The two files disagreed on five keys, so the suite was testing a
 * different configuration than the app: `.env` had `STRIPE_BILLING_ENABLED=false` and a
 * `sk_live_` key, `.env.local` had it enabled with `sk_test_`.
 *
 * One helper rather than ten copies, because the copies drifted: `fakes.spec.ts` had already been
 * fixed to load both and nothing propagated it.
 */
export function loadHarnessEnv(): void {
  config({ path: '.env' })
  config({ path: '.env.local', override: true })
}
