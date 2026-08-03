#!/usr/bin/env node
/**
 * A route handler must establish who is calling before it validates what they sent.
 *
 * ## The defect
 *
 * `POST /api/organizations` parsed its body first, so an anonymous caller with a malformed body got
 * **400 "Invalid body"** instead of 401. That answer is information: it confirms the endpoint exists and hints at
 * the schema it expects, to someone not entitled to know either. The refusal a stranger sees must not depend on
 * facts they are not entitled to.
 *
 * It was fixed there, and then found again in three more places — `transfer-ownership`, `members/$memberId` and
 * `invitations` — each carrying a comment explaining that the organization comes from the session and not the
 * body, which is true and beside the point. Four instances of a defect that is invisible in review (the two lines
 * look interchangeable) and invisible at runtime (both answers are well-formed) is what a static check is for.
 *
 * ## What is checked
 *
 * Per handler, in each file under `src/routes/api/`: if the body is validated *and* a caller is established, the
 * guard must come first. A handler that does only one of the two is not this check's business — an unauthenticated
 * public route validating its input is correct, and a guarded route with no body has nothing to order.
 *
 * Parsing is done with the TypeScript compiler rather than by position in the file text, so a `safeParse` inside a
 * nested callback or a later branch is attributed to the handler that actually contains it.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const ROOT = process.cwd()
const API_ROOT = join(ROOT, 'src/routes/api')
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ANY']

/** Calls that establish who is calling. Extend when a new guard family appears. */
const GUARDS = [
  'requireTenantPrincipal',
  'requirePlatformAdminPrincipal',
  'requireCapabilityPrincipal',
  'tryCronPrincipal',
  'getSession',
]

/** Calls that validate a client-supplied payload. */
const VALIDATORS = ['safeParse', 'parse']

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full)
  }
  return out
}

/** The name being called, for both `foo()` and `a.b.foo()`. */
function calleeName(node) {
  if (!ts.isCallExpression(node)) return null
  const target = node.expression
  if (ts.isIdentifier(target)) return target.text
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)) return target.name.text
  return null
}

/**
 * The earliest position of any call in `names` within `root`.
 *
 * Position, not source order of the whole file: a handler is one subtree, and `getStart` inside it is directly
 * comparable because both the guard and the validator are looked up in that same subtree.
 */
function firstCallPosition(root, names, sourceFile) {
  let earliest = null
  const visit = (node) => {
    const name = calleeName(node)
    if (name && names.includes(name)) {
      const at = node.getStart(sourceFile)
      if (earliest === null || at < earliest) earliest = at
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return earliest
}

const failures = []
let checked = 0

for (const file of walk(API_ROOT)) {
  const rel = relative(ROOT, file)
  const source = readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)

  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      METHODS.includes(node.name.text) &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      const guardAt = firstCallPosition(node.initializer, GUARDS, sourceFile)
      const validateAt = firstCallPosition(node.initializer, VALIDATORS, sourceFile)
      if (guardAt !== null && validateAt !== null) {
        checked += 1
        if (validateAt < guardAt) {
          const line = sourceFile.getLineAndCharacterOfPosition(validateAt).line + 1
          failures.push(
            `${rel}:${line} — ${node.name.text} validates the body before establishing the caller, so an ` +
              'anonymous request with a malformed body answers 400 (confirming the route and hinting at its ' +
              'schema) instead of 401. Move the guard above the parse.',
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(sourceFile, visit)
}

if (failures.length > 0) {
  process.stderr.write(`authenticate before validate: ${failures.length} problem(s)\n\n`)
  for (const failure of failures) process.stderr.write(`  ${failure}\n`)
  process.stderr.write('\n')
  process.exit(1)
}
process.stdout.write(
  `authenticate before validate: ${checked} handler(s) do both, and every one authenticates first.\n`,
)
