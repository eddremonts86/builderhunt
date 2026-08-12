// The analysis behind `scripts/check-unbounded-reads.mjs`, separated from the CLI so it can be
// tested against source strings instead of against scratch files in `src/`.
//
// Plan 01's validation task asked for "scratch fixtures ... scratch files are removed", which is a
// procedure rather than a regression test: the fixtures prove the detector behaved on the afternoon
// somebody ran them and then delete the evidence. Six of them live in
// `tests/unit/scripts/lib/unbounded-reads.test.ts` instead, as permanent cases that run in
// `ci:local` — including the three the text-matching predecessor got wrong.
//
// A read is unbounded when its **own call chain** declares no bound. Associating the bound with the
// chain rather than with the enclosing function body is the whole reason this parses: `.limit(`
// anywhere in a body used to count, so a function that bounded one lookup and listed another read
// as compliant.
import tsModule from 'typescript'

const ts = tsModule.default ?? tsModule

/**
 * A scalar aggregate returns a number, not rows, so it has nothing to bound. Only a projection
 * whose every field is an aggregate qualifies — a projection that aggregates *and* selects a column
 * is a list read (`plans/phase-3/01-read-path-audit/spec.md`, "Resolved edge cases").
 */
const AGGREGATE_VALUE = /\b(?:count|sum|avg|min|max)\s*\(|\bcount\b\s*\(\s*\)|::(?:bigint|int|numeric)\b/i

const EXEMPTION = /\/\/\s*unbounded-read-ok:\s*(\S.*)$/

/** Files with none of these tokens cannot contain the shape, so they are never parsed. */
export const MIGHT_CONTAIN_READ = /\.select\w*\s*\(|\.findMany\s*\(/

/**
 * The method names of the call chain ending at `call`, outermost first.
 *
 * `db.select({…}).from(t).where(…).limit(50)` is nested call expressions: the outermost is
 * `.limit(50)`, whose callee is a property access on the `.where(…)` call, and so on down to the
 * `db` identifier. Walking that spine — and only that spine — is what makes a bound belong to this
 * query rather than to whatever else the enclosing function does.
 */
function chainOf(call) {
  const methods = []
  const selectCalls = []
  const findManyCalls = []
  let cur = call
  while (ts.isCallExpression(cur)) {
    const callee = cur.expression
    if (!ts.isPropertyAccessExpression(callee)) break
    const name = callee.name.text
    methods.push(name)
    // `selectDistinct` and `selectDistinctOn` are list reads exactly like `select`, and missing them
    // was a live gap: `listNotedOrganizationBuilders` opens with
    // `selectDistinct({ builderId }).from(builderNotes)` over a whole organization's notes, and that
    // read was invisible while the *second* query in the same function was reported.
    if (name === 'select' || name === 'selectDistinct' || name === 'selectDistinctOn') selectCalls.push(cur)
    else if (name === 'findMany') findManyCalls.push(cur)
    cur = callee.expression
  }
  return { methods, selectCalls, findManyCalls }
}

/** True when `call` is the outermost call of its chain, so each chain is visited exactly once. */
function isChainRoot(call) {
  const parent = call.parent
  if (!parent || !ts.isPropertyAccessExpression(parent)) return true
  return !(
    parent.expression === call
    && parent.parent
    && ts.isCallExpression(parent.parent)
    && parent.parent.expression === parent
  )
}

function isExported(node) {
  return Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword))
}

/**
 * The nearest enclosing name, exported or not.
 *
 * The text-matching predecessor recognised only `export function` and `export const`, which is why
 * a read in a non-exported helper or in a `{ GET: async () => … }` route handler counted zero. Both
 * shapes serve requests.
 */
export function scopeOf(node) {
  let cur = node.parent
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) {
      return { name: cur.name.text, exported: isExported(cur), kind: 'function' }
    }
    if (ts.isMethodDeclaration(cur) && cur.name && ts.isIdentifier(cur.name)) {
      return { name: cur.name.text, exported: false, kind: 'method' }
    }
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && cur.parent) {
      const owner = cur.parent
      if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) {
        const statement = owner.parent?.parent
        return {
          name: owner.name.text,
          exported: statement ? isExported(statement) : false,
          kind: 'const',
        }
      }
      if (
        ts.isPropertyAssignment(owner)
        && (ts.isIdentifier(owner.name) || ts.isStringLiteral(owner.name))
      ) {
        // A route handler object: `{ GET: async ({ request }) => … }`.
        return { name: owner.name.text, exported: false, kind: 'handler' }
      }
    }
    cur = cur.parent
  }
  return { name: '<module scope>', exported: true, kind: 'module' }
}

