import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

/**
 * Route-graph reachability gate (plans/UI/tasks.md Wave 1 "Add an internal route-graph and
 * reachability gate").
 *
 * Compares every first-party navigation target this codebase hands to a browser — `to`/`href`
 * literals in components, `safeSourceRoute`/`sourceRoute` values in calendar projections, and
 * SITE_URL-prefixed links in transactional email — against the real route set TanStack Router
 * generated in `routeTree.gen.ts`. A literal that matches no real route is either a typo, a
 * renamed route nobody updated, or (the specific bug this gate exists to catch) a raw
 * `/_dashboard/...` route id that leaked out of a pathless layout prefix into something a
 * browser is actually sent.
 *
 * Deliberately regex-based rather than a TS AST walk, matching this repo's other structural
 * gates (`check-tenant-boundaries.mjs`) — a literal string a human wrote is exactly what a
 * regex is good at, and a template-interpolated target (`/builder/${id}`) is skipped rather than
 * guessed at, the same way those files use TanStack's own `$paramName` placeholder syntax
 * instead of JS interpolation for anything meant to be statically checkable.
 */

const root = process.cwd()
const sourceRoot = join(root, 'src')
const routeTreePath = join(sourceRoot, 'routeTree.gen.ts')

// Literal aliases fixed by plans/UI/tasks.md Wave 1 — kept here so a regression reports the
// specific historical bug instead of a generic "unknown route" message.
const KNOWN_OBSOLETE_ALIASES = new Map([
  ['/dashboard/lists', '/lists'],
  ['/dashboard/alerts', '/alerts'],
  ['/dashboard/settings/privacy', '/settings/privacy'],
])

// Extraction sites: property/attribute name immediately before the quoted literal. Each pattern
// captures one candidate path per match; multiple patterns exist because `to={}`/`href=` are JSX
// attributes, `to:`/`href:`/`safeSourceRoute:`/`sourceRoute:` are object properties, and email
// templates write a plain HTML attribute inside a template literal.
const EXTRACTION_PATTERNS = [
  /\bto=["']([^"']+)["']/g,
  /\bto:\s*['"]([^'"]+)['"]/g,
  /\bhref=["']([^"']+)["']/g,
  /\bhref:\s*['"]([^'"]+)['"]/g,
  /\bsafeSourceRoute:\s*['"]([^'"]+)['"]/g,
  /\bsourceRoute:\s*['"]([^'"]+)['"]/g,
]

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (path === routeTreePath) return []
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : []
  }))
  return nested.flat()
}

/** Every `fullPath` TanStack Router actually generated, as literal strings and `$param` patterns. */
async function loadGeneratedRoutes() {
  const source = await readFile(routeTreePath, 'utf8')
  const fullPaths = new Set()
  for (const match of source.matchAll(/fullPath:\s*'([^']*)'/g)) fullPaths.add(match[1])

  const exact = new Set()
  const patterns = []
  for (const fullPath of fullPaths) {
    const withoutTrailingSlash = fullPath.length > 1 && fullPath.endsWith('/') ? fullPath.slice(0, -1) : fullPath
    exact.add(fullPath)
    exact.add(withoutTrailingSlash)
    if (fullPath.includes('$')) {
      const regexSource = '^' + fullPath
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\\\$[A-Za-z0-9_]+/g, '[^/]+') + '/?$'
      patterns.push(new RegExp(regexSource))
    }
  }
  return { exact, patterns }
}

// Static files served straight out of `public/` — never a TanStack route, so `routeTree.gen.ts`
// has no entry for them by design. `.xml`/`.txt` are excluded from this list on purpose: those
// extensions ARE real generated routes here (`/sitemap.xml`, `/robots.txt`), so an unmatched one
// should still fail rather than being silently waved through.
const STATIC_ASSET_EXTENSION = /\.(png|ico|jpg|jpeg|svg|webp|gif|woff2?|ttf|webmanifest|css|js)$/

