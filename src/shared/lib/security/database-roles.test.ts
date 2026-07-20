import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migrationPath = resolve(process.cwd(), 'drizzle/0002_database_roles.sql')

describe('database role migration', () => {
  it('defines distinct owner, web, worker, and readonly roles', async () => {
    const sql = await readFile(migrationPath, 'utf8')
    for (const role of ['builderhunt_owner', 'builderhunt_app', 'builderhunt_worker', 'builderhunt_readonly']) {
      expect(sql).toContain(role)
    }
  })

  it('makes runtime identities non-privileged and unable to bypass RLS', async () => {
    const sql = (await readFile(migrationPath, 'utf8')).toUpperCase()
    for (const role of ['BUILDERHUNT_APP', 'BUILDERHUNT_WORKER', 'BUILDERHUNT_READONLY']) {
      expect(sql).toMatch(new RegExp(`ALTER ROLE ${role}[^;]*NOSUPERUSER[^;]*NOCREATEDB[^;]*NOCREATEROLE[^;]*NOBYPASSRLS`))
    }
    expect(sql).not.toMatch(/GRANT\s+(CREATE|TRUNCATE|ALTER|DROP)/)
  })

  it('revokes implicit public schema and object privileges', async () => {
    const sql = (await readFile(migrationPath, 'utf8')).toUpperCase()
    expect(sql).toContain('REVOKE CREATE ON SCHEMA PUBLIC FROM PUBLIC')
    expect(sql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA PUBLIC FROM PUBLIC')
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES')
  })
})
