import { serviceMetricRecorder } from './recorder'
import { flushServiceMetrics } from '../repositories/service-metrics'

/**
 * Writes the recorder's complete minutes to the database, on a timer (plan 57, Admin track).
 *
 * ## Why a timer and not the request that closed the minute
 *
 * Flushing from a request would put a database write on a random user's latency, chosen by whoever happened
 * to arrive first after the minute rolled — so one request per minute would be measurably slower than its
 * neighbours, and it would be slower *in the metrics being written*. A timer costs nothing that a reader
 * sees.
 *
 * ## Why a failed flush restores the buffer instead of retrying
 *
 * Retrying inside the flush would either block the next tick or double-write; the additive upsert makes a
 * double-write wrong. Handing the minutes back to the recorder means the next tick carries them, merged
 * with anything that arrived meanwhile, and `MAX_TRACKED_MINUTES` decides when to give up — the bound is in
 * one place rather than split between a buffer and a retry policy.
 *
 * A dropped minute is the correct outcome of a long database outage. The alternative is a buffer that grows
 * until the process dies, which converts somebody else's outage into ours.
 */

/** Every thirty seconds, so a minute is written within about half a minute of completing. */
const FLUSH_INTERVAL_MS = 30_000

/**
 * Identifies this process's rows.
 *
 * `instance` distinguishes two containers so their minutes are summed rather than confused; `deployment`
 * attributes a change in a rate to a release rather than to traffic. Both read from the environment Coolify
 * already sets, and both fall back to something stable-per-process rather than to a random value — a random
 * instance id per boot would make a restart look like a new machine forever.
 */
function identity(): { instance: string; deployment: string } {
  return {
    instance: process.env.HOSTNAME ?? `pid-${process.pid}`,
    deployment: process.env.SOURCE_COMMIT ?? process.env.COOLIFY_DEPLOYMENT_UUID ?? 'unknown',
  }
}

let timer: ReturnType<typeof setInterval> | null = null

/** Flushes once. Exported so a test can drive it without a timer, and so a worker route can force one. */
export async function flushOnce(now: Date = new Date()): Promise<{ written: number }> {
  const deltas = serviceMetricRecorder.take(now)
  if (deltas.length === 0) return { written: 0 }
  try {
    return await flushServiceMetrics(deltas, identity())
  } catch (error) {
    serviceMetricRecorder.restore(deltas)
    // Logged, not thrown: the caller is a timer, and an unhandled rejection in a timer takes the process
    // down. The next tick will try again with these minutes still in hand.
    console.error('service metric flush failed, minutes retained for the next tick:', error)
    return { written: 0 }
  }
}

/**
 * Starts the timer, once per process.
 *
 * Idempotent because it is called from the request middleware — every request would otherwise start another
 * one. `unref()` so the timer never holds the process open: a metrics flush must not be the reason a
 * container refuses to exit during a deploy.
 */
export function startServiceMetricFlush(): void {
  if (timer) return
  timer = setInterval(() => {
    void flushOnce()
  }, FLUSH_INTERVAL_MS)
  timer.unref?.()
}

/** Stops the timer and flushes what is left. For a graceful shutdown or a test. */
export async function stopServiceMetricFlush(): Promise<void> {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  // One final take at a moment past the current minute, so the minute in progress is written rather than
  // discarded on the way out.
  await flushOnce(new Date(Date.now() + 60_000))
}
