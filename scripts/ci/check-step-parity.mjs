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
 * Every job in every workflow that checks the product.
 *
 * Twice now a check has escaped this file's attention by moving: the e2e suite into its own sharded
 * job, then the visual, Lighthouse and Stripe jobs into `advisory.yml` entirely. A checker scoped to
 * one job — or one file — reports parity right up until the thing it tracks walks out of scope.
 *
 * `nightly-serial.yml` is deliberately absent: it re-runs the e2e suite unsharded and adds nothing
 * the other two do not already have, so reading it would only duplicate entries.
 */
const CHECKING_WORKFLOWS = ['.github/workflows/quality.yml', '.github/workflows/advisory.yml']

function workflowScripts() {
  const found = new Set()
  for (const file of CHECKING_WORKFLOWS) {
    for (const script of pnpmScripts(readFileSync(join(root, file), 'utf8'))) found.add(script)
  }
  return found
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
  const sources = {
    quality: source,
    advisory: readFileSync(join(root, '.github/workflows/advisory.yml'), 'utf8'),
  }
  const envOf = (job, file) => {
    const block = new RegExp(`^ {2}${job}:$([\\s\\S]*?)^ {4}steps:$`, 'm').exec(sources[file])
    if (!block) return null
    const env = /^ {4}env:$([\s\S]*)$/m.exec(block[1])
    return env ? new Set([...env[1].matchAll(/^ {6}([A-Z_][A-Z0-9_]*):/gm)].map((k) => k[1])) : null
  }
  const quality = envOf('quality', 'quality')
  if (!quality) return []
  const problems = []
  // Every job that boots the app needs the same environment. `advisory.yml`'s visual job was built
  // without one at all, and its dev server died on a ZodError before taking a screenshot — a failure
  // that reads like a visual regression and is a missing env block.
  for (const [file, job] of [['quality', 'e2e'], ['advisory', 'visual'], ['advisory', 'lighthouse']]) {
    const other = envOf(job, file)
    if (!other) continue
    for (const key of quality) if (!other.has(key)) problems.push(`${file}.yml's ${job} job is missing ${key}`)
    for (const key of other) if (!quality.has(key)) problems.push(`${file}.yml's ${job} job has an extra ${key}`)
  }
  return problems
}

const workflow = workflowScripts()
const local = pnpmScripts(readFileSync(join(root, 'scripts/ci/local-quality.sh'), 'utf8'))

const exempt = (script) =>
  Object.keys(RUNNER_PLUMBING).some((prefix) => script === prefix || script.startsWith(`${prefix} `))

/**
 * Any job that drives the worker harness has to build first.
 *
 * `tests/e2e/harness/server.ts` serves `dist/` rather than starting a dev server, so a job that runs
 * the suite without `pnpm build` dies on "no build exists" — which is what the advisory visual job
 * did, and what the nightly run would have done at 03:00 where nobody would have seen it. Three jobs
 * needed this and I added it to two of them by hand.
 */
function jobsMissingABuild() {
  const problems = []
  for (const file of CHECKING_WORKFLOWS.concat('.github/workflows/nightly-serial.yml')) {
    const source = readFileSync(join(root, file), 'utf8')
    // Only inside `jobs:` — an earlier version matched two-space keys anywhere and counted `push:`
    // from the trigger block as a job.
    const section = /^jobs:$([\s\S]*)$/m.exec(source)
    if (!section) continue
    // `$(?![\s\S])` rather than `\Z`, which JavaScript does not have: it was matching a literal Z,
    // so the last job in every file fell outside the split and this check quietly passed.
    for (const m of section[1].matchAll(/^ {2}([a-z][a-z-]*):$([\s\S]*?)(?=^ {2}[a-z][a-z-]*:$|$(?![\s\S]))/gm)) {
      const [, job, body] = m
      if (!/pnpm test:(e2e|visual)\b/.test(body)) continue
      if (/^ +- run: pnpm build$/m.test(body)) continue
      problems.push(`${file.split('/').pop()}'s ${job} job runs the suite without building first`)
    }
  }
  return problems
}

const missingBuilds = jobsMissingABuild()
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
  jobsMissingABuild: missingBuilds.length,
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

if (missingBuilds.length > 0) {
  console.error(`\n${missingBuilds.length} job${missingBuilds.length === 1 ? '' : 's'} running the e2e harness without a build:\n`)
  for (const line of missingBuilds) console.error(`  - ${line}`)
  console.error('\n  The harness serves dist/. Without `pnpm build` the suite dies before its first assertion.\n')
}

if (missing.length > 0 || stale.length > 0 || envDrift.length > 0 || missingBuilds.length > 0) process.exit(1)
