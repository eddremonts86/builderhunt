import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const root = process.cwd()
const sourceRoot = join(root, 'src')
const legacyDirectDbImports = new Set([
  'src/lib/alerts/worker.ts',
  'src/routes/api/admin/changelog/$id.ts',
  'src/routes/api/admin/changelog/index.ts',
  'src/routes/api/admin/incidents/$id.ts',
  'src/routes/api/admin/incidents/index.ts',
  'src/routes/api/admin/metrics/index.ts',
  'src/routes/api/admin/plan-requests/index.ts',
  'src/routes/api/admin/roadmap/$id.ts',
  'src/routes/api/admin/roadmap/index.ts',
  'src/routes/api/alerts/index.ts',
  'src/routes/api/alerts/test-trigger.ts',
  'src/routes/api/builders/$builderId.ts',
  'src/routes/api/builders/$builderId/claim.ts',
  'src/routes/api/builders/$builderId/notes.ts',
  'src/routes/api/builders/claim/verify.ts',
  'src/routes/api/builders/recent/index.ts',
  'src/routes/api/builders/track.ts',
  'src/routes/api/changelog/$slug.ts',
  'src/routes/api/changelog/index.ts',
  'src/routes/api/consent/index.ts',
  'src/routes/api/dashboard/stats.ts',
  'src/routes/api/export/builders.ts',
  'src/routes/api/feeds/$searchId.ts',
  'src/routes/api/incidents/index.ts',
  'src/routes/api/me/builder/$builderId.ts',
  'src/routes/api/me/builder/index.ts',
  'src/routes/api/me/builders/index.ts',
  'src/routes/api/me/data-export/$id.ts',
  'src/routes/api/me/data-export/index.ts',
  'src/routes/api/me/plan-changes/index.ts',
  'src/routes/api/queries/index.ts',
  'src/routes/api/recommendations/index.ts',
  'src/routes/api/roadmap/index.ts',
  'src/shared/lib/alerts.ts',
  'src/shared/lib/billing.ts',
  'src/shared/lib/legal.ts',
  'src/shared/lib/tracked-builders.ts',
])
const authDbAllowlist = new Set([
  'src/shared/lib/auth/better-auth.ts',
  'src/shared/lib/auth/tenant-principal.ts',
  'src/shared/lib/db/auth-db.ts',
])

const files = await sourceFiles(sourceRoot)
const actualLegacy = new Set()
const findings = []

for (const absolutePath of files) {
  const path = relative(root, absolutePath)
  const source = await readFile(absolutePath, 'utf8')
  const importsGlobalDb = /from\s+['"]~\/shared\/lib\/db\/index['"]/.test(source)
  if (importsGlobalDb) {
    actualLegacy.add(path)
    if (!legacyDirectDbImports.has(path)) findings.push(`${path}: new global db import`)
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
