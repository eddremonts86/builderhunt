// Every row collection on screen is accounted for, governed by one of two primitives, and no
// BuilderHunt-owned SQL list route pages by number.
//
// Phase 3 replaced nineteen hand-built lists with one shell. This gate is what stops the twentieth
// from being hand-built again — what stops a migrated surface from quietly regrowing an offset
// pager, which is the specific regression the whole phase exists to remove — and, since plan 14,
// what stops a surface from inventing its own table *look* while passing everything else.
//
// The classification rules live in `scripts/lib/table-surfaces.mjs` and are tested against source
// text in `tests/unit/scripts/lib/table-surfaces.test.ts`. This file is the sweep: it decides which
// files to read and prints the ledger.
//
// ## An adoption ledger, not a file count
//
// The first version reported one record per source file. That is the wrong unit in three ways at
// once, and each of them was live when it was replaced:
//
//   - `TeamSettingsPage.tsx`, `IntegrationsPage.tsx` and `OperationsPage.tsx` each render **two**
//     `<DataTable>`s. A file count said 17 where the honest answer was 20.
//   - `DataTable.tsx` and `OperationsPage.tsx` matched `<table>` on the strength of the word
//     appearing inside a *prose comment*. Two of the "23 table-bearing files" were sentences.
//   - "a file has a table" cannot distinguish an interactive grid from an email's inline markup,
//     so an exemption written for one silently covered the other.
//
// So the unit is the instance, and every instance is classified.
//
// ## Four checks
//
// **1. Every surface is declared.** A file that renders a table instance carries exactly one marker:
//
//   // table-surface: sprintsCapability          — a data grid, served by that registered capability
//   // table-surface-bounded: <reason>           — a grid whose whole set arrives in one bounded read
//   // table-surface-semantic: <reason>          — a visible native table, through SemanticTable
//   // table-surface-sr-only: <reason>           — a screen-reader equivalent of a chart, no visible chrome
//   // table-surface-email: <reason>             — HTML email output, outside the app's visual system
//   // table-surface-ok: <reason>                — the shell's own internals
//
// The first is checked against `shared/lib/table/capabilities/index.ts`'s exports, so a typo or a
// capability that was never registered fails here rather than at request time. The rest need a
// non-empty reason: an exemption without one is a gap wearing an exemption's clothes.
//
// `table-surface-bounded` is not a loophole. It is the honest state of a grid over a model-bounded
// set — the blog library reads the filesystem, the changelog is one row per release — where a
// capability would exist only to satisfy this script. What it claims is that there is no cursor
// because there is no second page, and `check-unbounded-reads.mjs` is what keeps that true.
//
// **2. No ungoverned table primitive.** A visible `<table>` element may only be written inside
// `SemanticTable.tsx`. Anywhere else it is a surface about to grow its own header ink, its own
// border and its own density — which is exactly what the five migrated raw tables had each done.
// The two exceptions are declared and narrow: a `.sr-only` table (nobody can see it, so the visual
// system has nothing to say about it) and `lib/email.ts` (email clients strip stylesheets and need
// inline compatibility styles).
//
// **3. No local table visual literals.** Two rules, each scoped to where the failure actually
// happens. Nothing under `shared/components/table/` may name a colour — the shell reads `--tbl-*`
// and nothing else. And no `<DataTable>`/`<SemanticTable>` call site may pass a `className` that
// paints or pads: layout from the outside is fine (`mb-8`, `flex-1`), restyling the table from the
// outside is the thing plan phase-3/14 removed.
//
// **4. No page-number pagination in a SQL list route.** `?page=`/`?perPage=`/`?offset=` in a route
// under `src/routes/api/` is the shape plan 03 replaced with keyset cursors: it repeats and drops rows
// whenever the underlying set changes between two requests. Allowed only where the backend genuinely
// offers nothing better — the federated search adapter and the source connectors, which page third
// party APIs by number because that is the only thing those APIs expose.

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { analyzeSource, summarize } from './lib/table-surfaces.mjs'

const root = process.cwd()

