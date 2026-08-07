import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const tenantRoutes = [
  'src/routes/api/sprints/index.ts',
  'src/routes/api/sprints/$sprintId.ts',
  'src/routes/api/sprints/$sprintId/results.ts',
]

describe('ai-sourcing-sprints repository boundary', () => {
  it.each(tenantRoutes)('%s derives tenant context and never imports the raw schema/db module', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    // Either the route names the two guards itself, or it hands the whole sequence to
    // `tablePageHandler`, which calls `requireTenantPrincipal` *before* it parses anything and
    // wraps the load in `withTenantContext` (src/shared/lib/table/handler.ts). Phase 3 moved the
    // sprint-results route to the second form; asserting the literal names would have failed a
    // route that is more strictly guarded than before, not less.
    const guardsInline = source.includes('requireTenantPrincipal') && source.includes('withTenantContext')
    expect(guardsInline || source.includes('tablePageHandler')).toBe(true)
  })

  it('the create/detail/preview routes validate input with sprints-shared zod schemas', async () => {
    const create = await readFile('src/routes/api/sprints/index.ts', 'utf8')
    expect(create).toContain('createSprintSchema')
    const detail = await readFile('src/routes/api/sprints/$sprintId.ts', 'utf8')
    expect(detail).toContain('updateSprintSchema')
    const preview = await readFile('src/routes/api/sprints/preview.ts', 'utf8')
    expect(preview).toContain('queryVariantSchema')
  })

  it('the admin worker route never accepts a caller-selected sprint/organization id', async () => {
    const source = await readFile('src/routes/api/admin/sprints/run-worker.ts', 'utf8')
    expect(source).not.toContain('request.json')
    expect(source).toContain('runSprintsWorker')
  })

  it('the worker uses the dedicated worker repository, never the raw schema/db module', async () => {
    const source = await readFile('src/lib/sprints/worker.ts', 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    expect(source).toContain('~/shared/lib/repositories/sprints-worker')
  })

  it('the service module scopes every query by organizationId', async () => {
    const source = await readFile('src/lib/sprints/service.ts', 'utf8')
    const bodyLines = source.split('export async function').slice(1)
    for (const body of bodyLines) {
      // `buildKeysetPage` is the second acceptable form, and it is the stricter one. A function
      // taking an `organizationId` argument can be handed the wrong one; the keyset builder reads
      // `app.organization_id` back out of the transaction and throws when it is unset, and the
      // capability's `organizationColumn` puts the predicate in the SQL. `pageSprintResults` is
      // tenant-scoped without the identifier ever passing through its signature.
      expect(body.includes('organizationId') || body.includes('buildKeysetPage')).toBe(true)
    }
  })
})
