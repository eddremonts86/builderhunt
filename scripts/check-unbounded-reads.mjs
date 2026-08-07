// Every exported function in src/ that issues a Drizzle list read must declare a bound.
// Phase 3 names three: a keyset **page**, a **model-bounded** `.limit(n)` whose ceiling the data
// model fixes, or a chunked **batch** loop for reads that must cover every row. This script finds
// the ones that declare none.
//
// It is report-only here (plan 01) and exits 0 no matter what it finds. Plan 13 turns it into a
// gate once the classification in plans/phase-3/01-read-path-audit/tasks.md has caught up with it.
//
// The heuristic is deliberately textual rather than AST-based, for the same reason
// check-route-coverage.mjs is: the failure mode worth catching is a new repository function that
// selects rows and forgets a limit, and that shape is visible in the source text. The shapes it
// cannot see are listed under "Known blind spots" in 01-read-path-audit/spec.md — read them before
// trusting the number further than it deserves.
//
// Usage:
//   node scripts/check-unbounded-reads.mjs           # the JSON summary
//   node scripts/check-unbounded-reads.mjs --list     # one `path:line function` per unbounded read
//   node scripts/check-unbounded-reads.mjs --list --aggregates   # also list what was exempted
//   node scripts/check-unbounded-reads.mjs --mixed    # functions whose `.limit(` covers only some
//                                                     # of their selects — the main blind spot

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const root = process.cwd()
const srcRoot = join(root, 'src')

const args = new Set(process.argv.slice(2))
const wantList = args.has('--list')
const wantAggregates = args.has('--aggregates')
const wantMixed = args.has('--mixed')

