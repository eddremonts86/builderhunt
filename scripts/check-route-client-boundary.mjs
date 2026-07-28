#!/usr/bin/env node
/**
 * A route module must not export a symbol that reaches the server layer.
 *
 * TanStack Start's dev transform strips a route file's `server.handlers` and the imports only that block
 * referenced. It cannot strip an *exported* symbol — so if an exported helper references a binding imported
 * from the server layer, that import survives into the client bundle. `db/client` imports the `postgres`
 * driver, which calls `Buffer.allocUnsafe` at module scope, so the browser throws
 * `ReferenceError: Buffer is not defined` before any application code runs: SSR markup arrives and nothing
 * hydrates — no navigation, no theme toggle, nothing. The whole application, from one `export`.
 *
 * That happened on 2026-07-28: `report.ts` exported an `errorResponse` that did `instanceof
 * ReportServiceError`, and **nothing caught it**. Type-check, lint, 4236 unit tests and a production build
 * all passed while every page was dead — the build's tree-shaking is precise where the dev transform is
 * not, so no build artifact reveals it. Hence a static check.
 *
 * ## Why the rule is about *references*, not exports
 *
 * A blunt "export only `Route`" rule flags 18 existing symbols, almost all harmless: `toSessionDto` takes a
 * row and returns fields, so the transform still strips its file's repository import. Measured, not assumed
 * — every interview route reports clean with those exports in place. What breaks is an exported symbol
 * whose *body* names something from the server layer, so that is what this checks.
 *
 * Usage: node scripts/check-route-client-boundary.mjs
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = process.cwd()
const routesRoot = join(root, 'src/routes')

/**
 * Module specifiers whose bindings must never be reachable from an exported route symbol.
 *
 * These are the entry points to the database and the service layer. `db/client` is the one that actually
 * imports `postgres`; the rest reach it in one or two hops, and listing them keeps the diagnostic close to
 * the import a developer wrote rather than to a driver three levels down.
 */
const SERVER_SPECIFIER = /(db\/(client|tenant-context|worker-db|auth-db|platform-db)|shared\/lib\/repositories\/|shared\/lib\/billing\/|shared\/lib\/storage\/|lib\/interviews\/[a-z-]*service|lib\/scheduling\/|shared\/lib\/auth\/better-auth)/

/**
 * `tenant-principal` is deliberately absent.
 *
 * It reaches the auth database, but through `await import(...)` *inside* `requireTenantPrincipal` — so
 * nothing is evaluated at module load and the browser can hold the module harmlessly. That dynamic import
 * is not an accident of style; it is what lets a dozen route modules export an error helper that does
 * `instanceof TenantAuthorizationError` without dragging a driver into the bundle. Listing it here would
 * flag every one of them for a hazard they do not have.
 */

async function walk(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...await walk(path))
    else if (/\.(ts|tsx)$/.test(entry.name)) found.push(path)
  }
  return found
}

/** Named bindings a statement imports, ignoring `import type` (erased before the browser sees it). */
function serverBindings(source) {
  const bindings = new Map()
  for (const statement of source.split(/\n(?=import\s)/)) {
    if (!/^\s*import\s/.test(statement)) continue
    if (/^\s*import\s+type\s/.test(statement)) continue
    const from = /from\s+'([^']+)'/.exec(statement)
    if (!from || !SERVER_SPECIFIER.test(from[1])) continue
    const braces = /\{([\s\S]*?)\}/.exec(statement)
    if (!braces) continue
    for (const raw of braces[1].split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
      // `type` members inside a value import are still erased.
      if (name && !/^type\s/.test(raw.trim())) bindings.set(name, from[1])
    }
  }
  return bindings
}

/** The body of every exported value declaration, keyed by symbol. `Route` is the route's whole purpose. */
function exportedBodies(source) {
  const bodies = new Map()
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^export\s+(?!type\b|interface\b|\*)(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/
      .exec(lines[index])
    if (!match || match[1] === 'Route') continue
    // To the next top-level declaration, which is where a declaration's body ends in this codebase's style.
    let end = index + 1
    while (end < lines.length && !/^(export\s|const\s|function\s|class\s|interface\s|type\s|\/\*\*)/.test(lines[end])) end += 1
    bodies.set(match[1], lines.slice(index, end).join('\n'))
  }
  return bodies
}

const findings = []
const files = await walk(routesRoot)

for (const path of files) {
  const source = await readFile(path, 'utf8')
  const bindings = serverBindings(source)
  if (bindings.size === 0) continue

  for (const [symbol, body] of exportedBodies(source)) {
    for (const [binding, specifier] of bindings) {
      if (new RegExp(`\\b${binding}\\b`).test(body)) {
        findings.push({ file: relative(root, path), symbol, reaches: binding, from: specifier })
      }
    }
  }
}

const report = { routeFiles: files.length, findings, valid: findings.length === 0 }
console.log(JSON.stringify(report, null, 2))

if (!report.valid) {
  console.error(
    '\nAn exported route symbol references the server layer, so its import cannot be stripped from the\n' +
    'client bundle. Move the helper into src/lib/** and import it from the handler instead.\n' +
    'Symptom if shipped: every page throws "Buffer is not defined" and nothing hydrates.',
  )
  process.exit(1)
}
