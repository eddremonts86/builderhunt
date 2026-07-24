import * as React from 'react'

/**
 * Attribute set on `<html>` once React has hydrated the client tree.
 *
 * The E2E harness (`e2e/harness/browser.ts`) waits for
 * `html[data-hydrated="true"]` instead of fixed delays: TanStack Start
 * ships server-rendered HTML first and hydrates React on top of it, and
 * interacting with a form before hydration attaches input to a
 * pre-hydration DOM whose value never reaches React state. Because this
 * marker is written from a `useEffect` — which React only flushes after
 * the hydration commit — its presence *is* the "React is live" signal,
 * not a proxy for it.
 */
export const HYDRATED_ATTRIBUTE = 'data-hydrated'

/**
 * Invisible, production-safe hydration marker.
 *
 * Renders nothing (server and client), changes no visible behavior, and
 * costs one attribute write after hydration. Mounted once in
 * `src/routes/-root-components.tsx`.
 */
export function HydrationSignal() {
  React.useEffect(() => {
    document.documentElement.setAttribute(HYDRATED_ATTRIBUTE, 'true')
    return () => {
      document.documentElement.removeAttribute(HYDRATED_ATTRIBUTE)
    }
  }, [])
  return null
}
