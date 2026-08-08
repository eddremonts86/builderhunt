// The local gate and CI run the same program, or the local gate is not evidence.
//
// `scripts/ci/local-quality.sh` runs on a machine where dotenvx injects `.env` into every child
// process with `override: true`. The GitHub job inherits nothing but its own `env:` block. So a
// value that only `.env` carries makes the app behave one way locally and another way in CI — and
// because the app's habit is to *refuse politely* when a credential is missing (503
// `ai_unconfigured`, 400 `invalid_input`, "CRON_SECRET must be set"), the specs assert against the
// refusal instead of the feature. They fail on CI, pass locally, and read as flake.
//
// That went undetected long enough to accumulate twenty failing specs across nine unrelated files,
// and `pnpm ci:local` certified it green twice while doing so.
//
// ## What this checks
//
// Every key that `.env` sets to a non-empty value, that `src/` actually reads as `env.X`, must
// either appear in the quality job's `env:` block or be listed below with a reason. The reason is
// the point: "CI runs without this" is a decision, and an undocumented one is indistinguishable
// from an oversight — which is exactly what this was.
//
// It does nothing on CI, where there is no `.env` to diverge from.

import { readFileSync, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()

/**
 * Keys CI deliberately runs without, and why.
 *
 * Adding a key here is a claim that the suite still exercises what it is supposed to when the value
 * is absent. If a spec asserts on a feature this key unlocks, the entry is wrong and the key belongs
 * in the workflow instead.
 */
const CI_RUNS_WITHOUT = {
  // ── Third-party credentials CI has no account for ───────────────────────────────────────────
  // The connectors these belong to are exercised against the egress fake, never the real host —
  // `tests/e2e/harness/fakes/egress.ts` blocks the traffic outright.
  GITLAB_TOKEN: 'connector credential; e2e uses the egress fake, never the real API',
  CODEBERG_TOKEN: 'connector credential; e2e uses the egress fake, never the real API',
  REDDIT_CLIENT_ID: 'connector credential; e2e uses the egress fake, never the real API',
  REDDIT_CLIENT_SECRET: 'connector credential; e2e uses the egress fake, never the real API',
  STACKOVERFLOW_API_KEY: 'connector credential; e2e uses the egress fake, never the real API',
  DEEPGRAM_API_KEY: 'transcription vendor; no spec asserts a real transcription',
  RESEND_API_KEY: 'email vendor; delivery is asserted through tests/e2e/harness/fakes/email.ts',
  MISTRAL_API_KEY: 'sensitive-AI vendor; SENSITIVE_AI_ENABLED is off in CI',
  MISTRAL_BASE_URL: 'sensitive-AI vendor; SENSITIVE_AI_ENABLED is off in CI',
  MISTRAL_MODEL: 'sensitive-AI vendor; SENSITIVE_AI_ENABLED is off in CI',
  SENSITIVE_AI_ENABLED: 'off in CI — the EU-region vendor rules need a real Azure/Mistral deployment',
  SENSITIVE_AI_PROVIDER: 'only read when SENSITIVE_AI_ENABLED is true',
  AI_EMBEDDING_URL: 'the embeddings service is a local Ollama container; specs needing it are tagged @requires-embeddings and CI greps them out',
  AI_EMBEDDING_API_KEY: 'see AI_EMBEDDING_URL',
  AI_EMBEDDING_MODEL: 'see AI_EMBEDDING_URL',
  AI_EMBEDDING_DIM: 'see AI_EMBEDDING_URL',
  AI_EMBEDDING_TIMEOUT_MS: 'see AI_EMBEDDING_URL',
  MINIMAX_BASE_URL: 'defaulted in env.ts; the AI path is stubbed by fakes/ai.ts under E2E_MODE',
  MINIMAX_MODEL: 'defaulted in env.ts; the AI path is stubbed by fakes/ai.ts under E2E_MODE',

  // ── Flags each spec sets for itself ─────────────────────────────────────────────────────────
  // Setting these globally would change what `startInterviewHarness`'s flag restore puts back, and
  // at --workers=1 every spec shares the process it puts it back into. The workflow's own comment
  // on SCHEDULING_ENABLED says so.
  INTERVIEW_TRANSCRIPTION_ENABLED: 'set per-spec; needs DEEPGRAM_API_KEY, which CI does not have',
  PROFILE_REMOVAL_ENABLED: 'set per-spec',
  PROFILE_REMOVAL_HMAC_KEY: 'only read when PROFILE_REMOVAL_ENABLED is true, which is per-spec',
  ENRICHMENT_ENABLED: 'set per-spec',

  // ── Supplied by other means in CI ───────────────────────────────────────────────────────────
  REDIS_URL: 'playwright.config.ts defaults it to the redis service on 6379',
  NODE_ENV: 'set by the tooling that runs each step, not by the job',
  ADMIN_USER_IDS: 'seeded per-run by pnpm db:seed:admin, not configured',

  // ── Tuning with defaults that CI has no reason to override ──────────────────────────────────
  AI_DISABLED_TASKS: 'defaulted to empty',
  ENRICHMENT_BATCH_SIZE: 'defaulted',
  ENRICHMENT_LEASE_SECONDS: 'defaulted',
  ENRICHMENT_MAX_ATTEMPTS: 'defaulted',
  ENRICHMENT_USER_AGENT: 'defaulted',
  ENRICHMENT_RAW_RETENTION_DAYS: 'defaulted',
  ENRICHMENT_ACCEPTED_RETENTION_DAYS: 'defaulted',
  STRIPE_API_VERSION: 'defaulted in env.ts',

  // ── Billing ─────────────────────────────────────────────────────────────────────────────────
  // The billing specs drive the fake provider (`src/shared/lib/billing/fake-provider.ts`) and sign
  // their own webhooks; the separate "Stripe sandbox certification" job is what touches real
  // test-mode Stripe, and it carries its own secrets.
  STRIPE_SECRET_KEY: 'the sandbox certification job carries the real test-mode key',
  STRIPE_WEBHOOK_SECRET: 'the sandbox certification job carries the real test-mode key',
}

/**
 * Divergences that cannot be closed, and what each costs.
 *
 * Distinct from CI_RUNS_WITHOUT: these keys are *on* locally and *off* on CI, and no CI-only value
 * fixes that because the feature needs a vendor account the runner has no way to hold. The entry is
 * an admission that one surface is exercised in one place only — so anything asserting on it has to
 * be a unit test or a local-only run, never a spec CI is expected to police.
 */
const DIVERGENCE_ACCEPTED = {
  INTERVIEW_TRANSCRIPTION_ENABLED: 'needs a real Deepgram key; nothing in the CI suite asserts a transcription',
  SENSITIVE_AI_ENABLED: 'needs a real EU Azure/Mistral deployment, which env.ts validates by region',
}

/** The quality job's `env:` block — six-space keys between `quality:` and its `steps:`. */
function workflowEnvKeys() {
  const source = readFileSync(join(root, '.github/workflows/quality.yml'), 'utf8')
  const job = /^ {2}quality:$([\s\S]*?)^ {4}steps:$/m.exec(source)
  if (!job) throw new Error('Could not find the quality job\'s env block in .github/workflows/quality.yml')
  return new Set([...job[1].matchAll(/^ {6}([A-Z_][A-Z0-9_]*):/gm)].map((m) => m[1]))
}

/** Keys `.env` sets to something non-empty. An empty value is not a divergence. */
function dotenvKeys() {
  const source = readFileSync(join(root, '.env'), 'utf8')
  const keys = new Set()
  for (const line of source.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match && match[2].trim() !== '') keys.add(match[1])
  }
  return keys
}

