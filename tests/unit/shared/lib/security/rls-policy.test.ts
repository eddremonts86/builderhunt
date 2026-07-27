import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const rlsTables = [
  'organizations',
  'organization_members',
  'organization_invitations',
  'organization_entitlements',
  'organization_plan_changes',
  'organization_builders',
  'builders',
  'saved_queries',
  'alerts',
  'alert_triggers',
  'builder_notes',
  'onboarding_progress',
]

describe('tenant RLS migration', () => {
  it('enables and forces RLS on every tenant table in the expand model', async () => {
    const sql = (await readFile(resolve(process.cwd(), 'drizzle/0008_tenant_rls.sql'), 'utf8')).toLowerCase()
    for (const table of rlsTables) {
      expect(sql).toContain(`alter table ${table} enable row level security`)
      expect(sql).toContain(`alter table ${table} force row level security`)
    }
  })

  it('defaults product policies to the transaction-local organization setting', async () => {
    const sql = (await readFile(resolve(process.cwd(), 'drizzle/0008_tenant_rls.sql'), 'utf8')).toLowerCase()
    expect(sql).toContain("nullif(current_setting('app.organization_id', true), '')")
    expect(sql).toContain('to builderhunt_app')
    expect(sql).toContain('with check')
  })

  it('limits the auth broker exception to Better Auth organization tables', async () => {
    const sql = (await readFile(resolve(process.cwd(), 'drizzle/0008_tenant_rls.sql'), 'utf8')).toLowerCase()
    expect(sql.match(/to builderhunt_auth/g)).toHaveLength(3)
    expect(sql).not.toMatch(/organization_builders_auth|organization_entitlements_auth/)
  })
})
