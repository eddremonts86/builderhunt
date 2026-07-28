/**
 * The connection-pool options every role's client shares.
 *
 * ## Why a cap exists at all
 *
 * `postgres.js` defaults to `max: 10`, and this app opens one pool per role — product, auth, worker,
 * platform, capability. That is up to 50 connections per app process, which is fine for one process
 * and is not what the E2E suite runs: Playwright spawns a Vite server per worker, so four workers
 * plus the config's own `webServer` reach 250 against a cluster whose `max_connections` is 200.
 *
 * The symptom is not a clear error. Pools fill lazily, so a run passes until one late request cannot
 * get a connection and fails with `sorry, too many clients already` — which reads as a database
 * problem in whichever test happened to be running, several files away from the cause. This has now
 * happened twice while building the interview suite, both times reaching exactly 197 idle
 * connections.
 *
 * ## Why only in E2E
 *
 * Production runs one process per container and wants the headroom; a lower cap there would queue
 * requests under load for no reason. `E2E_MODE` is set by the harness and refused outright in
 * production (`env.ts`), so it is the honest switch — and `idle_timeout` returns connections that a
 * finished spec file is no longer using rather than holding them for the run's lifetime.
 */
export function poolOptions(): { prepare: false; max?: number; idle_timeout?: number } {
  const isE2E = typeof process !== 'undefined' && process.env.E2E_MODE === 'true'
  // `prepare: false` on every path — the app runs behind a transaction-pooling proxy in production,
  // where prepared statements do not survive between checkouts.
  if (!isE2E) return { prepare: false }
  return { prepare: false, max: 3, idle_timeout: 20 }
}