/** Strips a leading `${VAR}` template prefix and any trailing query/hash — the only two shapes this codebase emits. */
function normalizeCandidate(raw) {
  let value = raw
  if (value.startsWith('${')) {
    const closing = value.indexOf('}')
    if (closing === -1) return null
    value = value.slice(closing + 1)
  }
  const queryOrHash = value.search(/[?#]/)
  if (queryOrHash !== -1) value = value.slice(0, queryOrHash)
  if (!value.startsWith('/') || value.startsWith('//')) return null
  if (value.includes('${')) return null // still dynamic after stripping a prefix — unverifiable, not our concern here
  if (STATIC_ASSET_EXTENSION.test(value)) return null
  return value
}

function isKnownRoute(path, routes) {
  if (routes.exact.has(path)) return true
  return routes.patterns.some((pattern) => pattern.test(path))
}

/**
 * The reverse direction: an Admin page on disk that nothing links to
 * (plans/ui-dashboard, Admin track "Reconcile stale and future Admin destinations").
 *
 * Everything above fails a link with no route. This fails a route with no link — a page reachable
 * only by someone who already knows its URL. That matters more on `/admin` than anywhere else: the
 * console has no public entry point, so the navigation registry *is* the discovery mechanism, and a
 * page missing from it is a page an operator will not find during the incident it was built for.
 *
 * `nav-config.ts` already states the rule in a comment — "an admin page nobody can navigate to is a
 * page nobody…" — next to the one destination that was nearly registered by URL alone. A comment is
 * not a gate. This passes today; it exists so the next `/admin/*` route cannot ship orphaned.
 *
 * Scoped to `/admin` deliberately. Elsewhere a route with no in-app link is often correct: a public
 * landing page arrives from search, a `/schedule/$invitationId` arrives from an email, and an OAuth
 * callback is never linked at all. Widening this would mean an allowlist longer than the check.
 */
const ADMIN_INDEX = '/admin/'

function findOrphanedAdminRoutes(routes, linkedPaths) {
  const orphans = []
  for (const fullPath of routes.exact) {
    if (!fullPath.startsWith('/admin/') || fullPath === ADMIN_INDEX) continue
    // `exact` holds both `/admin/users` and `/admin/users/`; judge the canonical form once.
    if (fullPath.endsWith('/')) continue
    if (fullPath.includes('$')) continue // parameterised detail routes are opened from their list page
    if (!linkedPaths.has(fullPath)) orphans.push(fullPath)
  }
  return orphans
}

async function main() {
  const routes = await loadGeneratedRoutes()
  const files = await sourceFiles(sourceRoot)
  const findings = []
  /** Every path this codebase actually hands to a browser — the input to the orphan check below. */
  const linkedPaths = new Set()

  for (const absolutePath of files) {
    const relativePath = relative(root, absolutePath)
    const source = await readFile(absolutePath, 'utf8')

    for (const pattern of EXTRACTION_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const raw = match[1]
        const candidate = normalizeCandidate(raw)
        if (candidate === null) continue

        if (candidate.includes('/_dashboard')) {
          findings.push(`${relativePath}: navigates to a browser-visible dashboard route id: ${raw}`)
          continue
        }
        if (KNOWN_OBSOLETE_ALIASES.has(candidate)) {
          findings.push(`${relativePath}: obsolete path ${candidate} — use ${KNOWN_OBSOLETE_ALIASES.get(candidate)}`)
          continue
        }
        if (!isKnownRoute(candidate, routes)) {
          findings.push(`${relativePath}: ${raw} does not match any generated route`)
          continue
        }
        linkedPaths.add(candidate)
      }
    }
  }

  for (const orphan of findOrphanedAdminRoutes(routes, linkedPaths)) {
    findings.push(`${orphan}: an Admin route nothing navigates to — register it in nav-config.ts or delete the route`)
  }

  if (findings.length > 0) {
    console.error(findings.sort().join('\n'))
    console.error(`\n${findings.length} route-graph finding(s).`)
    process.exitCode = 1
  } else {
    console.log(`Route-graph reachability check passed (${routes.exact.size} known route forms).`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
