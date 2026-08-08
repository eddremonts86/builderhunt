// Every row collection on screen is accounted for, and no BuilderHunt-owned SQL list route pages by
// number.
//
// Phase 3 replaced nineteen hand-built lists with one shell. This gate is what stops the twentieth
// from being hand-built again — and what stops a migrated surface from quietly regrowing an
// offset pager, which is the specific regression the whole phase exists to remove.
//
// ## Two checks
//
// **1. Every surface is declared.** A file that renders `<DataTable` or a `<table` carries exactly one
// marker on any line:
//
//   // table-surface: sprintsCapability          — a data grid, served by that registered capability
//   // table-surface-bounded: <reason>           — a grid whose whole set arrives in one bounded read
//   // table-surface-ok: <reason>                — not a data grid: prose, a chart, an email, markup
//
// The first is checked against `shared/lib/table/capabilities/index.ts`'s exports, so a typo or a
// capability that was never registered fails here rather than at request time. The other two need a
// non-empty reason: an exemption without one is a gap wearing an exemption's clothes.
//
// `table-surface-bounded` is not a loophole. It is the honest state of a grid over a model-bounded
// set — the blog library reads the filesystem, the changelog is one row per release — where a
// capability would exist only to satisfy this script. What it claims is that there is no cursor
// because there is no second page, and `check-unbounded-reads.mjs` is what keeps that true.
//
// **2. No page-number pagination in a SQL list route.** `?page=`/`?perPage=`/`?offset=` in a route
// under `src/routes/api/` is the shape plan 03 replaced with keyset cursors: it repeats and drops rows
// whenever the underlying set changes between two requests. Allowed only where the backend genuinely
// offers nothing better — the federated search adapter and the source connectors, which page third
// party APIs by number because that is the only thing those APIs expose.

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const root = process.cwd()

const MARKERS = {
  capability: /\/\/\s*table-surface:\s*(\w+)/,
  bounded: /\/\/\s*table-surface-bounded:\s*(\S.*)$/m,
  exempt: /\/\/\s*table-surface-ok:\s*(\S.*)$/m,
}

/** What makes a file a surface this gate cares about. */
const RENDERS_GRID = /<DataTable\b/
const RENDERS_TABLE = /<table[\s>]/

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

const surfaceFiles = await collect(join(root, 'src'), (name) => name.endsWith('.tsx'))
const surfaces = []

for (const absolute of surfaceFiles) {
  const path = rel(absolute)
  const source = await readFile(absolute, 'utf8')
  const isGrid = RENDERS_GRID.test(source)
  const isTable = RENDERS_TABLE.test(source)
  if (!isGrid && !isTable) continue

  const capability = MARKERS.capability.exec(source)
  const bounded = MARKERS.bounded.exec(source)
  const exempt = MARKERS.exempt.exec(source)
  const declared = [capability, bounded, exempt].filter(Boolean)

  if (declared.length === 0) {
    failures.push(
      `${path} renders ${isGrid ? '<DataTable>' : 'a <table>'} with no marker. Add one of:\n`
      + '      // table-surface: <someCapability>        (a data grid served by a registered capability)\n'
      + '      // table-surface-bounded: <reason>        (the whole set arrives in one bounded read)\n'
      + '      // table-surface-ok: <reason>             (not a data grid — prose, a chart, an email)',
    )
    continue
  }
  if (declared.length > 1) {
    failures.push(`${path} carries more than one table-surface marker — a surface is one of the three, not two`)
    continue
  }

  if (capability) {
    const name = capability[1]
    if (!capabilities.has(name)) {
      failures.push(
        `${path} names capability "${name}", which is not exported from `
        + 'src/shared/lib/table/capabilities/index.ts',
      )
    }
    surfaces.push({ path, kind: 'capability', detail: name })
    continue
  }
  surfaces.push({ path, kind: bounded ? 'bounded' : 'exempt', detail: (bounded ?? exempt)[1].trim() })
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

const byKind = (kind) => surfaces.filter((surface) => surface.kind === kind).length
console.log(JSON.stringify({
  surfaces: surfaces.length,
  capabilities: byKind('capability'),
  bounded: byKind('bounded'),
  exempted: byKind('exempt'),
  registered: capabilities.size,
}))

if (failures.length > 0) {
  console.error(`\n${failures.length} table-surface problem${failures.length === 1 ? '' : 's'}:\n`)
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('')
  process.exit(1)
}
