// Every check GitHub runs, this machine runs too.
//
// The quality workflow now fires only on a push to master. Nothing guards a feature branch except
// `pnpm ci:local` via the pre-push hook, so the local gate is no longer a convenience — it is the
// gate. A check that exists in `.github/workflows/quality.yml` and not in
// `scripts/ci/local-quality.sh` is therefore a hole with no net under it.
//
// That was not hypothetical. `pnpm test:status-trust` ran only on CI, CI had not reached it in
// months because e2e failed ahead of it, and the first time it did run it found every `/admin/*`
// route redirecting because ADMIN_USER_IDS was never set. Two gates, both quiet, agreeing about
// nothing. This file exists so the next such step cannot go unnoticed for months.
//
// ## What it compares
//
// Every `pnpm <script>` the quality job invokes must also appear in the local runner, unless it is
// listed below as runner plumbing — installing a Postgres client, provisioning fixtures, waiting on
// a health endpoint. Those differ by construction: the runner builds a machine, this script uses
// one that already exists.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

/**
 * Scripts the workflow runs that the local gate legitimately does not, and why.
 *
 * The bar is "this provisions the runner", not "this is inconvenient locally". A product check that
 * is slow or needs a container belongs in the local gate with the container, not here.
 */
const RUNNER_PLUMBING = {
  install: 'installs dependencies; a developer already has node_modules',
  'exec playwright': 'installs browsers into a fresh runner image',
  vitest: 'the Stripe sandbox certification job, which makes real test-mode API calls and is gated on a repository secret rather than run on every push',
}

/** `pnpm <script>` invocations inside a shell block, ignoring flags and arguments. */
function pnpmScripts(source) {
  const found = new Set()
  for (const m of source.matchAll(/\bpnpm\s+((?:exec\s+)?[a-z][a-z0-9:_-]*)/g)) {
    found.add(m[1].replace(/\s+/g, ' '))
  }
  return found
}

/**
 * Every job in the workflow, not just `quality`.
 *
 * The e2e suite moved into its own sharded job, and a checker that only read `quality` would have
 * stopped seeing the single most expensive check in the file — reporting parity while the thing it
 * exists to track had walked out of scope.
 */
function workflowScripts() {
  return pnpmScripts(readFileSync(join(root, '.github/workflows/quality.yml'), 'utf8'))
}

/**
 * The sharded e2e job carries its own copy of the job env, because Actions has no way to share one
 * between jobs. Two copies drift, and `check-env-fidelity.mjs` only reads the first — so it would
 * keep certifying an env block the e2e suite no longer runs with.
 */
function envBlocksAgree() {
  const source = readFileSync(join(root, '.github/workflows/quality.yml'), 'utf8')
  // Only the two jobs that boot the app. The Stripe certification job carries a deliberately
  // different env — comparing every block in the file reported 38 differences, all of them correct
  // and none of them a problem, which is the shape of a check nobody will keep.
  const envOf = (job) => {
    const block = new RegExp(`^ {2}${job}:$([\\s\\S]*?)^ {4}steps:$`, 'm').exec(source)
    if (!block) return null
    const env = /^ {4}env:$([\s\S]*)$/m.exec(block[1])
    return env ? new Set([...env[1].matchAll(/^ {6}([A-Z_][A-Z0-9_]*):/gm)].map((k) => k[1])) : null
  }
  const quality = envOf('quality')
  const e2e = envOf('e2e')
  if (!quality || !e2e) return []
  const problems = []
  for (const key of quality) if (!e2e.has(key)) problems.push(`the e2e job is missing ${key}`)
  for (const key of e2e) if (!quality.has(key)) problems.push(`the e2e job has an extra ${key}`)
  return problems
}

const workflow = workflowScripts()
const local = pnpmScripts(readFileSync(join(root, 'scripts/ci/local-quality.sh'), 'utf8'))

const exempt = (script) =>
  Object.keys(RUNNER_PLUMBING).some((prefix) => script === prefix || script.startsWith(`${prefix} `))

const envDrift = envBlocksAgree()
const missing = [...workflow].filter((script) => !local.has(script) && !exempt(script)).sort()
const stale = Object.keys(RUNNER_PLUMBING).filter(
  (prefix) => ![...workflow].some((s) => s === prefix || s.startsWith(`${prefix} `)),
).sort()

console.log(JSON.stringify({
  workflowScripts: workflow.size,
  localScripts: local.size,
  plumbingExempt: Object.keys(RUNNER_PLUMBING).length,
  missingLocally: missing.length,
  envBlocksDrifted: envDrift.length,
}))

if (stale.length > 0) {
  console.error(
    `\n${stale.length} plumbing exemption${stale.length === 1 ? '' : 's'} naming a script the workflow no longer runs:\n`
    + stale.map((s) => `  - ${s}`).join('\n')
    + '\n\n  Remove them — a dead exemption is one more line nobody rereads.\n',
  )
}

if (missing.length > 0) {
  console.error(`\n${missing.length} check${missing.length === 1 ? '' : 's'} GitHub runs that this machine does not:\n`)
  for (const script of missing) console.error(`  - pnpm ${script}`)
  console.error(
    '\n  Since the workflow only fires on a push to master, a branch is guarded by this script and'
    + '\n  nothing else. Add the step to scripts/ci/local-quality.sh, or add it to RUNNER_PLUMBING'
    + '\n  here with the reason it provisions the runner rather than checking the product.\n',
  )
}

if (envDrift.length > 0) {
  console.error(`\n${envDrift.length} difference${envDrift.length === 1 ? '' : 's'} between the workflow's env blocks:\n`)
  for (const line of envDrift) console.error(`  - ${line}`)
  console.error('\n  Actions cannot share an env block between jobs, so the copies have to be kept identical by hand.\n')
}

if (missing.length > 0 || stale.length > 0 || envDrift.length > 0) process.exit(1)
