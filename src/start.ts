import { createStart } from '@tanstack/react-start'
import { serviceMetricsMiddleware } from '~/shared/lib/admin-metrics/middleware'

/**
 * `serviceMetricsMiddleware` is registered here because here is the only place that cannot be forgotten.
 *
 * `metrics.ts` had `apiRequests` and `apiErrors` declared, zeroed, and rendered on the admin metrics page —
 * incremented by nothing. Counting at call sites is what produced that: a route that forgets looks exactly
 * like a route with no traffic. One global request middleware has no opt-out.
 */
export const startInstance = createStart(() => ({
  defaultSsr: true,
  requestMiddleware: [serviceMetricsMiddleware],
}))
