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
  // The organization lifecycle itself: `organizations`, `organization_members`,
  // `organization_invitations` and `organization_deletion_requests` are
  // auth-broker-owned and RLS-forced by `organization_id`, and this module holds
  // the reads that *discover* those ids (`listMyOrganizations`) plus the seat-limit
  // `for update` lock that must span member and invitation counts in one
  // transaction — neither can run under `withTenantContext`/`builderhunt_app`,
  // which has no grant on those tables post auth-broker (drizzle/0007_auth_broker.sql).
  // It is also the single chokepoint the rest of the app funnels through:
  // `organizations/deletion.ts` calls `hardDeleteOrganization` here precisely so it
  // never opens the broker itself (see that function's doc comment, which already
  // assumed this entry existed). Entitlement reads inside it still go through
  // `withTenantContext` — the split is deliberate, not an oversight.
  'src/shared/lib/auth/organization-lifecycle.ts',
  // Both need narrow, specific reads/deletes against auth_users/auth_accounts/etc.
  // (account-subject export/deletion; digest-email address lookup) that
  // builderhunt_app/builderhunt_worker have no grant for post auth-broker
  // (drizzle/0007_auth_broker.sql) — see account-privacy.test.ts for the
  // FK-safe two-transaction delete order this depends on.
  'src/shared/lib/repositories/account-privacy.ts',
  'src/shared/lib/repositories/alerts-worker.ts',
  // Narrow, read-only worker access to auth_sessions.ip_address for linked-account clustering
  // (abuse/linked-accounts.ts, plans/phase-1/32-abuse-and-usage-integrity/tasks.md Phase 3) — same exception
  // shape as the two files above, not a general auth-db opening.
  'src/shared/lib/repositories/auth-sessions-worker.ts',
  // `findOrganizationOwnerEmail` joins `organization_members`/`auth_users` to resolve the one email
  // Stripe checkout ever sends — both auth-broker-owned, neither builderhunt_app nor
  // builderhunt_worker has a grant on them post auth-broker (drizzle/0007_auth_broker.sql;
  // drizzle/0010_worker_alert_policies.sql grants the worker only `auth_users(id, email)`, not
  // organization_members). Found 2026-07-31 exercising a real Stripe test-mode checkout live —
  // every prior test ran as the migration superuser, which bypasses the missing grant entirely.
  'src/shared/lib/repositories/billing.ts',
  // `listBuilderClaimsForAdmin` resolves a claimant's name/email for the platform-admin claims
  // projection (plans/UI/tasks.md Wave 4). auth_users is auth-broker-owned; neither `publicDb` nor
  // `TenantTransaction` has a grant on it post auth-broker (drizzle/0007_auth_broker.sql). Resolved
  // through a second, id-scoped query, same shape as `organization-lifecycle.ts`'s
  // `resolveActorDisplayNames` — found live (permission denied for table auth_users) exercising the
  // route against the real e2e role, not the migration superuser.
  'src/shared/lib/repositories/builder-claims.ts',
])
// Global-public data/health surfaces are explicitly allowed to read the
// unscoped runtime db directly (static or dynamic import) — they never
// touch tenant-private tables and select only allowlisted public columns.
const globalDbAllowlist = new Set([
  'src/routes/api/status/index.ts',
  // Same exception as the route above, relocated by a refactor rather than newly granted: the
  // status-and-trust Phase 1 work moved `/api/status`'s inline `SELECT 1` liveness probe into this
  // shared module so the snapshot worker stops duplicating it. The import moved; what it reaches did
  // not — `checkDb` runs `SELECT 1` and touches no tenant-private table.
  'src/shared/lib/status.ts',
  'src/shared/lib/public-data.ts',
])
// Only these pre-existing files compare `.role` against a role literal
// directly. Everything else — including all Team-account UI/route files —
// must call `can()` from authorization/permissions.ts instead of
// reimplementing role logic inline (plans/phase-1/27-team-accounts/tasks.md's own
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
// A role decision has three equivalent spellings — `membership.role === 'owner'`,
// a destructured `const { role } = membership; role === 'owner'`, and the
// Yoda-style `'owner' === membership.role`. Matching only the first would make
// this rule a suggestion rather than a boundary, the same way the auth-broker
// rule below was one until it learned to read dynamic imports.
const roleReadPattern = String.raw`(?:[\w$.?]*\.role\b|\[['"]role['"]\]|(?<![\w$.])role\b)`
const roleLiteralCheckPattern = new RegExp(
  `(?:${roleReadPattern}\\s*(?:===|!==)\\s*['"]|['"][^'"\\n]*['"]\\s*(?:===|!==)\\s*${roleReadPattern})`,
)

const files = await sourceFiles(sourceRoot)
const actualLegacy = new Set()
const findings = []
// `from '<specifier>'` and `await import('<specifier>')` reach exactly the same
// module, so every import rule here must match both forms. The auth-broker rule
// matched only the static one until 2026-07-27, which is how
// `auth/organization-lifecycle.ts`'s ten dynamic `import('../db/auth-db')` call
// sites used the privileged connection while this gate reported clean.
function importPattern(specifier) {
  return new RegExp(String.raw`(?:from\s+|import\s*\(\s*)['"](?:${specifier})(?:\.[jt]sx?)?['"]`)
}
// Relative and aliased spellings resolve to the same barrel, and so does the bare
// directory (`~/shared/lib/db` → `db/index.ts`) — pinning the rule to one literal
// specifier would leave three ways around it.
const globalDbImportPattern = importPattern(String.raw`[^'"]*\/db\/index|[^'"]*\/db`)
const authDbImportPattern = importPattern(String.raw`[^'"]*auth-db`)

for (const absolutePath of files) {
  const path = relative(root, absolutePath)
  const source = await readFile(absolutePath, 'utf8')
  const importsGlobalDb = globalDbImportPattern.test(source)
  if (importsGlobalDb && !globalDbAllowlist.has(path)) {
    actualLegacy.add(path)
    if (!legacyDirectDbImports.has(path)) findings.push(`${path}: new global db import (static or dynamic)`)
    if (path.includes('/repositories/')) findings.push(`${path}: tenant repository imports global db`)
  }
  if (authDbImportPattern.test(source) && !authDbAllowlist.has(path)) {
    findings.push(`${path}: auth broker import (static or dynamic) is not allowlisted`)
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