/** The statement a node sits in, which is the outermost place an `unbounded-read-ok:` may sit. */
function statementOf(node) {
  let cur = node
  while (cur?.parent && !ts.isSourceFile(cur.parent) && !ts.isBlock(cur.parent) && !ts.isModuleBlock(cur.parent)) {
    cur = cur.parent
  }
  return cur ?? node
}

/**
 * The reason on an `unbounded-read-ok:` comment governing this read, or null.
 *
 * Checked innermost-first — the read's own chain, then each enclosing expression, and only last the
 * whole statement. Granularity is the point: `loadAccountExportSource` assembles five reads inside
 * one `Promise.all`, so a statement-level exemption would silently excuse a sixth read that somebody
 * adds to that array later. An exemption should cover the read whose reason it states and nothing
 * else.
 */
function exemptionFor(node, text) {
  const statement = statementOf(node)
  let cur = node
  for (;;) {
    const comments = ts.getLeadingCommentRanges(text, cur.pos) ?? []
    for (const comment of comments) {
      const match = EXEMPTION.exec(text.slice(comment.pos, comment.end))
      if (match) return match[1].trim()
    }
    if (cur === statement || !cur.parent) return null
    cur = cur.parent
  }
}

/**
 * True when every property of every `.select({…})` in the chain is an aggregate.
 *
 * `.select()` with no projection selects every column, so it can never be an aggregate. A
 * projection mixing `count()` with a plain column is a list read: `pageSprints` selects
 * `{ sprintId, value: count() }` and is grouped, so it returns rows.
 */
function isScalarAggregate(selectCalls, text) {
  if (selectCalls.length === 0) return false
  return selectCalls.every((call) => {
    const arg = call.arguments[0]
    if (!arg || !ts.isObjectLiteralExpression(arg) || arg.properties.length === 0) return false
    return arg.properties.every((property) => {
      // Shorthand (`{ id }`) is a plain column, never an aggregate.
      if (!ts.isPropertyAssignment(property)) return false
      return AGGREGATE_VALUE.test(text.slice(property.initializer.pos, property.initializer.end))
    })
  })
}

/**
 * Classify every Drizzle list read in one source text.
 *
 * @param {{ path: string, text: string }} input
 * @returns {{ unbounded: object[], aggregates: object[], exempted: object[] }}
 */
export function analyzeSource({ path, text }) {
  const unbounded = []
  const aggregates = []
  const exempted = []
  if (!MIGHT_CONTAIN_READ.test(text)) return { unbounded, aggregates, exempted }

  const sourceFile = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    /\.tsx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )

  const visit = (node) => {
    if (!ts.isCallExpression(node) || !isChainRoot(node)) {
      ts.forEachChild(node, visit)
      return
    }

    const { methods, selectCalls, findManyCalls } = chainOf(node)

    // A Drizzle list read is `select` together with `from`, or the relational `findMany`. Requiring
    // both makes two documented false positives structurally impossible rather than excluded by
    // name: `inputRef.current.select()` is the DOM method (which needed a file-level "does this
    // file reach a database" regex) and `Buffer.from(…)` (which needed a strip list).
    const isSelectRead = selectCalls.length > 0 && methods.includes('from')
    const isFindManyRead = findManyCalls.length > 0

    if (isSelectRead || isFindManyRead) {
      // `.limit()` bounds the query builder. `findMany` takes no `.limit()` method — its bound is a
      // `limit` property in the argument object.
      const chainLimited = methods.includes('limit')
      const findManyLimited = findManyCalls.some((call) => {
        const arg = call.arguments[0]
        if (!arg || !ts.isObjectLiteralExpression(arg)) return false
        return arg.properties.some((p) => p.name && ts.isIdentifier(p.name) && p.name.text === 'limit')
      })

      if (!chainLimited && !findManyLimited) {
        const scope = scopeOf(node)
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
        const entry = { path, line: line + 1, name: scope.name, kind: scope.kind, exported: scope.exported }

        if (isSelectRead && isScalarAggregate(selectCalls, text)) {
          aggregates.push(entry)
        } else {
          const reason = exemptionFor(node, text)
          if (reason) exempted.push({ ...entry, reason })
          else unbounded.push(entry)
        }
      }
    }

    // Descend into arguments only. The chain spine is accounted for, and walking it again would
    // report one read once per method call in it.
    for (const argument of node.arguments) visit(argument)
    let callee = node.expression
    while (ts.isPropertyAccessExpression(callee)) {
      if (ts.isCallExpression(callee.expression)) {
        for (const argument of callee.expression.arguments) visit(argument)
        callee = callee.expression.expression
      } else {
        visit(callee.expression)
        break
      }
    }
  }

  ts.forEachChild(sourceFile, visit)
  return { unbounded, aggregates, exempted }
}
