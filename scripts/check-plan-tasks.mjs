import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Keeps plan files followable *literally*, which is the property that makes them safe for an agent
// to execute without supplying judgement of its own. Four mechanical checks:
//
//   0. Every open task carries `Files`, `Do` and `Verify`. The field that gets dropped is always
//      `Verify`, and a task nobody can verify is a task nobody can tell is finished — which is
//      precisely where a weaker model reports success. Checked tasks are exempt: 243 of them are
//      narrative records of finished work, and reformatting those would destroy evidence.
//   0b. No `- [ ]` checkbox under a "future work" heading. 42 had four, each needing a new approval
//      or specification first; a checkbox there reads as pending work to every reader and invites
//      building scope nobody approved.
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
  ['check:table-surfaces', 'phase-3'],
  // Phase 4's two career plans specify these as exit criteria for their own phases, and both plans say plainly that
  // nothing creates them yet. Registered so the checker stops reporting a gap the plans already declare, while still
  // failing if any *other* document starts telling someone to run them.
  ['test:e2e:career-free-path', 'phase-4'],
  ['test:e2e:applications-free-path', 'phase-4'],
])

const scripts = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts))

let failed = false
const fail = (message) => {
  console.error(`FAIL: ${message}`)
  failed = true
}

/**
 * Field failures are collected instead of printed one by one.
 *
 * A plan authored in a different task format produces one failure per task — `phase-2/07` alone emitted 83
 * identical lines, which read as 83 separate defects and buried the single actionable fact: that one file uses
 * a compact `**N.M** — description` shape rather than the Files/Do/Verify triple. A check nobody can act on is
 * a check that gets ignored, so a file past the threshold is reported once, by file, with its line numbers.
 */
const fieldFailuresByFile = new Map()
const openTaskCountByFile = new Map()
const FIELD_FAILURE_DIGEST_THRESHOLD = 5

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p)
    else if (entry.endsWith('.md')) check(p)
  }
}

// Open checklist items, with the indented body that belongs to each.
function openTasks(lines) {
  const tasks = []
  let cur = null
  lines.forEach((line, i) => {
    const m = /^- \[([ x])\] (.*)$/.exec(line)
    if (m) {
      if (cur) tasks.push(cur)
      cur = m[1] === ' ' ? { line: i + 1, title: m[2], body: [] } : null
    } else if (cur) {
      if (line.startsWith('#')) {
        tasks.push(cur)
        cur = null
      } else cur.body.push(line)
    }
  })
  if (cur) tasks.push(cur)
  return tasks
}

// A field name at the start of a body line, allowing "Verify (RED):" and "Verify (2026-07-22):".
const hasField = (body, name) =>
  new RegExp(String.raw`^\s*[-*]?\s*\**${name}\**[^:\n]{0,40}:`, 'im').test(body)

const SCOPE_HEADING = /future work|not part of th|out of scope|optional follow|won'?t do|non-goals/i

function check(file) {
  const rel = file.slice(ROOT.length + 1)
  const lines = readFileSync(file, 'utf8').split('\n')

  if (/(^|\/)tasks?\.md$/.test(rel)) {
    const openTaskList = openTasks(lines)
    openTaskCountByFile.set(rel, openTaskList.length)
    for (const task of openTaskList) {
      const body = task.body.join('\n')
      const missing = ['Files', 'Do', 'Verif(?:y|ication)'].filter((f) => !hasField(body, f))
      if (missing.length) {
        const names = missing.map((f) => (f.startsWith('Verif') ? 'Verify' : f)).join(', ')
        if (!fieldFailuresByFile.has(rel)) fieldFailuresByFile.set(rel, [])
        fieldFailuresByFile.get(rel).push({
          line: task.line,
          names,
          title: task.title.replace(/\*\*/g, '').slice(0, 60),
        })
      }
    }
    // A checkbox under a "future work" heading reads as pending work to every reader, human or
    // agent, and invites building scope nobody approved. Those belong in a prose list.
    let heading = ''
    lines.forEach((line, i) => {
      if (line.startsWith('#')) heading = line
      if (line.startsWith('- [ ]') && SCOPE_HEADING.test(heading)) {
        fail(`${rel}:${i + 1} checkbox under "${heading.trim().slice(0, 48)}" — make it a prose list item`)
      }
    })
  }

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

// One line per task while a file has only a few, one digest per file once it clearly has a format problem
// rather than a handful of oversights.
for (const [rel, entries] of fieldFailuresByFile) {
  if (entries.length < FIELD_FAILURE_DIGEST_THRESHOLD) {
    for (const e of entries) fail(`${rel}:${e.line} open task is missing ${e.names} — "${e.title}"`)
    continue
  }
  const allSame = new Set(entries.map((e) => e.names)).size === 1
  const total = openTaskCountByFile.get(rel)
  // Only claim "every open task" when it is actually every one of them. A digest that overstates is a digest
  // the next reader stops trusting.
  const scope = entries.length === total
    ? `That is every open task in the file, so this is a format mismatch rather than a set of oversights — the `
      + `plan uses a compact one-line task shape. Converting it is plan authorship: the Verify lines do not `
      + `exist anywhere and cannot be inferred from the task text.`
    : `${entries.length} of ${total} open tasks in the file, so the rest do carry the fields — treat these as `
      + `individual omissions, not a format decision.`
  fail(
    `${rel} — ${entries.length} open tasks are missing ${allSame ? entries[0].names : 'Files/Do/Verify fields'}. `
      + `${scope}\n      lines: ${entries.map((e) => e.line).join(', ')}`,
  )
}

if (failed) {
  console.error(
    '\nA plan naming a path or command that does not exist cannot be followed literally, which is\n' +
      'the whole point of the format. Fix the plan; if a task creates the script, record it in\n' +
      'SCRIPTS_CREATED_BY_PLANS with the plan that owns it.',
  )
  process.exit(1)
}

console.log(
  'OK: every open task carries Files/Do/Verify, no checkbox sits under a future-work heading,\n' +
    '    no plan names a retired test tree, and every `pnpm` script a plan runs exists',
)
