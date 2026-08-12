// Every Drizzle list read in src/ must declare a bound. Phase 3 names three: a keyset **page**, a
// **model-bounded** `.limit(n)` whose ceiling the data model fixes, or a chunked **batch** loop for
// reads that must cover every row. This script finds the ones that declare none.
//
// It is a **gate** since plan 13: a non-zero exit for any read that declares no bound. The escape
// hatch is `// unbounded-read-ok: <reason>` above the read, so an exception is visible in the diff
// rather than folded into a baseline number.
//
// The analysis lives in `scripts/lib/unbounded-reads.mjs`, where it is unit-tested against source
// strings. Read the header there for why it parses rather than matching text, and for the one blind
// spot that remains.
//
// Usage:
//   node scripts/check-unbounded-reads.mjs                      # the JSON summary
//   node scripts/check-unbounded-reads.mjs --list               # one `path:line scope` per read
//   node scripts/check-unbounded-reads.mjs --list --aggregates   # also aggregate and exempt reads
//   node scripts/check-unbounded-reads.mjs --json               # every entry, machine-readable
import { execFileSync } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { analyzeSource, MIGHT_CONTAIN_READ } from './lib/unbounded-reads.mjs'

const root = process.cwd()
const srcRoot = join(root, 'src')

const args = new Set(process.argv.slice(2))
const wantList = args.has('--list')
const wantAggregates = args.has('--aggregates')
const wantJson = args.has('--json')

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)))
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.tsx?$/.test(entry.name)) continue
    // Colocated tests are out of scope: a fixture that reads every row of a five-row table is not
    // an incident.
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
    files.push(full)
  }
  return files
}

const files = await collectSourceFiles(srcRoot)
const unbounded = []
const aggregates = []
const exempted = []

for (const absolutePath of files) {
  const text = await readFile(absolutePath, 'utf8')
  if (!MIGHT_CONTAIN_READ.test(text)) continue
  const path = relative(root, absolutePath).split(sep).join('/')
  const result = analyzeSource({ path, text })
  unbounded.push(...result.unbounded)
  aggregates.push(...result.aggregates)
  exempted.push(...result.exempted)
}

const byPath = (a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path))

/**
 * The commit the counts describe, so a recorded classification can be re-derived rather than trusted.
 * `null` outside a checkout — the number is still valid, it just has nothing to be pinned to.
 */
function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

if (wantJson) {
  console.log(JSON.stringify({ commit: currentCommit(), unbounded, aggregates, exempted }, null, 2))
} else {
  if (wantList) {
    for (const entry of unbounded.sort(byPath)) {
      console.log(
        `${entry.path}:${entry.line} ${entry.name} (${entry.kind}${entry.exported ? ', exported' : ''})`,
      )
    }
    if (wantAggregates) {
      console.log('\n--- aggregates (exempt by nature) ---')
      for (const entry of aggregates.sort(byPath)) {
        console.log(`${entry.path}:${entry.line} ${entry.name}`)
      }
      console.log('\n--- exempted (unbounded-read-ok) ---')
      for (const entry of exempted.sort(byPath)) {
        console.log(`${entry.path}:${entry.line} ${entry.name} — ${entry.reason}`)
      }
    }
    console.log('')
  }

  console.log(
    JSON.stringify({
      commit: currentCommit(),
      unbounded: unbounded.length,
      aggregates: aggregates.length,
      exempted: exempted.length,
    }),
  )
}

/*
 * A gate since plan 13, and deliberately not "above a committed baseline".
 *
 * A baseline is a number someone raises. Phase 3 took this from 93 to 0, and the whole point of
 * arriving at zero is that the next unbounded read is a build failure rather than a slightly larger
 * number in a file nobody reads. The escape hatch is per-read and visible in review:
 *
 *   // unbounded-read-ok: <why this read cannot be bounded>
 *
 * — which forces the reason into the diff instead of into a total.
 */
if (unbounded.length > 0) {
  console.error(
    `\n${unbounded.length} unbounded read${unbounded.length === 1 ? '' : 's'}. Every list read must declare a bound:\n`
    + '  - a keyset page (shared/lib/table/keyset.ts) for anything a person looks at,\n'
    + '  - a model-bounded .limit(n) whose ceiling comes from a source of truth, with a comment saying which,\n'
    + '  - a named ceiling from shared/lib/db/read-bounds.ts, if the surface renders the set whole,\n'
    + '  - a chunked batch loop (drainSweep, drainWorkerOrganizations) if the caller needs every row.\n\n'
    + 'Run with --list to see them. A read that genuinely cannot be bounded takes\n'
    + '`// unbounded-read-ok: <reason>` on the line above it.\n',
  )
  process.exit(1)
}
process.exit(0)
