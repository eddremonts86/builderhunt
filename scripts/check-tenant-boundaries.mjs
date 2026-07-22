import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = process.cwd()
const sourceRoot = join(root, 'src')
const legacyDirectDbImports = new Set([
])
const authDbAllowlist = new Set([
  'src/shared/lib/auth/better-auth.ts',
  'src/shared/lib/auth/personal-organization.ts',
  'src/shared/lib/auth/tenant-principal.ts',
  'src/shared/lib/db/auth-db.ts',
  // Both need narrow, specific reads/deletes against auth_users/auth_accounts/etc.
  // (account-subject export/deletion; digest-email address lookup) that
  // builderhunt_app/builderhunt_worker have no grant for post auth-broker
  // (drizzle/0007_auth_broker.sql) — see account-privacy.test.ts for the
  // FK-safe two-transaction delete order this depends on.
  'src/shared/lib/repositories/account-privacy.ts',
  'src/shared/lib/repositories/alerts-worker.ts',
])
// Global-public data/health surfaces are explicitly allowed to read the
// unscoped runtime db directly (static or dynamic import) — they never
// touch tenant-private tables and select only allowlisted public columns.
const globalDbAllowlist = new Set([
  'src/routes/api/status/index.ts',
  'src/shared/lib/public-data.ts',
])
// Only these pre-existing files compare `.role` against a role literal
// directly. Everything else — including all Team-account UI/route files —
// must call `can()` from authorization/permissions.ts instead of
// reimplementing role logic inline (plans/team-accounts/tasks.md's own
// "Lock Team consumers to foundation contracts" requirement).
const roleLiteralCheckAllowlist = new Set([
  'src/shared/lib/authorization/permissions.ts',
  'src/shared/lib/auth/organization-lifecycle.ts',
  // contracts.ts IS the foundation's allowlisted export surface (see its own
  // top-of-file comment) — its per-target-role helpers (canRemoveMember,
  // etc.) exist precisely so Team UI files never need a literal comparison
  // of their own, mirroring permissions.ts's `can()` rationale exactly.
  'src/shared/lib/organizations/contracts.ts',
  'src/routes/api/builders/$builderId/evidence/$evidenceId.ts',
])
const roleLiteralCheckPattern = /\.role\s*(===|!==)\s*['"]/

const files = await sourceFiles(sourceRoot)
const actualLegacy = new Set()
const findings = []
const globalDbImportPattern = /(?:from\s+['"]~\/shared\/lib\/db\/index['"]|import\(\s*['"]~\/shared\/lib\/db\/index['"]\s*\))/

for (const absolutePath of files) {
  const path = relative(root, absolutePath)
  const source = await readFile(absolutePath, 'utf8')
  const importsGlobalDb = globalDbImportPattern.test(source)
  if (importsGlobalDb && !globalDbAllowlist.has(path)) {
    actualLegacy.add(path)
    if (!legacyDirectDbImports.has(path)) findings.push(`${path}: new global db import (static or dynamic)`)
    if (path.includes('/repositories/')) findings.push(`${path}: tenant repository imports global db`)
  }
  if (/from\s+['"][^'"]*auth-db['"]/.test(source) && !authDbAllowlist.has(path)) {
    findings.push(`${path}: auth broker import is not allowlisted`)
  }
  if (roleLiteralCheckPattern.test(source) && !roleLiteralCheckAllowlist.has(path)) {
    findings.push(`${path}: role literal comparison outside permissions.ts — use can() instead`)
  }
}

for (const baselinePath of legacyDirectDbImports) {
  if (!actualLegacy.has(baselinePath)) {
    findings.push(`${baselinePath}: remove migrated path from the legacy boundary baseline`)
  }
}

if (findings.length > 0) {
  console.error(findings.sort().join('\n'))
  process.exitCode = 1
} else {
  console.log(`Tenant boundary ratchet passed (${legacyDirectDbImports.size} legacy imports tracked)`)
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : []
  }))
  return nested.flat()
}
