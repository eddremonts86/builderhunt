// Proves each database role actually carries the timeouts the migration set (plan 55 phase 3).
//
// ## Why connect as each role instead of reading `pg_roles`
//
// `pg_roles.rolconfig` says what was *configured*. What matters is what a session gets, and those differ:
// a `PGOPTIONS` in the environment, a `SET` in a connection's startup packet, or a pooler configured with
// `server_reset_query` can all leave a session running with something other than the role default. Reading
// the catalogue would have certified the intent; connecting as the role certifies the effect.
//
// This is also why it takes the URLs from `DATABASE_*_URL` rather than building its own: those are the
// strings the app actually connects with, including whatever query parameters somebody added to them.
//
// ## The cancellation probe
//
// `SHOW statement_timeout` returning `5s` proves the setting is present. It does not prove PostgreSQL will
// act on it — and that is the only property anybody cares about. So each role also runs a `pg_sleep` past
// its own bound and must be cancelled with SQLSTATE `57014`. A role whose timeout is set but not enforced
// looks identical to a correct one until the day a query hangs.
//
// Usage:
//   node scripts/db/verify-role-timeouts.mjs
//
// Exits 0 when every role passes, 1 otherwise. Prints one line per role either way.
import postgres from 'postgres'

/**
 * The budget, and the reasoning behind each tier.
 *
 * Request-serving roles get 5 s because a request nobody is waiting for any more should not still be holding
 * a backend. The worker gets 30 s because a discovery sweep legitimately runs longer than a page load, and
 * cancelling it at 5 s would turn a working job into a permanent failure. Platform sits between: an operator
 * running a report can wait, but not indefinitely.
 */
const EXPECTED = [
  { env: 'DATABASE_URL', role: 'builderhunt_app', statementTimeout: '5s', idleInTransaction: '10s' },
  { env: 'DATABASE_AUTH_URL', role: 'builderhunt_auth', statementTimeout: '5s', idleInTransaction: '10s' },
  { env: 'DATABASE_CAPABILITY_URL', role: 'builderhunt_capability', statementTimeout: '5s', idleInTransaction: '10s' },
  { env: 'DATABASE_WORKER_URL', role: 'builderhunt_worker', statementTimeout: '30s', idleInTransaction: '30s' },
  { env: 'DATABASE_PLATFORM_URL', role: 'builderhunt_platform', statementTimeout: '15s', idleInTransaction: '10s' },
]

const results = []
const record = (name, pass, detail) => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/**
 * Seconds from a PostgreSQL interval-ish string, for comparison.
 *
 * PostgreSQL normalises `5s` to `5s` but `5000` to `5s` too, and a `SET` of `5000ms` shows as `5s` — so the
 * comparison is on seconds rather than on the literal, and a role configured in milliseconds still passes.
 */
function toSeconds(value) {
  const match = /^(\d+)(ms|s|min)?$/.exec(String(value).trim())
  if (!match) return null
  const amount = Number(match[1])
  switch (match[2]) {
    case 'ms': return amount / 1000
    case 'min': return amount * 60
    default: return amount
  }
}

for (const expected of EXPECTED) {
  const url = process.env[expected.env]
  if (!url) {
    record(expected.role, false, `${expected.env} is unset`)
    continue
  }

  let sql
  try {
    // `prepare: false` because this may later be pointed at a transaction-mode pooler, where named
    // prepared statements do not survive between statements. The same script has to work for both.
    sql = postgres(url, { max: 1, prepare: false, idle_timeout: 5, connect_timeout: 10 })

    const [{ current_user: actualRole }] = await sql`select current_user`
    if (actualRole !== expected.role) {
      // Worth its own failure: a URL pointing at the wrong role would otherwise report that role's
      // timeouts as this one's and look like a configuration success.
      record(expected.role, false, `${expected.env} connects as ${actualRole}`)
      continue
    }

    const [{ statement_timeout: statement }] = await sql.unsafe('show statement_timeout')
    const [{ idle_in_transaction_session_timeout: idle }] = await sql.unsafe('show idle_in_transaction_session_timeout')

    const statementOk = toSeconds(statement) === toSeconds(expected.statementTimeout)
    const idleOk = toSeconds(idle) === toSeconds(expected.idleInTransaction)
    record(
      `${expected.role} statement_timeout`,
      statementOk,
      `expected ${expected.statementTimeout}, got ${statement}`,
    )
    record(
      `${expected.role} idle_in_transaction_session_timeout`,
      idleOk,
      `expected ${expected.idleInTransaction}, got ${idle}`,
    )

    /**
     * The probe that proves enforcement, bounded so a broken timeout costs seconds rather than the run.
     *
     * Sleeps one second past the role's own limit. `57014` is `query_canceled`, which is what PostgreSQL
     * raises when `statement_timeout` fires — matched on the code and not on the message, because the
     * message is localised and a `LANG` in the environment would break a string comparison.
     */
    const budget = toSeconds(expected.statementTimeout) ?? 5
    try {
      await sql.unsafe(`select pg_sleep(${budget + 1})`)
      record(`${expected.role} cancels a query past its budget`, false, 'the sleep completed')
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'none'
      record(`${expected.role} cancels a query past its budget`, code === '57014', `SQLSTATE ${code}`)
    }
  } catch (error) {
    // The message only. postgres.js attaches the connection options to its errors, password included, and
    // this output is meant to be pasteable.
    record(expected.role, false, error instanceof Error ? error.message : 'unknown error')
  } finally {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
  }
}

const failed = results.filter((r) => !r.pass)
console.log('')
console.log(`${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  // Every failure, not the first: a partial list sends an operator round this loop once per role.
  console.error(`\nrole timeouts not as configured:\n${failed.map((f) => `  - ${f.name}: ${f.detail ?? 'failed'}`).join('\n')}\n`)
  process.exit(1)
}
process.exit(0)
