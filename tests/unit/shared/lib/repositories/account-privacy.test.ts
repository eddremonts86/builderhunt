import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const accountRoutes = [
  'src/routes/api/consent/index.ts',
  'src/routes/api/me/data-export/index.ts',
  'src/routes/api/me/data-export/$id.ts',
  'src/routes/api/me/plan-changes/index.ts',
  'src/shared/lib/legal.ts',
]

describe('account privacy repository boundary', () => {
  it.each(accountRoutes)('%s does not access database tables directly', async (path) => {
    const source = await readFile(path, 'utf8')
    expect(source).not.toContain("~/shared/lib/db/index")
    expect(source).not.toContain("~/shared/lib/db/schema")
    // Reaching the repository through `legal.ts` counts: it is itself in this list, so it is held
    // to the same no-direct-table rule, and routing through it is what keeps the consent
    // version map in one place instead of copied into each route.
    const reachesRepository =
      source.includes('~/shared/lib/repositories/account-privacy') || source.includes('~/shared/lib/legal')
    expect(reachesRepository).toBe(true)
  })
})

describe('legal admin run-worker route', () => {
  it('requires admin auth and selects no caller-provided target', async () => {
    const source = await readFile('src/routes/api/admin/legal/run-worker.ts', 'utf8')
    expect(source).toContain('requirePlatformAdminPrincipal')
    expect(source).not.toContain('params.')
    expect(source).toContain('processPendingDeletions')
  })
})

describe('hardDeleteAccountSubject FK-safe delete order', () => {
  it('deletes rows lacking an ON DELETE action before the tables they reference', async () => {
    const source = await readFile('src/shared/lib/repositories/account-privacy.ts', 'utf8')
    const fnStart = source.indexOf('export async function hardDeleteAccountSubject')
    const fnEnd = source.indexOf('\n}\n', fnStart)
    const fnBody = source.slice(fnStart, fnEnd)

    // builder_notes.builder_id and alerts.query_id have no cascade — the rows they'd
    // block must be deleted first (via accountDb, the product-domain connection), and
    // auth_users (referenced by all of them, but only reachable via the separate
    // authDb/builderhunt_auth connection — see drizzle/0007_auth_broker.sql) must be
    // deleted last so no cascade fires before these explicit deletes run.
    const order = ['builderNotes', 'alerts', 'savedQueries', 'builders', 'authUsers']
    const positions = order.map((table) => fnBody.indexOf(`tx.delete(${table})`))
    expect(positions.every((pos) => pos !== -1)).toBe(true)
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })
})

describe('lifecycle emails (Phase 2) — no new paid dependency, reuses email.ts\'s Resend-optional pattern', () => {
  it('delete-account route sends the deletion-scheduled email', async () => {
    const source = await readFile('src/routes/api/me/delete-account/index.ts', 'utf8')
    expect(source).toContain("~/shared/lib/email")
    expect(source).toContain('sendDeletionScheduledEmail')
  })

  it('data-export route sends the export-ready email', async () => {
    const source = await readFile('src/routes/api/me/data-export/index.ts', 'utf8')
    expect(source).toContain("~/shared/lib/email")
    expect(source).toContain('sendExportReadyEmail')
  })

  it('the purge worker sends the deletion-completed email via legal.ts, not a direct import elsewhere', async () => {
    const source = await readFile('src/shared/lib/legal.ts', 'utf8')
    expect(source).toContain('sendDeletionCompletedEmail')
    expect(source).toContain('findAccountEmail')
  })

  it('every new sender follows the existing free-tier-friendly optional-key pattern (no new paid service)', async () => {
    const source = await readFile('src/shared/lib/email.ts', 'utf8')
    for (const fn of ['sendDeletionScheduledEmail', 'sendDeletionCompletedEmail', 'sendExportReadyEmail']) {
      const fnStart = source.indexOf(`export async function ${fn}`)
      expect(fnStart).toBeGreaterThan(-1)
      const fnBody = source.slice(fnStart, source.indexOf('\n}', fnStart))
      expect(fnBody).toContain('env.RESEND_API_KEY')
      expect(fnBody).toContain('console.log')
    }
  })
})
