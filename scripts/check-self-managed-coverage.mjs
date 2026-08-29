// Universal matching-coverage gate (plan: phase-2/07-perfiles-autogestionados, §"Principio de
// cobertura universal en matching" — "Guard future matching surfaces mechanically").
//
// The plan's rule is that any code producing a list of candidates, matches or relevant people must
// consider self-managed profiles. A rule like that decays the moment somebody adds the eleventh
// surface without having read the spec — and it decays *silently*, because a surface that omits a
// whole class of people looks exactly like one where nobody matched.
//
// So: every file that produces people must either call the shared inclusion policy, or be declared
// here with a reason. A new matching surface with neither fails this check, at the moment somebody
// is already looking at the code that makes the decision.
//
// This deliberately does not check that the *answer* is right. Whether a surface should include
// self-managed people is a product question with legitimate answers in both directions; what the
// gate enforces is that the question was asked out loud.
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = process.cwd()
const sourceRoot = join(root, 'src')

/**
 * What counts as producing a match list. Today every people-producing surface in this repository
 * goes through the federated search, so one call shape finds all of them; when a surface arrives
 * that produces people some other way, add its shape here rather than exempting it.
 */
const MATCHING_CALL = /\b(?:searchBuilders|searchBuildersWithStatus)\s*\(/

/** Any of these is a declaration that the surface considered the question. */
const POLICY_CALL = /\b(?:decideSelfManagedInclusion|withSelfManagedOrigin|applySelfManagedInclusion)\s*\(/

/**
 * Declared exemptions. Every entry states why this surface does not consider self-managed
 * profiles, and an entry whose file stops matching is reported as stale rather than left to rot.
 *
 * "It is not wired yet" is a legitimate reason **only** when it names what blocks it. A TODO with
 * no mechanism behind it is how the eleventh surface gets added.
 */
const exemptions = new Map([
  [
    'src/lib/search.ts',
    'the fan-out itself, not a surface over it: this is where the origin is contacted, and the '
    + 'policy decides *whether it is asked for* one layer up. A policy call here would decide for '
    + 'every caller at once, which is exactly what the per-surface toggle exists to prevent',
  ],
  [
    'src/lib/discovery/worker.ts',
    'ingestion crawl, not a match list: it walks the discovery matrix to populate the index and '
    + 'shows nobody a result. Self-managed profiles are rows this product already owns, so there '
    + 'is nothing to discover — crawling them would re-index what was written locally a moment ago',
  ],
])

/**
 * Surfaces that produce people *without* going through the federated search, and are therefore
 * invisible to `MATCHING_CALL`. Listed by hand because a gate that cannot see a surface cannot
 * force it to declare — and a rule this one silently does not cover is worse than no rule.
 */
const knownUncoveredSurfaces = new Map([
  [
    'src/lib/solutions/retrieval/lanes.ts',
    'the Solutions people lane selects from builder_embeddings joined to builder_identities, and a '
    + 'self-managed profile has no builder_identities row — so widening the entity-kind filter '
    + 'returns nothing. Closing it needs a parallel CTE, an identity-less HumanCandidate, a third '
    + 'componentId prefix beside human:/account:, and the human_profile branches in '
    + 'composer/coverage.ts, composer/estimate.ts and composer/compose.ts. Its own task '
    + '(plan 4b.6), recorded so the gap stays visible rather than becoming folklore',
  ],
])

const files = await sourceFiles(sourceRoot)
const findings = []
const declared = []

for (const absolutePath of files) {
  const path = relative(root, absolutePath).split('\\').join('/')
  const source = await readFile(absolutePath, 'utf8')

  // Comments and doc blocks mention `searchBuilders(` constantly; only real code counts.
  const codeLines = source
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
    .join('\n')
  if (!MATCHING_CALL.test(codeLines)) continue

  if (POLICY_CALL.test(codeLines)) {
    declared.push({ path, how: 'policy' })
    continue
  }
  if (exemptions.has(path)) {
    declared.push({ path, how: 'exempt' })
    continue
  }

  findings.push(
    `${path}: produces a match list but neither calls the self-managed inclusion policy nor is `
    + `declared in scripts/check-self-managed-coverage.mjs. Either resolve the policy `
    + `(decideSelfManagedInclusion + withSelfManagedOrigin) or add an exemption saying why this `
    + `surface does not show people.`,
  )
}

// Staleness, both directions — an exemption that no longer describes anything is a claim nobody
// re-checked, and it is the entry most likely to be wrong when the file it names comes back.
const scanned = new Set(files.map((absolutePath) => relative(root, absolutePath).split('\\').join('/')))
for (const [path, reason] of exemptions) {
  if (!scanned.has(path)) {
    findings.push(`${path}: exempted ("${reason.slice(0, 60)}…") but no longer exists — remove the stale entry`)
  } else if (!declared.some((entry) => entry.path === path && entry.how === 'exempt')) {
    findings.push(`${path}: exempted but no longer produces a match list — remove the stale entry`)
  }
}
for (const [path] of knownUncoveredSurfaces) {
  if (!scanned.has(path)) {
    findings.push(`${path}: recorded as an uncovered matching surface but no longer exists — remove or repoint the entry`)
  }
}

if (findings.length > 0) {
  console.error(findings.sort().join('\n'))
  process.exitCode = 1
} else {
  console.log(JSON.stringify({
    surfaces: declared.length,
    viaPolicy: declared.filter((entry) => entry.how === 'policy').length,
    exempted: declared.filter((entry) => entry.how === 'exempt').length,
    // Printed on every run rather than buried in a comment: a known gap that nobody is reminded of
    // is a gap that becomes folklore and then becomes a surprise.
    knownUncovered: [...knownUncoveredSurfaces.keys()],
  }))
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  }))
  return nested.flat()
}
