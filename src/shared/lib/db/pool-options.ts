/**
 * The connection-pool options each role's client gets, and why they differ (plan 55 phase 2).
 *
 * ## Why a cap exists at all
 *
 * `postgres.js` defaults to `max: 10`, and this app opens one pool per role — runtime, auth, worker,
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
 * ## Why the caps are per role and not one number
 *
 * A single cap has to be large enough for the busiest pool, so every quiet pool gets the same
 * headroom and the process's worst case is five times its real need. The five pools are not
 * remotely alike: `runtime` serves every authenticated page view, while `platform` serves an
 * operator clicking through an admin screen and `capability` serves the public candidate flow. A
 * flat `max: 10` spends 40 connections keeping four idle pools ready for traffic that will not
 * arrive, and those connections are exactly the budget the 1,000-user target needs.
 *
 * The totals are what make this a capacity decision rather than a preference. Summed, these caps are
 * 26 per process — against a PostgreSQL `max_connections` of 120 in the load topology and a
 * PgBouncer `max_db_connections` of 80, that leaves room for the pooler, the migration connection,
 * and a monitor, with the app unable to exhaust the cluster on its own even at four processes.
 *
 * ## Why `application_name` is set here
 *
 * `pg_stat_activity.application_name` is the only way to tell five pools apart from the database
 * side. Without it a capacity problem shows 26 identical rows and no way to know which pool grew;
 * with it, `select application_name, count(*) … group by 1` answers the question directly. It costs
 * one startup parameter and is the difference between an observable pool and a mystery.
 */
export type PoolRole = 'runtime' | 'auth' | 'worker' | 'platform' | 'capability'

export interface PoolOptions {
  prepare: false
  max: number
  idle_timeout: number
  connect_timeout: number
  connection: { application_name: string }
}

/**
 * The caps, with the reason for each size rather than a table of numbers.
 *
 * `runtime` (12) carries every authenticated request, so it is the only pool that needs real
 * concurrency. `auth` (4) is hit once per sign-in and once per session read, both short. `worker` (4)
 * runs sweeps that are long but few, and it is bounded by how many jobs run at once rather than by
 * request volume. `platform` (3) serves operators, of whom there are single digits. `capability` (3)
 * serves the public candidate flow, which is low volume by nature.
 */
const MAX_BY_ROLE: Record<PoolRole, number> = {
  runtime: 12,
  auth: 4,
  worker: 4,
  platform: 3,
  capability: 3,
}

/**
 * Thirty seconds idle, five to connect.
 *
 * The idle timeout returns a connection the app is no longer using instead of holding it for the
 * process's lifetime — which is what turns a quiet pool into a permanent reservation against
 * `max_connections`. Thirty seconds is long enough that a normal request never pays reconnection
 * cost and short enough that a traffic trough gives the budget back.
 *
 * The connect timeout is the one that matters under load. Without it, `postgres.js` waits
 * indefinitely for a connection that a saturated pooler is never going to give, so a request that
 * should shed in five seconds instead holds a Node handle until the client gives up — and the
 * failure arrives as a timeout somewhere upstream rather than as the connection error it is.
 */
const IDLE_TIMEOUT_SECONDS = 30
const CONNECT_TIMEOUT_SECONDS = 5

/** E2E keeps its own small numbers — see the module comment on the 197-connection failure. */
const E2E_MAX = 3
const E2E_IDLE_TIMEOUT_SECONDS = 20

function isE2E(): boolean {
  return typeof process !== 'undefined' && process.env.E2E_MODE === 'true'
}

/**
 * Reads a per-role override, and refuses to guess.
 *
 * `LOAD_POOL_MAX_RUNTIME=abc` is a typo, and the two environments want opposite handling. In
 * production a nonsense pool size is a configuration error that will surface as a capacity incident
 * hours later, so `env.ts` validation fails closed and the process does not start. Locally the same
 * typo should not stop someone working, so it warns and uses the default — visible, and not fatal.
 *
 * Silently accepting `NaN` was never an option: `postgres.js` treats it as unbounded.
 */
function overrideFor(role: PoolRole): number | null {
  const raw = typeof process !== 'undefined' ? process.env[`LOAD_POOL_MAX_${role.toUpperCase()}`] : undefined
  if (raw === undefined || raw === '') return null
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 100) return parsed
  // Production never reaches here: `env.ts` refuses the value at startup.
  console.warn(
    `[db] ignoring LOAD_POOL_MAX_${role.toUpperCase()}=${raw}: expected an integer between 1 and 100, using ${MAX_BY_ROLE[role]}`,
  )
  return null
}

export function poolOptions(role: PoolRole): PoolOptions {
  // `prepare: false` on every path — the app runs behind a transaction-pooling proxy in production,
  // where prepared statements do not survive between checkouts.
  const applicationName = `builderhunt_${role}`
  if (isE2E()) {
    return {
      prepare: false,
      max: E2E_MAX,
      idle_timeout: E2E_IDLE_TIMEOUT_SECONDS,
      connect_timeout: CONNECT_TIMEOUT_SECONDS,
      connection: { application_name: applicationName },
    }
  }
  return {
    prepare: false,
    max: overrideFor(role) ?? MAX_BY_ROLE[role],
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    connection: { application_name: applicationName },
  }
}

/**
 * The sum of every pool's cap, for one process.
 *
 * Exported so a test can assert it against the topology's connection budget rather than restating
 * the numbers — the point of the per-role caps is the total, and a change that raises one cap should
 * have to look at the total it lands in.
 */
export function totalPoolMax(): number {
  return (Object.keys(MAX_BY_ROLE) as PoolRole[]).reduce((sum, role) => sum + poolOptions(role).max, 0)
}

/** Kept next to the caps so `env.ts` and the tests agree on what a valid override is. */
export const POOL_ROLES: readonly PoolRole[] = ['runtime', 'auth', 'worker', 'platform', 'capability']
