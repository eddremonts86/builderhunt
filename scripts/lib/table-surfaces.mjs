// The analysis half of `check-table-surfaces`, split out so it can be tested against source text
// rather than against whatever the repository happens to contain today.
//
// The predecessor was one file that walked `src/` and asserted on the totals it printed. That
// proves the gate agreed with the codebase on the afternoon somebody ran it, and it cannot prove
// the gate would *catch* anything — which matters here, because two of the twenty-three
// "table-bearing files" it used to report were prose comments containing the word `<table>`, and
// nothing about the numbers looked wrong.
//
// See `scripts/check-table-surfaces.mjs` for what each rule is for.

export const MARKERS = {
  capability: /\/\/\s*table-surface:\s*(\w+)/,
  bounded: /\/\/\s*table-surface-bounded:\s*(\S.*)$/m,
  semantic: /\/\/\s*table-surface-semantic:\s*(\S.*)$/m,
  srOnly: /\/\/\s*table-surface-sr-only:\s*(\S.*)$/m,
  email: /\/\/\s*table-surface-email:\s*(\S.*)$/m,
  exempt: /\/\/\s*table-surface-ok:\s*(\S.*)$/m,
}

/** The one file allowed to write a visible `<table>`; every other one renders through it. */
export const SEMANTIC_PRIMITIVE = 'src/shared/components/table/SemanticTable.tsx'

/** Where the table shell lives. Nothing in here may name a colour. */
export const SHELL_DIRECTORY = 'src/shared/components/table/'

const INSTANCE_PATTERNS = {
  interactive: /<DataTable\b/g,
  semantic: /<SemanticTable\b/g,
  raw: /<table[\s>]/g,
}

/** A raw `<table>` whose class list makes it invisible. Semantics only; no visual contract. */
const SR_ONLY_TABLE = /<table[^>]*className=["'][^"']*\bsr-only\b/

/**
 * A colour named in the shell: hex literals, `rgb()`/`hsl()` calls, and the app's own `bh-*`
 * colour utilities. The last one because `text-bh-text-muted` in a table cell is how the shell
 * ended up with two muted greys, one of which tracked the table contract and one of which did not.
 */
const SHELL_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(|\b(?:text|bg|border|ring|fill|stroke|from|to|via)-bh-[\w-]+/

/**
 * A `className` on a table call site that paints or pads rather than places.
 *
 * `mb-8`, `flex-1`, `max-w-3xl`, `w-full` — outside the box, the surface's business. `bg-`,
 * `border-`, `p-`, `rounded-`, `shadow-`, `text-` — inside the box, the token contract's.
 * `text-left`/`right`/`center` are alignment rather than ink, and stay allowed.
 */
const RESTYLING_UTILITY = /(?:^|\s)(?:bg-|border(?:-[a-z]|\s|$)|p-|px-|py-|pt-|pb-|pl-|pr-|rounded|shadow|text-(?!left|right|center)|divide-|gap-)/

/**
 * The source with its comments blanked out, line count preserved.
 *
 * Without this the gate counted `DataTable.tsx`'s "why a div tree and not a `<table>`" and
 * `OperationsPage.tsx`'s explanation of the same choice as two table instances. Blanking rather
 * than deleting keeps every marker on the line its author put it on.
 */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length))
}

/**
 * Every literal `className="…"` inside a `<DataTable …>` or `<SemanticTable …>` opening tag.
 *
 * Deliberately literal-only: a `className={cn(...)}` expression cannot be judged from source, and
 * guessing at one would either wave through the real cases or fail honest ones. The rule this
 * enforces is about the easy accidental override, which is always written as a string.
 */
export function tableCallSiteClassNames(source) {
  const found = []
  const openings = /<(?:DataTable|SemanticTable)\b/g
  let match
  while ((match = openings.exec(source)) !== null) {
    for (const attribute of openingTagAttributes(source, match.index).matchAll(/className=["']([^"']*)["']/g)) {
      found.push(attribute[1])
    }
  }
  return found
}

