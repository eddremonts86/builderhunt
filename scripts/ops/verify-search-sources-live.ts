/**
 * Asks every implemented search connector a real question and reports what came back.
 *
 * ## Why this exists
 *
 * `search_sources.enabled` says an operator wants a source on. `IMPLEMENTED_SEARCH_CONNECTORS` says
 * the code for it exists. **Neither says the source still answers.** That gap is not theoretical: it
 * is exactly how `hashnode` sat enabled for months after its API moved behind a paid plan, returning
 * `[]` to every query — recorded in `docs/operations/public-enrichment-source-register.md#hashnode`
 * as "a source returning `[]` with no key looked identical to a source returning `[]` because the
 * API had closed".
 *
 * `runConnector` cannot close that gap on its own, and deliberately so: a connector that catches its
 * own error and returns `[]` is reported `ok` with zero results, because from the search's point of
 * view "this source found nothing" is a legitimate answer to a narrow query. Only a probe with a
 * keyword known to match can tell the two apart, and that is what this is.
 *
 * ## What it proves and what it does not
 *
 * It contacts the real upstreams through the real `searchBuildersWithStatus` path — the same
 * register lookup, the same allowlist partition, the same per-connector timeout and health
 * accounting the product uses. A row here is the truth about this machine's credentials at this
 * moment.
 *
 * It is **not** a CI gate and must not become one. It spends third-party quota (Stack Exchange
 * allows 300 requests/day per IP without a key), and a source being briefly unreachable is a fact
 * about the internet rather than a defect in this repository. Run it when credentials change, when a
 * source is added or retired, and before claiming that every source works.
 *
 * Usage:
 *   pnpm sources:probe              # every implemented connector
 *   pnpm sources:probe github npm   # only these
 */
import { IMPLEMENTED_SEARCH_CONNECTORS } from '~/shared/lib/search-connectors'
import { searchBuildersWithStatus } from '~/lib/search'
import { CREDENTIAL_ENV_VARS } from '~/shared/lib/source-credentials'
import { env } from '~/shared/lib/env'

/**
 * A keyword each source can plausibly answer, because an empty result from a bad query would be
 * indistinguishable from an empty result from a dead API — the precise confusion this script exists
 * to remove. Stack Overflow gets `react` rather than `reactjs` on purpose: the connector's own
 * `TAG_SYNONYMS` map is what turns one into the other, so the probe covers that too.
 */
const PROBE_KEYWORD: Record<string, string> = {
  github: 'rust',
  hn: 'rust',
  devto: 'react',
  reddit: 'rust',
  lobsters: 'rust',
  stackoverflow: 'react',
  npm: 'react',
  huggingface: 'llama',
  gitlab: 'rust',
  codeberg: 'rust',
  devpost: 'ai',
  producthunt: 'ai',
  bluesky: 'rust',
}

const requested = process.argv.slice(2).filter((argument) => !argument.startsWith('-'))
const targets = requested.length > 0
  ? IMPLEMENTED_SEARCH_CONNECTORS.filter((source) => requested.includes(source))
  : [...IMPLEMENTED_SEARCH_CONNECTORS]

if (targets.length === 0) {
  console.error(`No implemented connector matched ${requested.join(', ')}.`)
  console.error(`Known: ${IMPLEMENTED_SEARCH_CONNECTORS.join(', ')}`)
  process.exit(2)
}

interface Row {
  source: string
  keyword: string
  credential: 'n/a' | 'present' | 'MISSING'
  health: string
  count: number
  ms: number
  detail: string
}

const rows: Row[] = []

for (const source of targets) {
  const keyword = PROBE_KEYWORD[source] ?? 'rust'
  const requiredVars = CREDENTIAL_ENV_VARS[source] ?? []
  const credential = requiredVars.length === 0
    ? 'n/a' as const
    : requiredVars.every((name) => Boolean(env[name])) ? 'present' as const : 'MISSING' as const

  const started = Date.now()
  let health = 'error'
  let count = 0
  let detail: string
  try {
    // One source per call, so each gets its own cache key and no source can be credited with
    // another's rows.
    const outcome = await searchBuildersWithStatus({ keywords: [keyword], sources: [source], perPage: 5 })
    const status = outcome.sources.find((entry) => entry.source === source)
    health = status?.health ?? 'absent'
    count = status?.resultCount ?? 0
    detail = status?.detail ?? ''
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error)
  }

  rows.push({ source, keyword, credential, health, count, ms: Date.now() - started, detail })
}

const pad = (value: string, width: number) => value.padEnd(width)
console.log(`\n${pad('source', 14)}${pad('keyword', 9)}${pad('credential', 12)}${pad('health', 14)}${pad('results', 9)}${pad('ms', 7)}detail`)
console.log('-'.repeat(96))
for (const row of rows) {
  console.log(
    pad(row.source, 14) + pad(row.keyword, 9) + pad(row.credential, 12) + pad(row.health, 14)
    + pad(String(row.count), 9) + pad(String(row.ms), 7) + row.detail,
  )
}

/**
 * A source is only "working" if it returned something. `ok` with zero results against a keyword
 * chosen to match is the hashnode signature, so it counts as a failure here even though the search
 * itself was right to call it `ok`.
 *
 * `unconfigured` is reported separately: the source is enabled and its code is fine, and the only
 * missing piece is a credential this machine does not hold. That is an operator task, not a defect,
 * so it does not fail the run — but it is never silent either.
 */
const unconfigured = rows.filter((row) => row.health === 'unconfigured')
const broken = rows.filter((row) => row.health !== 'unconfigured' && (row.health !== 'ok' || row.count === 0))
const live = rows.filter((row) => row.health === 'ok' && row.count > 0)

console.log(`\n${live.length}/${rows.length} sources returned results.`)
if (unconfigured.length > 0) {
  console.log(`\n${unconfigured.length} not contacted — credential absent on this machine:`)
  for (const row of unconfigured) {
    console.log(`  - ${row.source}: set ${(CREDENTIAL_ENV_VARS[row.source] ?? []).join(' and ')}`)
  }
}
if (broken.length > 0) {
  console.error(`\n${broken.length} source(s) answered nothing:`)
  for (const row of broken) console.error(`  - ${row.source} (${row.health}, ${row.count} results) ${row.detail}`)
  process.exit(1)
}
console.log('Every contacted source answered.')
// Explicit: reaching `~/lib/search` opens a `postgres()` pool and, if configured, a Redis client,
// and neither is unref'd — without this the process sat for ~80 s after printing its report.
process.exit(0)
