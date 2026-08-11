import { createMiddleware } from '@tanstack/react-start'
import { metrics } from '../metrics'
import { serviceMetricRecorder } from './recorder'
import { startServiceMetricFlush } from './flush'

/**
 * The one place every request is counted (plan 57, Admin track).
 *
 * ## The defect this closes
 *
 * `metrics.ts` declared `apiRequests` and `apiErrors`, initialised them to zero, and
 * `AdminMetricsPage.tsx` rendered them as "API requests" and "API errors". **Nothing ever incremented
 * them.** So the admin page has shown zero for its whole existence, and an operator reading it would
 * conclude the platform served no traffic rather than that nobody was counting — the exact lie of
 * implication this plan's other tasks are about, sitting on the page the plan rebuilds.
 *
 * A request middleware is the only honest fix. Counting at call sites is what produced the gap: every
 * route would have to remember, and the ones that forgot would look identical to the ones with no
 * traffic. Here there is one wrapper and no route can opt out of being counted.
 *
 * ## Why it never throws and never awaits the write
 *
 * Measurement must not be able to fail a request. `record()` is synchronous, in-memory and bounded, and
 * the whole call sits in a `try`/`catch` that swallows: a metrics bug that returned a 500 on a working page
 * would be worse than no metrics at all. The database write happens on a timer elsewhere — see `flush.ts`.
 */
export const serviceMetricsMiddleware = createMiddleware().server(async ({ next, request }) => {
  // Started lazily here rather than at module load: the flush timer belongs to a process that is actually
  // serving requests, and importing this module in a test or a script should not open a database handle.
  startServiceMetricFlush()

  const startedAt = performance.now()
  let status = 500
  try {
    const result = await next()
    /**
     * The response's own status, when the framework exposes one.
     *
     * A thrown error leaves `status` at the 500 it was initialised to, which is the honest reading: the
     * request did not produce a response, and counting it as a success because no status was observed
     * would hide exactly the failures the error rate exists to show.
     */
    const response: unknown = (result as { response?: unknown }).response
    if (response instanceof Response) status = response.status
    else status = 200
    return result
  } finally {
    try {
      const pathname = new URL(request.url).pathname
      serviceMetricRecorder.record({ pathname, status, durationMs: performance.now() - startedAt })

      /**
       * The in-process counters get the same observation, restricted to `/api/`.
       *
       * These are the two the page labels "API requests" and "API errors", so counting a page render in
       * them would make the label wrong in the other direction — a zero replaced by a number that means
       * something else. The recorder above keeps page traffic, under its own families.
       *
       * Both live because they answer different questions: `metrics.ts` is *this process since boot*, which
       * the runtime section is explicitly about, and the recorder is *per minute, per family, across
       * instances*. Deriving one from the other would mean either resetting a counter the runtime section
       * needs, or reporting a cumulative figure the history must never carry.
       */
      if (pathname.startsWith('/api/')) {
        metrics.increment('apiRequests')
        if (status >= 500) metrics.increment('apiErrors')
      }
    } catch {
      // Never let counting break serving. A dropped observation is a gap in a chart; a thrown error here
      // would be a 500 on a page that worked.
    }
  }
})