/**
 * One JSX opening tag's own attributes, with everything inside `{…}` blanked out.
 *
 * Two failures this shape exists for, and both of them were live:
 *
 * `indexOf('>')` truncates at the arrow in `rowTestId={(row) => row.id}`, which almost every call
 * site in the app passes *before* its `className`. The rule then inspected nothing on exactly the
 * multi-line calls it exists for — green, and enforcing nothing.
 *
 * Scanning past that but keeping brace contents is the opposite error: `emptyState={<div
 * className="px-4 py-12 text-center" />}` is a padded, centred *empty state*, which is the
 * surface's own composition and not a restyling of the table. Reading it as the table's className
 * failed sixteen honest surfaces at once.
 *
 * So: track brace depth and string literals, blank anything at depth > 0, and stop at the first
 * `>` outside both. Bounded so a malformed file cannot spin.
 */
function openingTagAttributes(source, start) {
  const limit = Math.min(source.length, start + 8000)
  const attributes = []
  let depth = 0
  let quote = null
  for (let index = start; index < limit; index += 1) {
    const character = source[index]
    if (quote !== null) {
      attributes.push(depth === 0 ? character : ' ')
      if (character === '\\') { attributes.push(' '); index += 1 }
      else if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      attributes.push(depth === 0 ? character : ' ')
      continue
    }
    if (character === '{') { depth += 1; attributes.push(' '); continue }
    if (character === '}') { depth -= 1; attributes.push(' '); continue }
    if (character === '>' && depth === 0) break
    attributes.push(depth === 0 ? character : ' ')
  }
  return attributes.join('')
}

/**
 * Classify one file's table instances and report what is wrong with them.
 *
 * Returns `null` when the file renders no table at all. Otherwise `{ path, kind, detail, counts,
 * problems }` — `problems` being the complete list of reasons this file would fail the gate, so a
 * caller sees every one rather than the first.
 */