/** Keys the app actually reads. A `.env` line nothing consumes cannot change behaviour. */
async function readKeys() {
  const files = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (/\.tsx?$/.test(entry.name)) files.push(full)
    }
  }
  await walk(join(root, 'src'))
  const keys = new Set()
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\benv\.([A-Z_][A-Z0-9_]*)/g)) keys.add(m[1])
  }
  return keys
}

if (!existsSync(join(root, '.env'))) {
  console.log(JSON.stringify({ skipped: 'no .env — nothing to diverge from' }))
  process.exit(0)
}

/**
 * The default `env.ts` falls back to, per key.
 *
 * Absence is only half the question. A key can be documented as "CI runs without this" and still
 * diverge, because running *without* it means running with the app's default — and if `.env` sets
 * something else, the two environments are configured differently no matter how well the absence is
 * explained. Three flags hid here: `.env` had them `true`, `env.ts` defaults them `false`, and the
 * exemption said "each spec sets it", which turned out to be true of exactly two of the eight keys
 * it claimed. `tests/e2e/harness/load-env.ts` is why nobody noticed — it loads `.env` into the
 * runner, so locally the flags arrive whether or not a spec asks.
 */
function declaredDefaults() {
  const source = readFileSync(join(root, 'src/shared/lib/env.ts'), 'utf8')
  const defaults = new Map()
  for (const m of source.matchAll(/^\s{2}([A-Z_][A-Z0-9_]*):\s*z\.[^\n]*?\.default\((['"])(.*?)\2\)/gm)) {
    defaults.set(m[1], m[3])
  }
  return defaults
}

function dotenvValues() {
  const source = readFileSync(join(root, '.env'), 'utf8')
  const values = new Map()
  for (const line of source.split('\n')) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim())
    if (match) values.set(match[1], match[2].trim())
  }
  return values
}

const workflow = workflowEnvKeys()
const local = dotenvKeys()
const used = await readKeys()
const defaults = declaredDefaults()
const values = dotenvValues()

const gaps = [...local].filter((key) => used.has(key) && !workflow.has(key) && !(key in CI_RUNS_WITHOUT)).sort()

/** Exempted, but `.env` overrides the default CI would run with — so the two still differ. */
const divergent = [...local]
  .filter((key) => used.has(key) && !workflow.has(key) && key in CI_RUNS_WITHOUT)
  .filter((key) => defaults.has(key) && values.get(key) !== defaults.get(key))
  .filter((key) => !(key in DIVERGENCE_ACCEPTED))
  .sort()
const stale = Object.keys(CI_RUNS_WITHOUT).filter((key) => workflow.has(key)).sort()

console.log(JSON.stringify({
  workflowKeys: workflow.size,
  localKeys: local.size,
  readByApp: used.size,
  documentedAbsences: Object.keys(CI_RUNS_WITHOUT).length,
  gaps: gaps.length,
  divergentDefaults: divergent.length,
  acceptedDivergences: Object.keys(DIVERGENCE_ACCEPTED).length,
}))

if (stale.length > 0) {
  console.error(
    `\n${stale.length} key${stale.length === 1 ? '' : 's'} listed as "CI runs without" but now set in the workflow:\n`
    + stale.map((k) => `  - ${k}`).join('\n')
    + '\n\n  Remove them from CI_RUNS_WITHOUT — a stale exemption hides the next real one.\n',
  )
}

if (gaps.length > 0) {
  console.error(
    `\n${gaps.length} key${gaps.length === 1 ? '' : 's'} set in .env, read by the app, and absent from the quality job:\n`,
  )
  for (const key of gaps) console.error(`  - ${key}`)
  console.error(
    '\n  The local gate would run with these and CI without them, so "local is green" would not'
    + '\n  mean CI is. Either add the key to .github/workflows/quality.yml with a CI-only value, or'
    + '\n  add it to CI_RUNS_WITHOUT in this file with the reason the suite is fine without it.\n',
  )
}

if (divergent.length > 0) {
  console.error(`\n${divergent.length} exempted key${divergent.length === 1 ? '' : 's'} whose .env value is not the default CI would run with:\n`)
  for (const key of divergent) {
    console.error(`  - ${key}: .env says ${JSON.stringify(values.get(key))}, env.ts defaults to ${JSON.stringify(defaults.get(key))}`)
  }
  console.error(
    '\n  Being absent from CI is not the same as being off. Either set the key in the workflow so'
    + '\n  both run the same configuration, or change .env to match the default.\n',
  )
}

if (gaps.length > 0 || stale.length > 0 || divergent.length > 0) process.exit(1)
