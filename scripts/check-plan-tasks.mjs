import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Keeps plan files followable *literally*, which is the property that makes them safe for an agent
// to execute without supplying judgement of its own. Two mechanical checks:
//
//   1. No plan names a path under a directory tree the repo has retired. All tests moved under
//      tests/{unit,e2e,regression} on 2026-07-27, and eleven task files went on naming
//      `test/security/…` and `e2e/…` — 149 paths in 22 files. One of them had been patched with a
//      note asking the reader to mentally translate ("paths below that say e2e/... mean
//      tests/e2e/..."), which is exactly the instruction a weaker model will not follow. An agent
//      taking those paths at face value rebuilds the old layout beside the real one.
//   2. Every `pnpm <script>` a plan tells you to run exists in package.json, so no Verify step is
//      un-runnable. This caught four: `test:migrations`, `test:db-roles`, `test:tenant-context`
//      (gates in 01's plan.md that were never scripts) and a stale `test:migrations` in 28.
//
// It deliberately does not try to resolve every path: plans legitimately name files they are about
// to create, use paths relative to their own directory, and abbreviate inside enumerations. A
// generic "does this file exist" check drowns in those and gets switched off.
const ROOT = process.cwd()
const PLANS = join(ROOT, 'plans')

// Retired directory trees: pattern -> what to write instead. Add an entry whenever a tree moves,
// and the next plan that names the old location fails here instead of in a confused agent.
const RETIRED_TREES = [
  { pattern: /`test\/security\//, replacement: 'tests/unit/security/' },
  { pattern: /`test\/(?:test-|fixtures\/)/, replacement: 'tests/regression/ or tests/fixtures/' },
  { pattern: /`e2e\//, replacement: 'tests/e2e/' },
]

// Invoked through pnpm but not package.json scripts.
const PNPM_BINARIES = new Set([
  'exec', 'install', 'add', 'remove', 'dlx', 'why', 'list', 'run', 'audit', 'update',
  'vitest', 'eslint', 'tsc', 'tsx', 'playwright', 'drizzle-kit', 'prettier', 'vite', 'node',
])

// Scripts that a plan's own tasks add. Each names the plan that adds it, so this cannot quietly
// become a home for typos.
const SCRIPTS_CREATED_BY_PLANS = new Map([
  ['test:e2e:coverage', '53-exhaustive-local-e2e-design'],
  ['test:e2e:nightly', '53-exhaustive-local-e2e-design'],
  ['test:conversion', '51-audit-conversion'],
])

const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts))

let failed = false
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failed = true
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p)
    else if (entry.endsWith('.md')) check(p)
  }
}

function check(file) {
  const rel = file.slice(ROOT.length + 1)
  const lines = readFileSync(file, 'utf8').split('\n')

  lines.forEach((line, i) => {
    for (const { pattern, replacement } of RETIRED_TREES) {
      if (pattern.test(line)) {
        fail(`${rel}:${i + 1} names a path under a retired test tree — write ${replacement} instead`)
      }
    }
    // Only inside a code span. Prose says things like "pnpm via corepack" and "not a pnpm
    // workspace package"; every real defect this found was written as a command in backticks.
    for (const span of line.matchAll(/`([^`]+)`/g)) {
      for (const m of span[1].matchAll(/pnpm ([a-z][a-z0-9:-]*)/g)) {
        const script = m[1]
        if (PNPM_BINARIES.has(script) || scripts.has(script)) continue
        const owner = SCRIPTS_CREATED_BY_PLANS.get(script)
        if (owner && rel.includes(owner)) continue
        fail(`${rel}:${i + 1} tells you to run \`pnpm ${script}\`, which is not a package.json script`)
      }
    }
  })
}

walk(PLANS)

if (failed) {
  console.error(
    '\nA plan naming a path or command that does not exist cannot be followed literally, which is\n' +
      'the whole point of the format. Fix the plan; if a task creates the script, record it in\n' +
      'SCRIPTS_CREATED_BY_PLANS with the plan that owns it.',
  )
  process.exit(1)
}

console.log('OK: no plan names a retired test tree, and every `pnpm` script a plan runs exists')
