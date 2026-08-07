import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const tenantSurfaces = [
  'src/routes/api/alerts/index.ts',
  'src/routes/api/alerts/test-trigger.ts',
  'src/routes/api/alerts/triggers/index.ts',
  'src/routes/api/alerts/triggers/$id.ts',
  'src/shared/lib/alerts.ts',
]

describe('organization alerts repository boundary', () => {
  it.each(tenantSurfaces)('%s uses the tenant repository boundary', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain("~/shared/lib/repositories/organization-alerts")
  })

  /**
   * The point is that the route never reads without a tenant principal and a tenant transaction —
   * not that it spells those two calls itself.
   *
   * `tablePageHandler` runs `requireTenantPrincipal` before it parses anything and opens
   * `withTenantContext` around the load (src/shared/lib/table/handler.ts), which is the whole reason
   * it exists. A route whose only handler is that call satisfies this rule while containing neither
   * literal, so accepting it is recognising the guard, not loosening it — the same call
   * `scripts/check-route-coverage.mjs` makes for the same helper.
   */
  it.each(tenantSurfaces.filter((path) => path.startsWith('src/routes/')))('%s derives tenant context', async (path) => {
    const source = await readFile(path, 'utf8')
    const delegated = /\btablePageHandler\b/.test(source)
    expect(delegated || source.includes('requireTenantPrincipal')).toBe(true)
    expect(delegated || source.includes('withTenantContext')).toBe(true)
  })

  it('worker uses the dedicated worker repository', async () => {
    const source = await readFile('src/lib/alerts/worker.ts', 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain("~/shared/lib/repositories/alerts-worker")
  })
})
