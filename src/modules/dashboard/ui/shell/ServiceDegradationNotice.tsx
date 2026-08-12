import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { AlertTriangle } from 'lucide-react'

/**
 * A compact notice when a user-facing dependency is degraded (plan 57, Wave 5 — "Add contextual service
 * degradation only").
 *
 * ## Contextual only, and that is the whole task title
 *
 * There is no permanent widget. Healthy renders `null`, so the dashboard has nothing about service health on it
 * at all until something is wrong — which is what makes the notice mean something when it appears. Worker,
 * integration, trust, billing and platform metrics stay on their Admin pages; this is one line for a tenant who
 * needs to know whether the thing they just tried is broken or whether it is them.
 *
 * ## Why it reads `/api/status/summary` and not `/api/status`
 *
 * `/api/status` answers 503 when degraded, which is right for a monitor and unusable here: a browser writes every
 * non-2xx subresource to the console, so polling it put two console errors on every page load *during an
 * incident*. That is why this task was built and reverted on 2026-08-06. `summary` is the same computation with a
 * 200 and the state in the body.
 *
 * ## Why it polls once and not on a timer
 *
 * One read per mount. The endpoint is cached for thirty seconds and an incident lasts longer than a page view, so
 * a timer would add a dependency probe per session per minute to buy a notice arriving slightly sooner on a page
 * nobody is watching for that. Navigating remounts the shell, which is the natural refresh.
 */

const COMPONENT_LABELS: Record<string, string> = {
  database: 'the database',
  cache: 'caching',
  memory: 'memory pressure on a server',
}

export function ServiceDegradationNotice() {
  const [degraded, setDegraded] = React.useState<string[]>([])

  React.useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/status/summary', { signal: controller.signal })
        if (!response.ok) return
        const body = (await response.json()) as { state: 'ok' | 'degraded' | 'unknown'; degraded: string[] }
        // `unknown` renders nothing: "we could not tell" is not "something is broken", and a banner on a failed
        // check would train people to ignore the banner.
        if (body.state === 'degraded') setDegraded(body.degraded)
      } catch {
        // Silent by design. A failed read of the health summary must not itself look like an incident, and it
        // must not put an error in the console of a page that is working.
      }
    })()
    return () => controller.abort()
  }, [])

  if (degraded.length === 0) return null

  /**
   * The affected components are named, and nothing is claimed about the rest.
   *
   * The Verify line asks that degraded copy "never fabricates a healthy/failed component", and the way to honour
   * that is to list only what the check reported and say nothing about anything else. No "all other systems
   * operational" — that is a claim this endpoint's three checks cannot support.
   */
  return (
    <div
      className="mb-4 flex flex-wrap items-baseline gap-2 rounded-2xl border border-bh-warning/50 bg-bh-warning/5 p-3 text-sm"
      role="status"
      data-testid="service-degradation-notice"
    >
      <AlertTriangle className="size-4 text-bh-warning" aria-hidden />
      <span className="text-bh-text">
        Some parts of BuilderHunt are degraded right now
        {': '}
        {degraded.map((component) => COMPONENT_LABELS[component] ?? component).join(', ')}. Things may be slow or
        fail to save.
      </span>
      <Link to="/status" className="text-bh-accent hover:underline" data-testid="service-degradation-status-link">
        See status
      </Link>
    </div>
  )
}