// ── What counts as a list read ───────────────────────────────────────────────────────────────────
// `.select({` and `.select()` are Drizzle's projection and select-all; `db.select`/`tx.select`
// catch the same call written across a line break. `findMany(` is the relational-query API.
const LIST_READ = /\.select\(\{|\.select\(\)|\bdb\.select\b|\btx\.select\b|\.findMany\(/

// `.limit(` anywhere in the body is the declared bound. Which of the three mechanisms it is
// belongs to the classification, not to this script.
const HAS_LIMIT = /\.limit\(/

// A scalar aggregate returns a number, not rows, so it has nothing to bound. Only a projection
// whose every field is an aggregate qualifies — a function that aggregates *and* lists is a list
// read (01-read-path-audit/spec.md, "Resolved edge cases").
const AGGREGATE_VALUE =
  /^\s*(?:count|sum|avg|min|max)\s*\(|^\s*sql\s*(?:<[^>]*>)?\s*`\s*(?:count|sum|avg|min|max|coalesce\s*\(\s*(?:count|sum|avg|min|max))/i

// A reviewed exception, on any of the lines above the function.
const EXEMPTION = /\/\/\s*unbounded-read-ok:\s*(\S.*)$/

// Naive `.from(` matching inflated the first survey from 50 to 113 entries. Nothing below matches
// `.from(` any more, but these are stripped anyway so a future widening of LIST_READ cannot
// silently reintroduce the same false positives.
const NON_DRIZZLE_FROM = /\b(?:Buffer|Array|Object|Set|Map)\.from\(/g

const EXPORTED_FUNCTION =
  /^export\s+(?:async\s+)?function\s+(\w+)|^export\s+const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\()/

async function collectSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectSourceFiles(full)))
      continue
    }
    if (!entry.isFile()) continue
    if (!/\.tsx?$/.test(entry.name)) continue
    // Colocated tests are out of scope: the script walks src/ only, and a fixture that reads every
    // row of a five-row table is not an incident.
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
    files.push(full)
  }
  return files
}

/**
 * Index of the next character that is real code — skipping whitespace, comments, and the whole of
 * any string or template literal (including `${}` interpolations, which nest).
 *
 * Brace counting without this is not a rounding error: `sql` templates and a single `'}'` in a
 * string are enough to end a function body in the wrong place, and the entry that gets attributed
 * to the wrong function is silently wrong rather than visibly missing.
 */
function skipTrivia(source, i) {
  for (;;) {
    while (i < source.length && /\s/.test(source[i])) i += 1
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
      continue
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    return i
  }
}

/** Index just past the string/template starting at `i`, or `i` when it is not a quote. */
function skipString(source, i) {
  const quote = source[i]
  if (quote !== '"' && quote !== "'" && quote !== '`') return i
  let j = i + 1
  while (j < source.length) {
    const c = source[j]
    if (c === '\\') {
      j += 2
      continue
    }
    if (quote === '`' && c === '$' && source[j + 1] === '{') {
      // An interpolation is code again, so walk it with the same rules until its brace closes.
      let depth = 1
      j += 2
      while (j < source.length && depth > 0) {
        const inner = source[j]
        if (inner === '"' || inner === "'" || inner === '`') {
          j = skipString(source, j)
          continue
        }
        if (source.startsWith('//', j) || source.startsWith('/*', j)) {
          j = skipTrivia(source, j)
          continue
        }
        if (inner === '{') depth += 1
        else if (inner === '}') depth -= 1
        j += 1
      }
      continue
    }
    if (c === quote) return j + 1
    j += 1
  }
  return j
}

/**
 * Where a function's body starts, and whether it is a block or a concise arrow expression.
 *
 * The concise form matters: `export const listX = () => db.select({...}).from(x)` has no braces at
 * all, and treating the next `{` in the file as its body attributed three `accountDb.insert`
 * one-liners to `hardDeleteAccountSubject`'s read.
 */
function findBodyStart(source, signatureIndex) {
  let i = signatureIndex
  let paren = 0
  let sawParams = false
  for (; i < source.length; i += 1) {
    const c = source[i]
    if (c === '"' || c === "'" || c === '`') {
      i = skipString(source, i) - 1
      continue
    }
    if (c === '(') {
      paren += 1
      sawParams = true
    } else if (c === ')') {
      paren -= 1
      if (paren === 0 && sawParams) {
        i += 1
        break
      }
    }
  }
  if (!sawParams) return null

  // Between the parameter list and the body sits an optional return type, whose `{` (an object
  // type) and `<` (a generic argument) must not be mistaken for the body.
  let angle = 0
  let curly = 0
  let square = 0
  let round = 0
  for (; i < source.length; i += 1) {
    if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
      i = skipString(source, i) - 1
      continue
    }
    const c = source[i]
    if (c === '=' && source[i + 1] === '>' && angle === 0 && curly === 0 && square === 0 && round === 0) {
      const start = skipTrivia(source, i + 2)
      return { kind: source[start] === '{' ? 'block' : 'expression', start }
    }
    if (c === '<') angle += 1
    else if (c === '>') angle = Math.max(0, angle - 1)
    else if (c === '(') round += 1
    else if (c === ')') round -= 1
    else if (c === '[') square += 1
    else if (c === ']') square -= 1
    else if (c === '}') curly -= 1
    else if (c === '{') {
      if (angle === 0 && curly === 0 && square === 0 && round === 0) return { kind: 'block', start: i }
      curly += 1
    }
  }
  return null
}

/**
 * The body with its comments removed, for matching only.
 *
 * A comment that *describes* a read is not a read: `getPlatformUserBillingSummary` issues one raw
 * `db.execute(sql...)` and explains why in prose that names `.select()`, and matching against the
 * prose reported a function that has no Drizzle list read at all.
 */
function stripComments(body) {
  let out = ''
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (c === '"' || c === "'" || c === '`') {
      const end = skipString(body, i)
      out += body.slice(i, end)
      i = end - 1
      continue
    }
    if (body.startsWith('//', i)) {
      const end = body.indexOf('\n', i)
      i = (end === -1 ? body.length : end) - 1
      continue
    }
    if (body.startsWith('/*', i)) {
      const end = body.indexOf('*/', i + 2)
      i = (end === -1 ? body.length : end + 2) - 1
      continue
    }
    out += c
  }
  return out
}

const CONTINUATION = /^[.,)\]}?:+\-*/&|=<>]|^(?:as|instanceof|in)\b/

/** Returns the source of the function whose signature begins at `signatureIndex`, or null. */
function extractBody(source, signatureIndex) {
  const body = findBodyStart(source, signatureIndex)
  if (!body) return null

  if (body.kind === 'block') {
    let braces = 0
    for (let j = body.start; j < source.length; j += 1) {
      const c = source[j]
      if (c === '"' || c === "'" || c === '`') {
        j = skipString(source, j) - 1
        continue
      }
      if (source.startsWith('//', j) || source.startsWith('/*', j)) {
        j = skipTrivia(source, j) - 1
        continue
      }
      if (c === '{') braces += 1
      else if (c === '}') {
        braces -= 1
        if (braces === 0) return source.slice(body.start, j + 1)
      }
    }
    return source.slice(body.start)
  }

  // A concise arrow body ends at the first `;` outside every bracket, or at the first newline
  // outside every bracket whose next line does not continue the expression (`.where(...)`).
  let depth = 0
  for (let j = body.start; j < source.length; j += 1) {
    const c = source[j]
    if (c === '"' || c === "'" || c === '`') {
      j = skipString(source, j) - 1
      continue
    }
    if (source.startsWith('//', j) || source.startsWith('/*', j)) {
      j = skipTrivia(source, j) - 1
      continue
    }
    if (c === '(' || c === '[' || c === '{') depth += 1
    else if (c === ')' || c === ']' || c === '}') depth -= 1
    else if (depth === 0 && c === ';') return source.slice(body.start, j)
    else if (depth === 0 && c === '\n') {
      const next = skipTrivia(source, j + 1)
      if (next >= source.length || !CONTINUATION.test(source.slice(next, next + 12)))
        return source.slice(body.start, j)
    }
  }
  return source.slice(body.start)
}

/** Every balanced `{...}` that a `.select(` opens, as raw text. */
function selectProjections(body) {
  const projections = []
  const re = /\.select\(\s*\{/g
  let match
  while ((match = re.exec(body)) !== null) {
    const open = body.indexOf('{', match.index)
    let depth = 0
    for (let j = open; j < body.length; j += 1) {
      const c = body[j]
      if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) {
          projections.push(body.slice(open + 1, j))
          break
        }
      }
    }
  }
  return projections
}

/** Top-level `key: value` entries of a projection object, values only. */
function projectionValues(projection) {
  const values = []
  let depth = 0
  let entryStart = 0
  const entries = []
  for (let i = 0; i < projection.length; i += 1) {
    const c = projection[i]
    if (c === '{' || c === '(' || c === '[') depth += 1
    else if (c === '}' || c === ')' || c === ']') depth -= 1
    else if (c === ',' && depth === 0) {
      entries.push(projection.slice(entryStart, i))
      entryStart = i + 1
    }
  }
  entries.push(projection.slice(entryStart))
  for (const entry of entries) {
    if (!entry.trim()) continue
    const colon = entry.indexOf(':')
    // Shorthand (`id,`) is a plain column, never an aggregate.
    values.push(colon === -1 ? entry : entry.slice(colon + 1))
  }
  return values
}

/**
 * True when every select in the body projects aggregates only. `.select()` with no projection
 * selects every column, so it can never be an aggregate.
 */
function isScalarAggregate(body) {
  if (/\.select\(\s*\)/.test(body)) return false
  const projections = selectProjections(body)
  if (projections.length === 0) return false
  return projections.every((projection) => {
    const values = projectionValues(projection)
    return values.length > 0 && values.every((value) => AGGREGATE_VALUE.test(value))
  })
}

const files = await collectSourceFiles(srcRoot)
const unbounded = []
const aggregates = []
const exempted = []
// Reported by --mixed only, and deliberately not part of the JSON summary: a `.limit(` anywhere in
// a body satisfies this heuristic, so a function that bounds one lookup and lists another
// unbounded reads as bounded. `loadAccountExportSource` is the live example.
const mixed = []

for (const absolutePath of files) {
  const path = relative(root, absolutePath).split(sep).join('/')
  const raw = await readFile(absolutePath, 'utf8')
  const source = raw.replace(NON_DRIZZLE_FROM, '')
  const lines = source.split('\n')

  let offset = 0
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber]
    const lineStart = offset
    offset += line.length + 1

    const signature = EXPORTED_FUNCTION.exec(line)
    if (!signature) continue
    const name = signature[1] ?? signature[2]

    const rawBody = extractBody(source, lineStart)
    if (!rawBody) continue
    const body = stripComments(rawBody)
    if (!LIST_READ.test(body)) continue

    const entry = { path, line: lineNumber + 1, name }

    if (HAS_LIMIT.test(body)) {
      const selects = (body.match(/\.select\(/g) ?? []).length
      const limits = (body.match(/\.limit\(/g) ?? []).length
      if (selects > limits) mixed.push({ ...entry, selects, limits })
      continue
    }

    if (isScalarAggregate(body)) {
      aggregates.push(entry)
      continue
    }

    // The exemption is the comment block directly above the signature, so a reason cannot drift
    // away from the function it excuses.
    let reason = null
    for (let above = lineNumber - 1; above >= 0; above -= 1) {
      const candidate = lines[above].trim()
      if (candidate === '') break
      const match = EXEMPTION.exec(candidate)
      if (match) {
        reason = match[1].trim()
        break
      }
      if (!candidate.startsWith('//') && !candidate.startsWith('*') && !candidate.startsWith('/*'))
        break
    }
    if (reason) {
      exempted.push({ ...entry, reason })
      continue
    }

    unbounded.push(entry)
  }
}

const byPath = (a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path))

if (wantList) {
  for (const entry of unbounded.sort(byPath)) {
    console.log(`${entry.path}:${entry.line} ${entry.name}`)
  }
  if (wantAggregates) {
    console.log('\n--- aggregates (exempt by nature) ---')
    for (const entry of aggregates.sort(byPath)) {
      console.log(`${entry.path}:${entry.line} ${entry.name}`)
    }
    console.log('\n--- exempted (unbounded-read-ok) ---')
    for (const entry of exempted.sort(byPath)) {
      console.log(`${entry.path}:${entry.line} ${entry.name} — ${entry.reason}`)
    }
  }
  console.log('')
}

if (wantMixed) {
  console.log('--- more selects than limits (heuristic blind spot, not counted below) ---')
  for (const entry of mixed.sort(byPath)) {
    console.log(`${entry.path}:${entry.line} ${entry.name} — ${entry.selects} selects, ${entry.limits} limits`)
  }
  console.log('')
}

console.log(
  JSON.stringify({
    unbounded: unbounded.length,
    aggregates: aggregates.length,
    exempted: exempted.length,
  }),
)

// Report-only. Plan 13 replaces this with a non-zero exit above a committed baseline.
process.exit(0)
