#!/usr/bin/env node
/**
 * Every API route is either covered by an end-to-end spec or has a written reason why not.
 *
 * ## Why a manifest and not just "write more tests"
 *
 * The nine tasks before this one added roughly a thousand assertions across the API surface. None of that
 * stops the *next* route from shipping with no coverage at all, because nothing fails when a new file appears
 * under `src/routes/api/`. Coverage that depends on remembering is coverage that decays, and it decays
 * silently — the suite stays green the whole time.
 *
 * So the manifest inverts the default. A new route is `missing` until someone either points at a spec or
 * writes down why one is not needed, and `missing` exits non-zero. The cost of adding a route now includes
 * one line of thought about how it is proven.
 *
 * ## What "covered" means here, honestly
 *
 * A route counts as covered when some spec under `tests/e2e/` contains its path as a literal string. That is
 * a *reference* check, not a behavioural one: it cannot tell a thorough spec from one that merely mentions
 * the URL. It is deliberately shallow, because the alternative — trying to infer assertion quality from a
 * regex — would be a lie with more moving parts. The manifest answers "has anyone looked at this route",
 * which is the question that actually goes unanswered as a codebase grows.
 *
 * Parameterised routes (`$id`) are matched on their static prefix, since a spec necessarily substitutes a
 * real value for the parameter.
 *
 * Usage:
 *   node scripts/check-e2e-route-coverage.mjs           # verify against the committed manifest
 *   node scripts/check-e2e-route-coverage.mjs --write   # regenerate it after adding coverage
 */
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const ROUTES_DIR = 'src/routes/api'
const SPEC_DIR = 'tests/e2e'
const MANIFEST_PATH = 'tests/e2e/_coverage/manifest.json'

function walk(dir, predicate) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full, predicate)
    return predicate(full) ? [full] : []
  })
}

/**
 * The path a route serves, read from the id the file itself declares.
 *
 * Deriving it from the filename is wrong, and was: TanStack treats a dot in a filename as a path separator, so
 * `solutions/runs.$runId.ts` serves `/api/solutions/runs/$runId`, and `[.]` as an escaped literal dot, so
 * `calendar/export[.]ics.ts` serves `/api/calendar/export.ics`. The filename-derived version reported
 * `/api/solutions/runs.$runId` and `/api/calendar/export[.]ics`, whose search keys match nothing a spec would ever
 * write — so three routes that *are* exercised by `solutions.spec.ts` and `calendar.spec.ts` were counted missing.
 * A report that invents gaps is worse than one that misses them: it trains people to skim the list.
 *
 * Falls back to the filename when a file declares no id, so a malformed route still appears rather than vanishing.
 */
function routePathFor(file) {
  const declared = readFileSync(file, 'utf8').match(/createFileRoute\('([^']+)'\)/)
  if (declared) return declared[1].replace(/\/$/, '') || '/'
  const withoutRoot = relative('src/routes', file).replace(/\.ts$/, '')
  const normalized = withoutRoot.endsWith('/index') ? withoutRoot.slice(0, -'/index'.length) : withoutRoot
  return `/${normalized}`
}

/**
 * The longest prefix of a route that a spec would write verbatim.
 *
 * `/api/lists/$listId/items` becomes `/api/lists/` — everything up to the first parameter, because the spec
 * has to interpolate a real id there. Short prefixes over-match, which is the safe direction: a false
 * "covered" is visible in review, a false "missing" would train people to ignore this check.
 */
function searchKeyFor(routePath) {
  const index = routePath.indexOf('/$')
  return index === -1 ? routePath : routePath.slice(0, index + 1)
}

const routeFiles = walk(ROUTES_DIR, (file) => file.endsWith('.ts')).sort()
const specFiles = walk(SPEC_DIR, (file) => file.endsWith('.spec.ts'))
const specSources = specFiles.map((file) => ({ file, text: readFileSync(file, 'utf8') }))

const manifest = existsSync(MANIFEST_PATH)
  ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  : { routes: {} }

const dispositions = {}
const missing = []

for (const file of routeFiles) {
  const routePath = routePathFor(file)
  const key = searchKeyFor(routePath)
  const covering = specSources.filter((spec) => spec.text.includes(key)).map((spec) => spec.file).sort()

  const recorded = manifest.routes?.[routePath]
  if (covering.length > 0) {
    dispositions[routePath] = { status: 'covered', specs: covering }
  } else if (recorded && recorded.status === 'n/a' && typeof recorded.reason === 'string' && recorded.reason.length > 0) {
    // An explicit, written exemption. The reason is required — "n/a" with no sentence is how an exemption
    // list turns into a place to hide routes.
    dispositions[routePath] = recorded
  } else {
    dispositions[routePath] = { status: 'missing' }
    missing.push(routePath)
  }
}

const next = { generatedFrom: ROUTES_DIR, routes: dispositions }

if (process.argv.includes('--write')) {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true })
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`Wrote ${MANIFEST_PATH}: ${routeFiles.length} routes, ${missing.length} missing.`)
  process.exit(missing.length > 0 ? 1 : 0)
}

const covered = Object.values(dispositions).filter((entry) => entry.status === 'covered').length
const exempt = Object.values(dispositions).filter((entry) => entry.status === 'n/a').length

console.log(`E2E route coverage: ${covered} covered, ${exempt} exempt, ${missing.length} missing (${routeFiles.length} routes).`)

if (!existsSync(MANIFEST_PATH)) {
  console.error(`\nMissing ${MANIFEST_PATH}. Generate it with:\n  node scripts/check-e2e-route-coverage.mjs --write`)
  process.exit(1)
}

if (missing.length > 0) {
  console.error('\nRoutes with no e2e spec and no recorded exemption:\n')
  for (const routePath of missing) console.error(`  ${routePath}`)
  console.error(
    '\nEither add a spec under tests/e2e/ that requests this path, or record an exemption in\n' +
      `${MANIFEST_PATH} as { "status": "n/a", "reason": "<why a spec is not the right proof here>" }.\n`,
  )
  process.exit(1)
}

process.exit(0)
