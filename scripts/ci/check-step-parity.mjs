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
}

/** `pnpm <script>` invocations inside a shell block, ignoring flags and arguments. */
function pnpmScripts(source) {
  const found = new Set()
  for (const m of source.matchAll(/\bpnpm\s+((?:exec\s+)?[a-z][a-z0-9:_-]*)/g)) {
    found.add(m[1].replace(/\s+/g, ' '))
  }
  return found
}

function workflowScripts() {
  const source = readFileSync(join(root, '.github/workflows/quality.yml'), 'utf8')
  const job = /^ {2}quality:$([\s\S]*?)(?=^ {2}[a-z][a-z-]*:$)/m.exec(source)
  if (!job) throw new Error('Could not isolate the quality job in .github/workflows/quality.yml')
  return pnpmScripts(job[1])
}

const workflow = workflowScripts()
const local = pnpmScripts(readFileSync(join(root, 'scripts/ci/local-quality.sh'), 'utf8'))

const exempt = (script) =>
  Object.keys(RUNNER_PLUMBING).some((prefix) => script === prefix || script.startsWith(`${prefix} `))

const missing = [...workflow].filter((script) => !local.has(script) && !exempt(script)).sort()
const stale = Object.keys(RUNNER_PLUMBING).filter(
  (prefix) => ![...workflow].some((s) => s === prefix || s.startsWith(`${prefix} `)),
).sort()

console.log(JSON.stringify({
  workflowScripts: workflow.size,
  localScripts: local.size,
  plumbingExempt: Object.keys(RUNNER_PLUMBING).length,
  missingLocally: missing.length,
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

if (missing.length > 0 || stale.length > 0) process.exit(1)
