import * as React from 'react'
import {
  adminMetricSectionResponseSchema,
  type AdminMetricRange,
  type AdminMetricSection,
  type AdminMetricSectionPayload,
} from '~/shared/lib/admin-metrics/contracts'

/**
 * Fetches one Admin Metrics section (plan 57, Admin track — the lazy widget shell).
 *
 * ## Why plain `fetch` and not the query client
 *
 * Deliberate, and not a shortcut. A Playwright `page.route` interception against a TanStack Query endpoint
 * hangs in this repository — the identical interception works against a `useEffect` fetch — and the states
 * this hook exists to produce (stale-after-failure, retrying, last-success) are exactly the ones that have to
 * be provable from a test that can fail the request on demand. A cache layer whose failure paths cannot be
 * exercised is worse than no cache on a page one operator reads.
 *
 * ## The four states, and why "stale" is not "error"
 *
 * The page an operator opens during an incident must never replace last known numbers with an error box.
 * When a refresh fails, `data` keeps the last successful payload and `stale` goes true — so the numbers stay
 * on screen with the time they were true beside them, which is the information being asked for. Discarding
 * them would answer "we do not know" when we do know, as of ninety seconds ago.
 *
 * ## Why nothing here resets on a section change
 *
 * Because the caller remounts it instead: `AdminMetricsPage` keys its section host on the section/range/variant
 * triple. Clearing this state in an effect would leave a window where the previous payload is still mounted
 * while the new request is in flight, and since every section shares one body shape, traffic's numbers would
 * render perfectly under "Activation" for as long as the fetch took. A key makes React discard the state rather
 * than asking this hook to remember to.
 */

/** How often a visible section re-reads. Slower than the old page's 15 s: these are windowed aggregates. */
const REFRESH_INTERVAL_MS = 30_000

export interface MetricSectionState {
  payload: AdminMetricSectionPayload | null
  /** When the payload on screen was fetched. `null` until the first success. */
  lastSuccessAt: Date | null
  /** True when the most recent attempt failed and `payload` is therefore older than it looks. */
  stale: boolean
  /** The most recent failure, kept so the page can say what went wrong beside the old numbers. */
  error: string | null
  /** A request is in flight. Distinct from `payload === null`, which is "never loaded". */
  loading: boolean
  /** Consecutive failures. Shown so an operator can tell one blip from a sustained outage. */
  failures: number
  refresh: () => void
}

export function useMetricSection(
  section: AdminMetricSection,
  range: AdminMetricRange,
  variant: string,
  compare = false,
): MetricSectionState {
  const [payload, setPayload] = React.useState<AdminMetricSectionPayload | null>(null)
  const [lastSuccessAt, setLastSuccessAt] = React.useState<Date | null>(null)
  const [stale, setStale] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failures, setFailures] = React.useState(0)

  /**
   * The in-flight request, aborted before a new one starts.
   *
   * This is the dedupe. Without it, switching section three times quickly leaves three requests racing and
   * whichever answers last wins — so a metrics page can settle on the section you left rather than the one
   * you are looking at. Aborting also means a hidden tab returning to the foreground cannot stack a manual
   * refresh on top of the visibility refresh.
   */
  const inFlight = React.useRef<AbortController | null>(null)

  /**
   * Whether anything has ever loaded, held in a ref rather than read from state.
   *
   * `load` would otherwise have to depend on `payload`, and `payload` changes on every success — so the
   * effect below would tear down its timer and immediately re-fetch after each response, which is a fetch
   * loop rather than a thirty-second poll. The only thing the failure path needs from the previous state is
   * "was there something on screen", and that is what this holds.
   */
  const hasLoaded = React.useRef(false)

  const load = React.useCallback(async () => {
    inFlight.current?.abort()
    const controller = new AbortController()
    inFlight.current = controller
    setLoading(true)

    // `compare` is sent explicitly as a literal rather than omitted when false, because the route refuses
    // anything that is neither literal — and an omitted parameter and a `false` one should not take different
    // code paths on the server.
    const query = new URLSearchParams({ section, range, variant, compare: String(compare) })
    try {
      const response = await fetch(`/api/admin/metrics/sections?${query}`, {
        credentials: 'include',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`Request failed: ${response.status}`)

      /**
       * Parsed with the same schema the server built the payload with.
       *
       * A metrics page is the one screen where a plausible wrong number does the most damage, and every rule
       * worth having — a unit on every value, a scope, a window with a timezone, a process counter that
       * cannot claim to be a platform total — is in that schema. Trusting the shape here would mean the
       * rules hold only as long as the server is the only writer.
       */
      const parsed = adminMetricSectionResponseSchema.parse(await response.json())
      if (controller.signal.aborted) return

      hasLoaded.current = true
      setPayload(parsed.payload)
      setLastSuccessAt(new Date())
      setStale(false)
      setError(null)
      setFailures(0)
    } catch (caught) {
      // An abort is this hook superseding itself, not a failure: reporting it would flash an error every
      // time an operator changed section.
      if (controller.signal.aborted) return
      setError(caught instanceof Error ? caught.message : String(caught))
      setFailures((count) => count + 1)
      // Only stale if there is something on screen to *be* stale. Otherwise it never loaded, which the page
      // says differently.
      if (hasLoaded.current) setStale(true)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [section, range, variant, compare])

  React.useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const stop = () => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      if (timer === undefined) timer = setInterval(() => void load(), REFRESH_INTERVAL_MS)
    }
    /**
     * Nothing polls a tab nobody is looking at, and a returning tab re-reads immediately.
     *
     * The second half matters as much as the first: a tab coming back to the foreground is showing numbers
     * as old as the time it spent hidden, and waiting up to thirty seconds to correct them is how an
     * operator reads a stale count during an incident.
     */
    const onVisibilityChange = () => {
      if (document.hidden) {
        stop()
        return
      }
      void load()
      start()
    }

    /**
     * The initial read, and the one case the `set-state-in-effect` rule is aimed past.
     *
     * The rule exists to catch state *derived* from other state being copied in an effect. This is the other
     * thing effects are for, which its own documentation names: subscribing to an external system. The setState
     * it objects to is `setLoading(true)` inside `load`, and moving that after the first `await` would leave a
     * render where a request is in flight and the UI says it is not.
     */
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetching on mount, not deriving state
    void load()
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      // Abort on unmount as well as on supersede: a section that was navigated away from must not settle
      // state into an unmounted tree.
      inFlight.current?.abort()
    }
    // `load` changes with the section triple, which is exactly when the timer should restart.
  }, [load])

  return { payload, lastSuccessAt, stale, error, loading, failures, refresh: () => void load() }
}