export function analyzeSource({ path, text, capabilities = new Set() }) {
  const source = stripComments(text)

  const counts = {
    interactive: [...source.matchAll(INSTANCE_PATTERNS.interactive)].length,
    semantic: [...source.matchAll(INSTANCE_PATTERNS.semantic)].length,
    raw: [...source.matchAll(INSTANCE_PATTERNS.raw)].length,
  }
  const total = counts.interactive + counts.semantic + counts.raw
  if (total === 0) return null

  const problems = []

  // Markers are read from the *unstripped* source: they are comments.
  const capability = MARKERS.capability.exec(text)
  const bounded = MARKERS.bounded.exec(text)
  const semantic = MARKERS.semantic.exec(text)
  const srOnly = MARKERS.srOnly.exec(text)
  const email = MARKERS.email.exec(text)
  const exempt = MARKERS.exempt.exec(text)
  const declared = [capability, bounded, semantic, srOnly, email, exempt].filter(Boolean)

  if (declared.length === 0) {
    problems.push({
      rule: 'undeclared',
      message:
        `${path} renders ${total} table instance${total === 1 ? '' : 's'} with no marker. Add one of:\n`
        + '      // table-surface: <someCapability>        (a data grid served by a registered capability)\n'
        + '      // table-surface-bounded: <reason>        (the whole set arrives in one bounded read)\n'
        + '      // table-surface-semantic: <reason>       (a visible native table, through SemanticTable)\n'
        + '      // table-surface-sr-only: <reason>        (a chart\'s screen-reader equivalent)\n'
        + '      // table-surface-email: <reason>          (HTML email output)\n'
        + '      // table-surface-ok: <reason>             (the shell\'s own internals)',
    })
    return { path, kind: null, detail: null, counts, problems }
  }
  if (declared.length > 1) {
    problems.push({
      rule: 'multiple-markers',
      message: `${path} carries more than one table-surface marker — a surface is one of them, not two`,
    })
    return { path, kind: null, detail: null, counts, problems }
  }

  const kind = capability ? 'capability'
    : bounded ? 'bounded'
      : semantic ? 'semantic'
        : srOnly ? 'sr-only'
          : email ? 'email'
            : 'shell'
  const detail = capability ? capability[1] : (bounded ?? semantic ?? srOnly ?? email ?? exempt)[1].trim()

  if (capability && capabilities.size > 0 && !capabilities.has(capability[1])) {
    problems.push({
      rule: 'unregistered-capability',
      message:
        `${path} names capability "${capability[1]}", which is not exported from `
        + 'src/shared/lib/table/capabilities/index.ts',
    })
  }

  // ── No ungoverned table primitive ──────────────────────────────────────────────────────────────
  if (counts.raw > 0 && path !== SEMANTIC_PRIMITIVE) {
    const excused = (kind === 'sr-only' && SR_ONLY_TABLE.test(source)) || kind === 'email'
    if (!excused) {
      problems.push({
        rule: 'ungoverned-table',
        message:
          `${path} writes ${counts.raw} raw <table> element${counts.raw === 1 ? '' : 's'} of its own.\n`
          + '      A visible table renders through <SemanticTable> (src/shared/components/table), which owns the\n'
          + '      header ink, borders, density and scroll region every one of these used to reinvent. The only\n'
          + '      exceptions are a .sr-only chart equivalent and HTML email output, and both declare themselves.',
      })
    }
  }
  if (kind === 'semantic' && counts.semantic === 0) {
    problems.push({
      rule: 'semantic-without-primitive',
      message: `${path} is marked table-surface-semantic but renders no <SemanticTable>`,
    })
  }

  // ── The shell names no colours ─────────────────────────────────────────────────────────────────
  if (path.startsWith(SHELL_DIRECTORY)) {
    source.split('\n').forEach((line, index) => {
      if (!SHELL_COLOUR.test(line)) return
      problems.push({
        rule: 'shell-colour-literal',
        message:
          `${path}:${index + 1} names a colour inside the table shell: ${line.trim().slice(0, 80)}\n`
          + '      Everything the shell draws is a --tbl-* token, so dark mode, the contrast assertions in\n'
          + '      tests/unit/shared/lib/accessibility.test.ts and any future palette change have one place to look.',
      })
    })
  }

  // ── No call site restyles the table from outside ───────────────────────────────────────────────
  for (const className of tableCallSiteClassNames(source)) {
    if (!RESTYLING_UTILITY.test(` ${className}`)) continue
    problems.push({
      rule: 'restyling-classname',
      message:
        `${path} passes a restyling className to a table: "${className}"\n`
        + '      Placing the table from outside is the surface\'s business (mb-8, flex-1, max-w-3xl).\n'
        + '      Painting or padding it is the --tbl-* contract\'s, and a per-surface override is exactly the\n'
        + '      local visual anatomy plan phase-3/14 removed.',
    })
  }

  return { path, kind, detail, counts, problems }
}

/** The ledger totals, in the units the plan asks the gate to report. */
export function summarize(records) {
  const sum = (kind, field) => records
    .filter((record) => record.kind === kind)
    .reduce((total, record) => total + record.counts[field], 0)

  return {
    files: records.length,
    // The unit that matters: rendered tables, including the three files that render two.
    instances: records.reduce(
      (total, record) => total + record.counts.interactive + record.counts.semantic + record.counts.raw,
      0,
    ),
    interactive: records.reduce((total, record) => total + record.counts.interactive, 0),
    semantic: sum('semantic', 'semantic'),
    screenReaderOnly: sum('sr-only', 'raw'),
    email: sum('email', 'raw'),
    capabilities: records.filter((record) => record.kind === 'capability').length,
    bounded: records.filter((record) => record.kind === 'bounded').length,
  }
}
