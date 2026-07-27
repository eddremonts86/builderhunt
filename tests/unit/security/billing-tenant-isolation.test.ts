import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * No `/api/billing/*` routes exist yet (they land in later stripe-billing-platform
 * tasks), so this can't be a route-handler test like `test/security/team-api-isolation.test.ts`
 * — there is nothing to import. Live-role behavioral coverage (tenant A/B isolation,
 * cross-tenant insert/update denial, spoofed-organization rejection, missing-context
 * denial) for these tables is proven against a real disposable Postgres by
 * `scripts/db/verify-rls-local.mjs` under the `pnpm test:rls:local` gate — that
 * script requires manual `RLS_TEST_*_URL` setup and is deliberately NOT run as
 * part of the standard `pnpm vitest run` sweep (see docs/operations/database-migrations.md
 * for why: it can overwrite real role passwords if pointed at the wrong database).
 *
 * What this file DOES check, safely and unconditionally: the actual RLS/GRANT
 * migration text itself has the security properties spec.md requires — RLS
 * enabled+forced on every tenant table, no verb granted to any role that isn't
 * explicitly listed, and in particular that the browser-facing `builderhunt_app`
 * role never receives INSERT/UPDATE on a financial-state table (spec.md: "Browser
 * roles cannot mutate financial state directly"). A regression here (e.g. someone
 * copy-pasting a GRANT block and forgetting to trim it) is caught here without
 * needing a live database.
 */

const migrationPath = join(process.cwd(), 'drizzle/0028_billing_rls_grants.sql')
const migration = readFileSync(migrationPath, 'utf8')

const TENANT_TABLES = [
  'billing_customers',
  'billing_subscriptions',
  'billing_checkout_attempts',
  'billing_credit_grants',
  'billing_credit_reservations',
  'billing_credit_allocations',
  'billing_ledger_entries',
  'billing_provider_usage',
  'billing_auto_recharge_rules',
  'billing_refunds',
  'billing_terms_acceptances',
]

const SYSTEM_TABLES = ['billing_webhook_events', 'billing_reconciliation_runs', 'billing_seller_profiles']

// Financial state — the app role must never get INSERT or UPDATE on these, only SELECT.
const APP_SELECT_ONLY_TABLES = [
  'billing_customers',
  'billing_subscriptions',
  'billing_credit_grants',
  'billing_credit_reservations',
  'billing_credit_allocations',
  'billing_ledger_entries',
  'billing_provider_usage',
]

function grantStatementsTo(role: string): string[] {
  const pattern = new RegExp(`GRANT\\s+([^;]+?)\\s+ON TABLE\\s+([^;]+?)\\s+TO\\s+${role};`, 'g')
  return [...migration.matchAll(pattern)].map((match) => match[0])
}

function tablesGrantedVerb(role: string, verb: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE'): Set<string> {
  const tables = new Set<string>()
  for (const statement of grantStatementsTo(role)) {
    const [, verbs, tableList] = statement.match(new RegExp(`GRANT\\s+([^;]+?)\\s+ON TABLE\\s+([^;]+?)\\s+TO`)) ?? []
    if (!verbs || !tableList) continue
    if (!verbs.split(',').map((value) => value.trim().toUpperCase()).includes(verb)) continue
    for (const table of tableList.split(',').map((value) => value.trim())) tables.add(table)
  }
  return tables
}

describe('billing RLS/grants migration (0028) — static invariants', () => {
  it('enables and forces row level security on every tenant-private table', () => {
    for (const table of TENANT_TABLES) {
      expect(migration).toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`))
      expect(migration).toMatch(new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`))
    }
  })

  it('never enables RLS on a system-operational table (no organization_id column exists)', () => {
    for (const table of SYSTEM_TABLES) {
      expect(migration).not.toMatch(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`))
    }
  })

  it('revokes PUBLIC access from every one of the 14 billing tables', () => {
    const revoked = new Set(
      [...migration.matchAll(/REVOKE ALL ON TABLE\s+([^;]+?)\s+FROM PUBLIC;/g)]
        .flatMap((match) => match[1].split(',').map((value) => value.trim())),
    )
    for (const table of [...TENANT_TABLES, ...SYSTEM_TABLES]) {
      expect(revoked).toContain(table)
    }
  })

  it('never grants INSERT or UPDATE to builderhunt_app on a financial-state table', () => {
    const appInsert = tablesGrantedVerb('builderhunt_app', 'INSERT')
    const appUpdate = tablesGrantedVerb('builderhunt_app', 'UPDATE')
    for (const table of APP_SELECT_ONLY_TABLES) {
      expect(appInsert.has(table)).toBe(false)
      expect(appUpdate.has(table)).toBe(false)
    }
  })

  it('never grants DELETE to any runtime role on any billing table — financial records are never deleted', () => {
    for (const role of ['builderhunt_app', 'builderhunt_worker', 'builderhunt_platform']) {
      expect(tablesGrantedVerb(role, 'DELETE').size).toBe(0)
    }
  })

  it('never grants UPDATE on the append-only ledger to any role', () => {
    for (const role of ['builderhunt_app', 'builderhunt_worker', 'builderhunt_platform']) {
      expect(tablesGrantedVerb(role, 'UPDATE').has('billing_ledger_entries')).toBe(false)
    }
  })

  it('gives builderhunt_app zero access to system-operational tables', () => {
    for (const verb of ['SELECT', 'INSERT', 'UPDATE'] as const) {
      const granted = tablesGrantedVerb('builderhunt_app', verb)
      for (const table of SYSTEM_TABLES) expect(granted.has(table)).toBe(false)
    }
  })

  it('never grants builderhunt_auth any access to billing tables', () => {
    expect(migration).not.toMatch(/TO builderhunt_auth/)
  })

  it('restricts the app role refund insert to a pending, undecided request', () => {
    const insertPolicy = migration.match(/CREATE POLICY billing_refunds_app_insert[\s\S]*?;/)?.[0]
    expect(insertPolicy).toBeDefined()
    expect(insertPolicy).toMatch(/state = 'pending'/)
    expect(insertPolicy).toMatch(/stripe_refund_id IS NULL/)
  })
})
