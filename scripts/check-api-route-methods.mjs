#!/usr/bin/env node
/**
 * Every API file route must seal the methods it does not implement, and every `Allow` header must be true.
 *
 * ## The defect
 *
 * On a TanStack Start file route, a method with no handler falls through to the route *component*. Every API
 * route here declares `component: () => null`, so an unimplemented method answers **200 with an empty HTML
 * document** — not 404, not 405. A client scripting the endpoint reads 200 and concludes it worked.
 *
 * It was hit twice independently before anyone looked for it: `PATCH /api/solutions/runs/:id`, where a "saved
 * runs are immutable" guarantee silently reported success, and `GET /api/me/builder/:id`, which implements
 * `PATCH` only. A monitor pointed at a POST-only admin trigger had the same problem in reverse — it recorded the
 * worker as healthy while never having run it.
 *
 * ## The two things checked
 *
 * 1. **Sealed.** Every `handlers` object declares `ANY`, the framework's catch-all
 *    (`handlers[method] ?? handlers['ANY']`). One `ANY` covers every method the route does not implement,
 *    including `OPTIONS`, `HEAD`, and any method HTTP gains later. There is no baseline and no allowlist: a route
 *    that answers a page to some verb is never correct, so there is nothing to grandfather.
 *
 * 2. **`Allow` is true.** `methodNotAllowed(['POST'])` states the accepted methods by hand, because deriving them
 *    from the object would sever the contextual typing of every handler's `{ request, params }` argument (tried;
 *    it cost 375 `implicitly any` errors — see `method-not-allowed.ts`). A hand-written list can drift when a
 *    handler is added or removed, and nothing at runtime notices because the 405 is still well-formed. So the
 *    list is compared here against the handlers the file actually declares.
 *
 * A named rejection (`GET: methodNotAllowed(['PATCH'], 'read it at …')`) is a refusal, not an implementation, so
 * it is excluded from what `Allow` must advertise — a route saying "not here, go there" must not then claim to
 * accept the method it just refused.
 *
 * Parsing is done with the TypeScript compiler rather than by hand: a regex scanner written for this check
 * silently mis-read three route files whose quote and comment nesting it got wrong, and reported them as having
 * no handlers at all.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const API_ROOT = join(ROOT, 'src/routes/api')
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const REJECTION_HELPERS = ['methodNotAllowed', 'methodNotAllowedAfter']

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** Object literals assigned to a `handlers:` property. More than one in a file is a shape this check can't judge. */
function findHandlers(sourceFile) {
  const found = []
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'handlers' &&
      ts.isObjectLiteralExpression(node.initializer)
    )
      found.push(node.initializer)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
  return found
}

const rejectionCall = (expression) =>
  ts.isCallExpression(expression) &&
  ts.isIdentifier(expression.expression) &&
  REJECTION_HELPERS.includes(expression.expression.text)
    ? expression
    : null

/** The string literals inside the `allowed` argument, whether passed positionally or as an options property. */
function allowedFrom(call) {
  const [first] = call.arguments
  if (!first) return null
  const array = ts.isArrayLiteralExpression(first)
    ? first
    : ts.isObjectLiteralExpression(first)
      ? first.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'allowed' &&
            ts.isArrayLiteralExpression(property.initializer),
        )?.initializer
      : null
  if (!array) return null
  return array.elements.filter(ts.isStringLiteral).map((element) => element.text)
}

const failures = []
let sealed = 0

for (const file of walk(API_ROOT)) {
  const rel = relative(ROOT, file)
  const source = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const lineOf = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1

  const blocks = findHandlers(sourceFile)
  if (blocks.length === 0) {
    failures.push(`${rel} — no handlers object found. Every file under src/routes/api must declare one.`)
    continue
  }
  if (blocks.length > 1) {
    failures.push(`${rel} — ${blocks.length} handlers objects; this check expects exactly one per route file.`)
    continue
  }

  const properties = blocks[0].properties.filter(ts.isPropertyAssignment).filter((p) => ts.isIdentifier(p.name))
  const implemented = properties
    .filter((p) => METHODS.includes(p.name.text) && !rejectionCall(p.initializer))
    .map((p) => p.name.text)

  const any = properties.find((p) => p.name.text === 'ANY')
  if (!any) {
    failures.push(
      `${rel}:${lineOf(blocks[0])} — no ANY handler, so every method this route does not implement ` +
        `(${METHODS.filter((m) => !implemented.includes(m)).join(', ') || 'OPTIONS'}) answers 200 with an HTML ` +
        'page. Add: ANY: methodNotAllowed([…]) — see src/shared/lib/http/method-not-allowed.ts.',
    )
    continue
  }
  if (!rejectionCall(any.initializer)) {
    failures.push(
      `${rel}:${lineOf(any)} — ANY must be methodNotAllowed(…) or methodNotAllowedAfter(…) so the refusal carries ` +
        'a 405 and an Allow header.',
    )
    continue
  }
  sealed += 1

  // Every hand-written `allowed` list in the file, including named rejections, must match reality.
  const visit = (node) => {
    const call = rejectionCall(node)
    if (call) {
      const listed = allowedFrom(call)
      if (listed === null)
        failures.push(`${rel}:${lineOf(call)} — could not read the allowed list; pass it as an array literal.`)
      else {
        for (const method of listed)
          if (!implemented.includes(method))
            failures.push(
              `${rel}:${lineOf(call)} — Allow lists ${method}, but this file implements no ${method} handler.`,
            )
        for (const method of implemented)
          if (!listed.includes(method))
            failures.push(
              `${rel}:${lineOf(call)} — ${method} is implemented here but missing from Allow, so a caller is told ` +
                'it is not accepted.',
            )
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
}

if (failures.length > 0) {
  process.stderr.write(`api route methods: ${failures.length} problem(s)\n\n`)
  for (const failure of failures) process.stderr.write(`  ${failure}\n`)
  process.stderr.write('\n')
  process.exit(1)
}
process.stdout.write(`api route methods: ${sealed} route(s) sealed with ANY; every Allow header matches its handlers.\n`)
