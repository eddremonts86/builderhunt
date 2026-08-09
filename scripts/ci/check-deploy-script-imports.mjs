// Nothing the deploy runs may import from `src/`, because `src/` is not in the image.
//
// The runtime stage of the Dockerfile copies `scripts`, `drizzle`, `content`, `server` and the build
// output. It deliberately does **not** copy `src/` — the Dockerfile says so itself, next to the line
// that exists because `server/security.mjs` had to move out of `src/` for the same reason.
//
// `scripts/db/sync-platform-content.ts` imported `src/shared/lib/platform-content-source.ts` anyway.
// Locally and in CI that resolves, so every test passed. In production it threw
// `ERR_MODULE_NOT_FOUND` on every single deploy from the day it shipped, the orchestrator caught it,
// printed "content sync failed — the deploy is otherwise healthy", and carried on green. `/changelog`
// and `/roadmap` served whatever rows they already had for two weeks and nothing looked broken.
//
// A type-check cannot catch this: the import is valid TypeScript and the file is right there. Only the
// shape of the image makes it wrong, which is why the check has to be about the image.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = process.cwd()
const ORCHESTRATOR = 'scripts/deploy/orchestrate.mjs'

/**
 * The scripts the deploy actually executes, read from `runBin` calls rather than from the docblock.
 *
 * The orchestrator's header comment lists its steps and is the obvious thing to parse — and it is
 * prose, so it can fall out of date without anything failing. `runBin('tsx', ['scripts/x.ts'])` is
 * the line that runs the file.
 */
function deployEntrypoints(source) {
  const found = new Set()
  for (const m of source.matchAll(/runBin\(\s*'tsx'\s*,\s*\[\s*'([^']+)'/g)) found.add(m[1])
  return [...found]
}

/** Relative imports only — a bare specifier is a package, and packages are installed in the image. */
function relativeImports(source) {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*'(\.[^']+)'/g)].map((m) => m[1])
}

/** `~/` is the alias for `src/`, so it is the same offence spelled differently. */
function aliasImports(source) {
  return [...source.matchAll(/(?:from|import)\s*\(?\s*'(~\/[^']+)'/g)].map((m) => m[1])
}

function resolveImport(fromFile, specifier) {
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

const orchestrator = readFileSync(join(root, ORCHESTRATOR), 'utf8')
const entrypoints = deployEntrypoints(orchestrator)

const problems = []
const visited = new Set()
const queue = entrypoints.map((p) => join(root, p))

while (queue.length > 0) {
  const file = queue.shift()
  if (visited.has(file) || !existsSync(file)) continue
  visited.add(file)
  const source = readFileSync(file, 'utf8')
  const shown = relative(root, file)

  for (const specifier of aliasImports(source)) {
    problems.push(`${shown} imports '${specifier}' — the ~/ alias points at src/, which the image omits`)
  }
  for (const specifier of relativeImports(source)) {
    const target = resolveImport(file, specifier)
    if (!target) continue
    const targetPath = relative(root, target)
    if (targetPath.startsWith('src/')) {
      problems.push(`${shown} imports '${specifier}' → ${targetPath}, and src/ is not in the image`)
      continue
    }
    queue.push(target)
  }
}

console.log(JSON.stringify({
  orchestrator: ORCHESTRATOR,
  deployEntrypoints: entrypoints.length,
  filesReachable: visited.size,
  importsFromSrc: problems.length,
}))

if (entrypoints.length === 0) {
  console.error(
    `\nFound no \`runBin('tsx', [...])\` calls in ${ORCHESTRATOR}.\n\n`
    + '  Either the deploy stopped running scripts or the call shape changed. A checker that silently\n'
    + '  finds nothing to check is worse than no checker, so this is a failure.\n',
  )
  process.exit(1)
}

if (problems.length > 0) {
  console.error(`\n${problems.length} deploy-time import${problems.length === 1 ? '' : 's'} that production cannot resolve:\n`)
  for (const line of problems) console.error(`  - ${line}`)
  console.error(
    '\n  These fail with ERR_MODULE_NOT_FOUND inside the container and only there. Move the module\n'
    + '  under scripts/ (see scripts/lib/), the way server/security.mjs moved out of src/.\n',
  )
  process.exit(1)
}
