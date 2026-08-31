import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const accountRoutes = [
  'src/routes/api/consent/index.ts',
  'src/routes/api/me/data-export/index.ts',
  'src/routes/api/me/data-export/$id.ts',
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

describe('self-managed profiles in export and erasure (plan: phase-2/07)', () => {
  it('discloses the declared content and never a storage capability', async () => {
    const source = await readFile('src/shared/lib/repositories/account-privacy.ts', 'utf8')
    const start = source.indexOf('const selfManaged = await withAccountSubjectContext')
    const end = source.indexOf('return {', start)
    const section = source.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    // What a person is owed: their own words, and why an upload was refused.
    for (const field of ['handle', 'bio', 'services', 'scanStatus', 'rejectionCode']) {
      expect(section, field).toContain(field)
    }
    // An object key is a capability, not a fact about a person. A signed URL is worse — it would
    // put a working handle to the bytes in a mailbox for as long as the mailbox lasts.
    expect(section).not.toContain('storageKey')
    expect(section).not.toContain('checksumSha256')
    expect(section).not.toContain('createSignedDownloadUrl')
  })

  it('takes the semantic row and the objects before the cascade takes the rows', async () => {
    const source = await readFile('src/shared/lib/repositories/account-privacy.ts', 'utf8')
    const fnStart = source.indexOf('export async function hardDeleteAccountSubject')
    const fnEnd = source.indexOf('\n}\n', fnStart)
    const fnBody = source.slice(fnStart, fnEnd)

    const collect = fnBody.indexOf('collectSelfManagedErasureTargets')
    const unindex = fnBody.indexOf('removeSelfManagedFromIndex')
    const deleteObject = fnBody.indexOf('deleteObject')
    const deleteUser = fnBody.indexOf('tx.delete(authUsers)')

    expect(collect).toBeGreaterThan(-1)
    // Order is the whole property. `builder_embeddings` has no foreign key to a profile, so a
    // cascade leaves the row that semantic search reads; and the retention sweep finds bytes
    // through soft-deleted rows, which a cascade removes outright. Both are only reachable before
    // the delete — afterwards there is nothing left to read.
    expect(unindex).toBeGreaterThan(collect)
    expect(deleteObject).toBeGreaterThan(collect)
    expect(deleteUser).toBeGreaterThan(unindex)
    expect(deleteUser).toBeGreaterThan(deleteObject)
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
