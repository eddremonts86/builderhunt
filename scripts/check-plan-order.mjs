import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

// Guards the canonical build order recorded in plans/_meta/phase-1-order.md: every
// plan directory is prefixed with its position, and a plan's `> **Depends on**:`
// header may only point at lower-numbered plans. A dependency that points forward
// means the number no longer describes a buildable sequence.
//
// One cycle in the headers is deliberate and allowed: 22-semantic-search declares a
// dependency on 23-proactive-discovery, and 23 declares one back on 22. README.md's
// dependency graph resolves it as semantic -> discovery, so 22 precedes 23.
//
// ## Why three directories
//
// A plan has one of three homes, by outcome rather than by topic:
//
//   plans/phase-1/              live work — open or partial tasks remain
//   plans/implemented/phase-1/  done and tested
//   plans/rejected/phase-1/     never built and never will be under this number
//
// The build order does not move with a plan: the number *is* the position in
// plans/_meta/phase-1-order.md, and positions have to stay contiguous whether or not the work
// landed — or was abandoned. So the corpus this script checks is the union of all three, and the
// invariant is unchanged: 01..N with no gaps, every dependency backward.
//
// Reading only plans/phase-1 would make the check pass vacuously the moment a plan moved: after
// the 2026-08-11 moves it holds exactly two directories, numbered 55 and 57, which would be asked
// to be numbered 01-02 while every dependency on a moved plan resolved to "not a plan directory".
// That is what it did before it was taught the union, and adding the third root without adding it
// here would have reproduced it — five plans' worth.
//
// Each root is split by phase because the numbers are only unique *within* a phase: phase 3 is
// numbered 01-13 and twelve of those collide with phase 1's. A flat root could hold one phase and
// no more.
const PLAN_ROOTS = [
  join(process.cwd(), 'plans', 'phase-1'),
  join(process.cwd(), 'plans', 'implemented', 'phase-1'),
  join(process.cwd(), 'plans', 'rejected', 'phase-1'),
]
const ALLOWED_FORWARD_EDGES = new Set(['22-semantic-search -> 23-proactive-discovery'])

let failed = false

function fail(message) {
  console.error(`FAIL: ${message}`)
  failed = true
}

/** Directory name -> the root it lives under, so failures can name the real path. */
const rootOf = new Map()
for (const root of PLAN_ROOTS) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (rootOf.has(entry.name)) {
      // Names the two roots it was found under, because with three of them "a plan has one home"
      // is no longer enough to locate the duplicate.
      const first = relative(process.cwd(), rootOf.get(entry.name))
      fail(`${entry.name} exists under both ${first} and ${relative(process.cwd(), root)} — a plan has one home`)
    }
    rootOf.set(entry.name, root)
  }
}
const dirs = [...rootOf.keys()].sort()
const shortPath = (dir) => `${relative(process.cwd(), rootOf.get(dir))}/${dir}`

const numberOf = new Map()
const seen = new Map()

for (const dir of dirs) {
  const match = /^(\d\d)-(.+)$/.exec(dir)
  if (!match) {
    fail(`${shortPath(dir)} has no NN- build-order prefix`)
    continue
  }
  const [, prefix, name] = match
  const position = Number(prefix)
  if (seen.has(position)) fail(`position ${prefix} used twice: ${seen.get(position)} and ${dir}`)
  seen.set(position, dir)
  numberOf.set(name, position)
  numberOf.set(dir, position)
}

for (let position = 1; position <= seen.size; position += 1) {
  if (!seen.has(position)) fail(`no plan holds position ${String(position).padStart(2, '0')}`)
}

// `Depends on` is a multi-line header; read until the next `> **` field. Returns null when
// the header is absent, which is itself a failure — a plan with no readable dependency
// header is not checked by this script, and silence there is how a forward edge survives.
function dependsOn(text) {
  const start = text.search(/> \*\*Depends on\*?\*?:/)
  if (start === -1) return null
  const rest = text.slice(start)
  const end = rest.search(/\n> \*\*(?!Depends)/)
  const block = end === -1 ? rest : rest.slice(0, end)
  // `../NN-name/` for a sibling, and `../../<root>/phase-1/NN-name/` once the two live under
  // different roots. Matching only the plan segment keeps this indifferent to which root it is in —
  // the dependency is on the plan, not on where the plan is filed.
  //
  // The optional group has to list every root segment a path can pass through, `rejected/` included:
  // without it a `Depends on` pointing into the rejected root would match nothing, the dependency
  // would read as absent, and a forward edge through it would go unreported. That is the failure
  // this alternation exists to prevent, and it is silent — which is why it is spelled out rather
  // than left to a looser pattern.
  return [...block.matchAll(/(?:\.\.\/)+(?:phase-1\/|implemented\/|rejected\/)?(?:phase-1\/)?(\d\d-[a-z0-9-]+)\//g)].map((m) => m[1])
}

for (const dir of dirs) {
  const files = readdirSync(join(rootOf.get(dir), dir))
  const specFile = files.includes('spec.md') ? 'spec.md' : files.find((f) => f.endsWith('.md'))
  if (!specFile) {
    fail(`${shortPath(dir)} has no markdown file to read a header from`)
    continue
  }
  const position = numberOf.get(dir)
  const text = readFileSync(join(rootOf.get(dir), dir, specFile), 'utf8')
  const deps = dependsOn(text)
  if (deps === null) {
    fail(`${dir}/${specFile} has no "> **Depends on**:" header — conventions.md requires one`)
    continue
  }
  for (const dep of new Set(deps)) {
    const depPosition = numberOf.get(dep)
    if (depPosition === undefined) {
      fail(`${dir} depends on ${dep}, which is not a plan directory`)
      continue
    }
    if (depPosition > position && !ALLOWED_FORWARD_EDGES.has(`${dir} -> ${dep}`)) {
      fail(`${dir} depends on the later plan ${dep} — the build order is not a valid sequence`)
    }
  }
}

if (failed) {
  console.error('\nplans/_meta/phase-1-order.md is the record of this order; update it together with any renumbering.')
  process.exit(1)
}

console.log(`OK: ${dirs.length} plans numbered 01-${String(dirs.length).padStart(2, '0')}, every dependency points backward`)
