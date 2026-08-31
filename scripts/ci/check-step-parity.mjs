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
  vitest: 'the Stripe sandbox certification job, which makes real test-mode API calls and is gated on a repository secret rather than run on every push',
}

/**
 * Lines that could run something, with the commentary removed.
 *
 * Both file kinds here comment with `#`, and every check below searches text for the name of a
 * step. Prose that *names* a step therefore counts as running it — which is not a hypothetical:
 * adding this very script to `quality.yml` with a comment explaining the spelling made the file
 * report `pnpm check:step-parity` as a check the workflow runs and the machine does not. It was
 * reading its own explanation.
 */
function runnable(source) {
  return source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
}

/** `pnpm <script>` invocations inside a shell block, ignoring flags and arguments. */
function pnpmScripts(source) {
  const found = new Set()
  for (const m of runnable(source).matchAll(/\bpnpm\s+((?:exec\s+)?[a-z][a-z0-9:_-]*)/g)) {
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

/**
 * Every workflow that stands the app up and drives a Playwright suite.
 *
 * Wider than CHECKING_WORKFLOWS on purpose. The two above are the ones whose *checks* must exist
 * locally; these two also exist, run the same harness, and have the same two ways of being broken —
 * a missing `pnpm build` and an env block copied by hand. `nightly-serial.yml` is not in
 * CHECKING_WORKFLOWS because it re-runs the e2e suite unsharded and would only duplicate entries;
 * `visual-baselines.yml` is not, because it is dispatch-only and refreshes baselines rather than
 * checking anything. Neither exemption applies to the build and env checks below.
 */
const SUITE_RUNNING_WORKFLOWS = CHECKING_WORKFLOWS.concat(
  '.github/workflows/nightly-serial.yml',
  '.github/workflows/visual-baselines.yml',
)

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
    'visual-baselines': readFileSync(join(root, '.github/workflows/visual-baselines.yml'), 'utf8'),
    'nightly-serial': readFileSync(join(root, '.github/workflows/nightly-serial.yml'), 'utf8'),
  }
  // Keys *and* values. Comparing only the key names leaves the failure this file exists to catch
  // wide open in its quietest form: `SEGMENTED_LANDING_ENABLED: 'true'` in one job and `'false'` in
  // the next is a spec asserting one thing about a build configured for another, and every name
  // lines up while it happens. The five jobs agree on all values today, so this costs nothing to
  // adopt — which is the only moment it is cheap to adopt.
  const envOf = (job, file) => {
    const block = new RegExp(`^ {2}${job}:$([\\s\\S]*?)^ {4}steps:$`, 'm').exec(sources[file])
    if (!block) return null
    const env = /^ {4}env:$([\s\S]*)$/m.exec(block[1])
    if (!env) return null
    return new Map([...env[1].matchAll(/^ {6}([A-Z_][A-Z0-9_]*): *(.*)$/gm)].map((m) => [m[1], m[2].trim()]))
  }
  const quality = envOf('quality', 'quality')
  if (!quality) return []
  const problems = []
  // Every job that boots the app needs the same environment. `advisory.yml`'s visual job was built
  // without one at all, and its dev server died on a ZodError before taking a screenshot — a failure
  // that reads like a visual regression and is a missing env block.
  for (const [file, job] of [
    ['quality', 'e2e'],
    ['advisory', 'visual'],
    ['advisory', 'lighthouse'],
    // Dispatch-only, and the one place a hand-copied env block is *least* likely to be noticed: it
    // runs when someone changes the UI, months apart, and a missing key there produces a rewritten
    // baseline of an error page rather than a failure.
    ['visual-baselines', 'baselines'],
    // Absent from CHECKING_WORKFLOWS, present here, and the comment above SUITE_RUNNING_WORKFLOWS
    // has always said so — but this loop did not read the file, so for months it was a claim rather
    // than a check. The block had drifted sixteen keys behind, and the serial suite failed three
    // nights in a row looking for a sign-up CTA that `SEGMENTED_LANDING_ENABLED` gates. Not running
    // the same *checks* as quality is a deliberate exemption; not running them in the same
    // *environment* was never one.
    ['nightly-serial', 'serial'],
  ]) {
    const other = envOf(job, file)
    if (!other) continue
    for (const key of quality.keys()) if (!other.has(key)) problems.push(`${file}.yml's ${job} job is missing ${key}`)
    for (const key of other.keys()) if (!quality.has(key)) problems.push(`${file}.yml's ${job} job has an extra ${key}`)
    for (const [key, value] of quality) {
      if (!other.has(key) || other.get(key) === value) continue
      problems.push(`${file}.yml's ${job} job sets ${key} to ${other.get(key)}, quality.yml sets ${value}`)
    }
  }
  return problems
}

