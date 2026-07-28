import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Guards the canonical build order recorded in plans/_meta/phase-1-order.md: every
// plan directory in plans/phase-1 is prefixed with its position, and a plan's
// `> **Depends on**:` header may only point at lower-numbered plans. A dependency
// that points forward means the number no longer describes a buildable sequence.
//
// One cycle in the headers is deliberate and allowed: 21-semantic-search declares a
// dependency on 22-proactive-discovery while 22 declares one on 21. README.md's
// dependency graph resolves it as semantic -> discovery, so 21 precedes 22.
const PHASE_1 = join(process.cwd(), 'plans', 'phase-1')
const ALLOWED_FORWARD_EDGES = new Set(['21-semantic-search -> 22-proactive-discovery'])

let failed = false

function fail(message) {
  console.error(`FAIL: ${message}`)
  failed = true
}

const dirs = readdirSync(PHASE_1, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

const numberOf = new Map()
const seen = new Map()

for (const dir of dirs) {
  const match = /^(\d\d)-(.+)$/.exec(dir)
  if (!match) {
    fail(`plans/phase-1/${dir} has no NN- build-order prefix`)
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
  return [...block.matchAll(/\.\.\/(\d\d-[a-z0-9-]+)\//g)].map((m) => m[1])
}

for (const dir of dirs) {
  const files = readdirSync(join(PHASE_1, dir))
  const specFile = files.includes('spec.md') ? 'spec.md' : files.find((f) => f.endsWith('.md'))
  if (!specFile) {
    fail(`plans/phase-1/${dir} has no markdown file to read a header from`)
    continue
  }
  const position = numberOf.get(dir)
  const text = readFileSync(join(PHASE_1, dir, specFile), 'utf8')
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