/**
 * **Position**, as it appears in a route — never size.
 *
 * `page` and `offset` say *where* in a set to resume, and that is the shape plan 03 replaced with
 * keyset cursors: an offset repeats and drops rows when the set changes between two requests.
 *
 * `perPage` and `limit` say *how many*, and the phase's own rule is that a client may ask for fewer
 * and a larger value is clamped rather than honoured (`TABLE_PAGE_SIZE`). The first version of this
 * pattern rejected `perPage` too, which forbade one spelling of "how many" while `PageRequest.limit`
 * — the contract's own — sailed through, and it broke the onboarding journey's six-row search preview.
 *
 * Matched against the *request* side only. A `page` variable used internally is not the problem;
 * handing the client the offset is.
 */
const PAGE_PARAM = /(?:searchParams\.get\(['"](?:page|offset)['"]\)|['"](?:page|offset)['"]\s*:\s*z\.|\bbody\.(?:page|offset)\b|\{[^}]*\b(?:page|offset)\b[^}]*\}\s*=\s*body)/

/**
 * Where numeric provider paging is legitimate.
 *
 * `lib/search.ts` and `lib/sources/*` page third-party APIs, which expose page numbers and nothing
 * else — plan 11's continuation wraps them so the *public* contract is a signed cursor while the
 * provider call underneath stays numeric. `search-continuation.ts` is that wrapper.
 */
const PROVIDER_PAGING_ALLOWED = [
  'src/lib/search.ts',
  'src/lib/search-continuation.ts',
  'src/lib/sources/',
  'src/lib/semantic/',
]

async function collect(dir, predicate, acc = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collect(full, predicate, acc)
      continue
    }
    if (!entry.isFile()) continue
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
    if (predicate(entry.name)) acc.push(full)
  }
  return acc
}

const rel = (absolute) => relative(root, absolute).split(sep).join('/')

/** Capability export names, from the barrel every capability has to be listed in. */
async function registeredCapabilities() {
  const source = await readFile(join(root, 'src/shared/lib/table/capabilities/index.ts'), 'utf8')
  return new Set([...source.matchAll(/\b(\w+Capability)\b/g)].map((match) => match[1]))
}

const failures = []

const capabilities = await registeredCapabilities()
if (capabilities.size === 0) {
  // The barrel is load-bearing: a sweep over an empty registry reports a green guard over nothing,
  // which is the failure `capability-index.test.ts` already had to be written around once.
  failures.push('src/shared/lib/table/capabilities/index.ts exports no capability — the registry is empty')
}

// `.ts` as well as `.tsx`: `lib/email.ts` renders a `<table>` in a template literal, and a gate that
// cannot see it cannot record its exemption either.
const surfaceFiles = await collect(join(root, 'src'), (name) => /\.tsx?$/.test(name))

/** One record per table-bearing file, each carrying its own instance counts. */
const records = []

for (const absolute of surfaceFiles) {
  const path = rel(absolute)
  const text = await readFile(absolute, 'utf8')
  const record = analyzeSource({ path, text, capabilities })
  if (record === null) continue
  for (const problem of record.problems) failures.push(problem.message)
  records.push(record)
}

// ── Page-number pagination in a route ────────────────────────────────────────────────────────────
const routeFiles = await collect(join(root, 'src/routes'), (name) => /\.tsx?$/.test(name))
for (const absolute of routeFiles) {
  const path = rel(absolute)
  if (!path.startsWith('src/routes/api/')) continue
  if (PROVIDER_PAGING_ALLOWED.some((allowed) => path.startsWith(allowed))) continue
  const source = await readFile(absolute, 'utf8')
  if (!PAGE_PARAM.test(source)) continue
  failures.push(
    `${path} accepts page-number pagination from the client. Phase 3 replaced that with a signed\n`
    + '      keyset cursor (shared/lib/table/keyset.ts) because an offset repeats and drops rows when the\n'
    + '      set changes between two requests. A federated backend that offers nothing better belongs\n'
    + '      behind src/lib/search-continuation.ts.',
  )
}

console.log(JSON.stringify({ ...summarize(records), registered: capabilities.size }))

if (failures.length > 0) {
  console.error(`\n${failures.length} table-surface problem${failures.length === 1 ? '' : 's'}:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('')
  process.exit(1)
}