const workflow = workflowScripts()
const local = pnpmScripts(readFileSync(join(root, 'scripts/ci/local-quality.sh'), 'utf8'))

const exempt = (script) =>
  Object.keys(RUNNER_PLUMBING).some((prefix) => script === prefix || script.startsWith(`${prefix} `))

/**
 * Every `job: body` pair inside a workflow's `jobs:` block.
 *
 * Two regex bugs have lived in this splitter, and both of them made a check pass by seeing nothing.
 * The first was `\Z`, which JavaScript does not have — it matched a literal Z, so the last job in
 * every file fell outside the split.
 *
 * The second is why this is now one function instead of a pattern retyped per check: the job name
 * was `[a-z][a-z-]*`, with no digits. `quality.yml`'s job is called **`e2e`**. It never matched, so
 * the split ran straight through it and its whole body was read as part of `unit`'s — and every
 * check here has therefore been judging the repository's largest suite-running job by whichever
 * steps happened to sit above it. `jobsMissingABuild` reported parity for a job it had never seen.
 */
function jobsIn(source) {
  const section = /^jobs:$([\s\S]*)$/m.exec(source)
  if (!section) return []
  const JOB = /^ {2}([a-z][a-z0-9_-]*):$([\s\S]*?)(?=^ {2}[a-z][a-z0-9_-]*:$|$(?![\s\S]))/gm
  return [...section[1].matchAll(JOB)].map((m) => [m[1], m[2]])
}

/**
 * The steps that put tables in the database the *shared* server answers from.
 *
 * Every suite-running job stands up one `vite dev` from `playwright.config.ts` alongside the
 * per-worker servers, and that one connects to the job's own `builderhunt_security_test_ci`. The
 * harness migrates its disposable databases itself; nothing migrates that one except these steps.
 *
 * `visual-baselines.yml` carries a long comment about what a job with an empty database produces —
 * a dashboard with a 650 px hole where seven widgets belong, screenshotted twice, stable both
 * times. It describes that as the reason *it* needed these steps, and states that `advisory.yml`'s
 * visual job already ran them. It did not. Neither did `quality.yml`'s e2e job, whose every shard
 * logged eleven `relation "event_participants" does not exist`, nor the nightly.
 *
 * Which is the whole argument for checking it here rather than writing it down again: a claim in a
 * comment about another file is not a check, and this one was wrong for as long as it existed.
 */
const DATABASE_PREPARATION = [
  'pnpm test:migrations:local',
  'scripts/db/prepare-rls-fixture.mjs',
  'drizzle-kit migrate',
  'pnpm db:seed:admin',
]

function jobsMissingDatabasePreparation() {
  const problems = []
  for (const file of SUITE_RUNNING_WORKFLOWS) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const [job, body] of jobsIn(source)) {
      if (!/pnpm test:(e2e|visual)\b/.test(body)) continue
      // The same reason `runnable` exists at all: the block explaining *why* `drizzle-kit migrate` is
      // needed contains the words `drizzle-kit migrate`, so a substring search over the raw body was
      // satisfied by the prose, and deleting the step it describes left this check green.
      const steps = runnable(body)
      for (const step of DATABASE_PREPARATION) {
        if (!steps.includes(step)) {
          problems.push(`${file.split('/').pop()}'s ${job} job runs the suite without \`${step}\``)
        }
      }
    }
  }
  return problems
}

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
  for (const file of SUITE_RUNNING_WORKFLOWS) {
    const source = readFileSync(join(root, file), 'utf8')
    for (const [job, body] of jobsIn(source)) {
      if (!/pnpm test:(e2e|visual)\b/.test(body)) continue
      if (/^ +- run: pnpm build$/m.test(body)) continue
      problems.push(`${file.split('/').pop()}'s ${job} job runs the suite without building first`)
    }
  }
  return problems
}

const missingBuilds = jobsMissingABuild()
const missingDatabase = jobsMissingDatabasePreparation()
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
  jobsMissingDatabasePreparation: missingDatabase.length,
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

if (missingDatabase.length > 0) {
  console.error(
    `\n${missingDatabase.length} missing database-preparation step${missingDatabase.length === 1 ? '' : 's'}:\n`,
  )
  for (const line of missingDatabase) console.error(`  - ${line}`)
  console.error(
    '\n  The per-worker harness migrates its own disposable databases; the shared `vite dev` from'
    + '\n  playwright.config.ts answers from the job\'s own database and nothing else migrates it.'
    + '\n  A job without these serves a schemaless database to whichever specs use that server —'
    + '\n  and a page that renders nothing renders it consistently, so a baseline taken there passes.\n',
  )
}

if (
  missing.length > 0
  || stale.length > 0
  || envDrift.length > 0
  || missingBuilds.length > 0
  || missingDatabase.length > 0
) process.exit(1)
