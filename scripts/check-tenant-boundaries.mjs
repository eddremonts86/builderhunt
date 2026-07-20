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
])
// Global-public data/health surfaces are explicitly allowed to read the
// unscoped runtime db directly (static or dynamic import) — they never
// touch tenant-private tables and select only allowlisted public columns.
const globalDbAllowlist = new Set([
  'src/routes/api/status/index.ts',
  'src/shared/lib/public-data.ts',
])

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
