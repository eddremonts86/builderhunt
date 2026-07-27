import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `scripts/db/roles.sql` recreates the cluster-level roles that `pg_dump` of a single
 * database cannot contain, so that the `CREATE POLICY ... TO builderhunt_app` statements
 * inside a restored dump have roles to bind to. If it drifts from the migrations, a
 * restore into a fresh cluster silently loses the policies for whichever role went
 * missing — the exact defect the 2026-07-26 restore test found (192 policies not created,
 * while RLS stayed enabled and forced on 54 tables).
 *
 * This test is static text analysis over the migration files, so it runs in the ordinary
 * `pnpm test` sweep with no database — the same approach as
 * `billing-tenant-isolation.test.ts`.
 */

const repoRoot = process.cwd()
const migrationDirectory = join(repoRoot, 'drizzle')
const bootstrapPath = join(repoRoot, 'scripts', 'db', 'roles.sql')

/** Attribute keywords Postgres accepts on CREATE/ALTER ROLE that we care about pinning. */
const attributeKeywords = new Set([
  'LOGIN', 'NOLOGIN',
  'SUPERUSER', 'NOSUPERUSER',
  'CREATEDB', 'NOCREATEDB',
  'CREATEROLE', 'NOCREATEROLE',
  'INHERIT', 'NOINHERIT',
  'REPLICATION', 'NOREPLICATION',
  'BYPASSRLS', 'NOBYPASSRLS',
])

function createdRoles(sql: string): Set<string> {
  const roles = new Set<string>()
  for (const match of sql.matchAll(/CREATE\s+ROLE\s+(builderhunt_[a-z_]+)/gi)) {
    roles.add(match[1].toLowerCase())
  }
  return roles
}

/**
 * Returns the effective attribute set per role: later `ALTER ROLE` statements win, which
 * matches how Postgres actually applies them when the migrations run in order.
 */
function alteredAttributes(sql: string, into: Map<string, Set<string>>) {
  for (const match of sql.matchAll(/ALTER\s+ROLE\s+(builderhunt_[a-z_]+)([^;]*);/gi)) {
    const role = match[1].toLowerCase()
    const attributes = new Set(
      match[2]
        .split(/\s+/)
        .map((token) => token.trim().toUpperCase())
        .filter((token) => attributeKeywords.has(token)),
    )
    if (attributes.size > 0) into.set(role, attributes)
  }
}

async function readMigrations() {
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
  const roles = new Set<string>()
  const attributes = new Map<string, Set<string>>()
  for (const name of names) {
    const sql = await readFile(join(migrationDirectory, name), 'utf8')
    for (const role of createdRoles(sql)) roles.add(role)
    alteredAttributes(sql, attributes)
  }
  return { names, roles, attributes }
}

describe('restore cluster-role bootstrap', () => {
  it('creates exactly the roles the migrations create', async () => {
    const migrations = await readMigrations()
    const bootstrap = createdRoles(await readFile(bootstrapPath, 'utf8'))

    // Sorted arrays rather than set equality so a failure names the drifting role.
    expect([...bootstrap].sort()).toEqual([...migrations.roles].sort())
  })

  it('pins every role to the same attributes the migrations pin', async () => {
    const migrations = await readMigrations()
    const bootstrapAttributes = new Map<string, Set<string>>()
    alteredAttributes(await readFile(bootstrapPath, 'utf8'), bootstrapAttributes)

    for (const [role, expected] of migrations.attributes) {
      const actual = bootstrapAttributes.get(role)
      expect(actual, `scripts/db/roles.sql does not ALTER ROLE ${role}`).toBeDefined()
      expect([...actual!].sort(), `attribute drift on ${role}`).toEqual([...expected].sort())
    }
  })

  it('never grants a restored role SUPERUSER or BYPASSRLS', async () => {
    // A restore that hands the app role BYPASSRLS would defeat every policy in the dump,
    // which is a worse outcome than the missing-policies bug this file exists to fix.
    const bootstrap = await readFile(bootstrapPath, 'utf8')
    const attributes = new Map<string, Set<string>>()
    alteredAttributes(bootstrap, attributes)

    expect(attributes.size).toBeGreaterThan(0)
    for (const [role, set] of attributes) {
      expect(set.has('SUPERUSER'), `${role} must not be SUPERUSER`).toBe(false)
      expect(set.has('BYPASSRLS'), `${role} must not be BYPASSRLS`).toBe(false)
      expect(set.has('NOSUPERUSER'), `${role} must assert NOSUPERUSER`).toBe(true)
      expect(set.has('NOBYPASSRLS'), `${role} must assert NOBYPASSRLS`).toBe(true)
    }
  })

  it('contains no credential material', async () => {
    // Passwords are provisioned from DATABASE_*_URL by `pnpm deploy:db` step 5, and the
    // off-site roles dump is taken with --no-role-passwords for the same reason.
    // Comments are stripped first — the file's own header explains the password policy,
    // and the assertion is about executable SQL, not prose.
    const executableSql = (await readFile(bootstrapPath, 'utf8'))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    expect(executableSql).toMatch(/CREATE ROLE/i)
    expect(executableSql).not.toMatch(/PASSWORD/i)
  })
})
