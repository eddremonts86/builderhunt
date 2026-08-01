/**
 * The people-search source register (migration 0126) and its kill switch.
 *
 * Asserted against a real migrated database rather than through mocks, because the property that
 * matters is that *no* code path can enable a source the register refuses — including one written next
 * year that inserts directly. A convention that only the repository honours is not a kill switch.
 *
 * The constraint tests come in pairs: the refusal, and the write that must still succeed. A constraint
 * that rejects everything passes a one-sided test while breaking the product.
 */
import { sql } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  IMPLEMENTED_SEARCH_CONNECTORS,
  assertSearchConnectorRegistryMatchesDatabase,
  invalidateSearchSourceCache,
  listSearchSources,
  partitionRequestedSources,
  recordSearchSourceTermsReview,
  setSearchSourceEnabled,
} from '~/shared/lib/repositories/search-sources'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('search_source_register')
  db = disposable.db
  drop = disposable.drop
}, 180_000)

afterAll(async () => { await drop() })

beforeEach(() => { invalidateSearchSourceCache() })

/** Asserts the write was refused by a named constraint, walking drizzle's wrapped cause chain. */
async function expectRefusedBy(write: Promise<unknown>, constraint: string): Promise<void> {
  let thrown: unknown
  try { await write } catch (error) { thrown = error }
  expect(thrown, `expected ${constraint} to refuse this write`).toBeDefined()
  const seen: string[] = []
  for (let e = thrown; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    const name = (e as { constraint_name?: unknown }).constraint_name
    if (typeof name === 'string') seen.push(name)
    seen.push(e.message)
  }
  expect(seen.join('\n')).toContain(constraint)
}

describe('the register ships describing what was already running', () => {
  it('seeds every live connector enabled and every blocked platform off', async () => {
    const sources = await listSearchSources(db)
    const byKey = new Map(sources.map((source) => [source.key, source]))

    for (const key of IMPLEMENTED_SEARCH_CONNECTORS) {
      const row = byKey.get(key)
      expect(row, `${key} has no register row`).toBeDefined()
      expect(row!.enabled, `${key} should be seeded enabled — it was already live`).toBe(true)
      expect(row!.connectorImplemented).toBe(true)
    }

    for (const key of ['linkedin', 'x', 'facebook', 'instagram']) {
      const row = byKey.get(key)
      expect(row, `${key} should be registered so the UI can explain its absence`).toBeDefined()
      expect(row!.enabled).toBe(false)
      expect(row!.connectorImplemented).toBe(false)
      expect(row!.storesPersonalData).toBe(false)
      // The register has to say *why*, or an operator is left guessing whether someone forgot.
      expect(row!.registerNotes).toBeTruthy()
    }
  })

  it('keeps connector_implemented in step with the code registry', async () => {
    const parity = await assertSearchConnectorRegistryMatchesDatabase(db)
    expect(parity.claimedButAbsent, 'register claims a connector the code does not have').toEqual([])
    expect(parity.presentButUnregistered, 'code has a connector the register never heard of').toEqual([])
  })
})

describe('the database refuses states the product cannot honour', () => {
  it('refuses to enable a source with no connector, and allows it once one exists', async () => {
    await expectRefusedBy(
      db.execute(sql`update search_sources set enabled = true where key = 'linkedin'`),
      'search_sources_enabled_needs_connector_check',
    )

    // The same row, with a connector: permitted. Proves the constraint targets the missing connector
    // rather than the row.
    await db.execute(sql`
      insert into search_sources (key, kind, label, homepage_url, connector_implemented, stores_personal_data)
      values ('fixture-api', 'official_api', 'Fixture', 'https://fixture.test', true, false)
    `)
    await db.execute(sql`update search_sources set enabled = true where key = 'fixture-api'`)
    const [row] = await db.execute<{ enabled: boolean }>(sql`select enabled from search_sources where key = 'fixture-api'`)
    expect(row.enabled).toBe(true)
    await db.execute(sql`delete from search_sources where key = 'fixture-api'`)
  })

  it('refuses to enable a scrape whose terms nobody reviewed', async () => {
    await db.execute(sql`
      insert into search_sources (key, kind, label, homepage_url, connector_implemented, stores_personal_data, retention_days)
      values ('fixture-scrape', 'public_scrape', 'Fixture scrape', 'https://scrape.test', true, true, 30)
    `)
    await expectRefusedBy(
      db.execute(sql`update search_sources set enabled = true where key = 'fixture-scrape'`),
      'search_sources_scrape_needs_review_check',
    )

    // Recording the review is what makes it enableable — the gate is the review, not the kind.
    await db.execute(sql`update search_sources set terms_reviewed_at = now() where key = 'fixture-scrape'`)
    await db.execute(sql`update search_sources set enabled = true where key = 'fixture-scrape'`)
    const [row] = await db.execute<{ enabled: boolean }>(sql`select enabled from search_sources where key = 'fixture-scrape'`)
    expect(row.enabled).toBe(true)
    await db.execute(sql`delete from search_sources where key = 'fixture-scrape'`)
  })

  it('refuses a link-only source that claims to store personal data', async () => {
    await expectRefusedBy(
      db.execute(sql`
        insert into search_sources (key, kind, label, homepage_url, stores_personal_data, retention_days)
        values ('fixture-link', 'external_link_only', 'Link', 'https://link.test', true, 30)
      `),
      'search_sources_link_only_stores_nothing_check',
    )
  })

  it('refuses personal data with no retention period, because "forever" is not a policy', async () => {
    await expectRefusedBy(
      db.execute(sql`
        insert into search_sources (key, kind, label, homepage_url, stores_personal_data, retention_days)
        values ('fixture-forever', 'official_api', 'Forever', 'https://forever.test', true, null)
      `),
      'search_sources_retention_check',
    )
    await expectRefusedBy(
      db.execute(sql`
        insert into search_sources (key, kind, label, homepage_url, stores_personal_data, retention_days)
        values ('fixture-zero', 'official_api', 'Zero', 'https://zero.test', true, 0)
      `),
      'search_sources_retention_check',
    )
  })
})

describe('the toggle explains itself rather than failing', () => {
  it('reports no_connector instead of surfacing a constraint error', async () => {
    const outcome = await setSearchSourceEnabled({ key: 'linkedin', enabled: true }, db)
    expect(outcome.status).toBe('no_connector')
  })

  it('reports review_required for an unreviewed scrape, and succeeds after the review is recorded', async () => {
    await db.execute(sql`
      insert into search_sources (key, kind, label, homepage_url, connector_implemented, stores_personal_data, retention_days)
      values ('fixture-scrape2', 'public_scrape', 'Scrape', 'https://scrape2.test', true, true, 30)
    `)
    expect((await setSearchSourceEnabled({ key: 'fixture-scrape2', enabled: true }, db)).status).toBe('review_required')

    const recorded = await recordSearchSourceTermsReview(
      { key: 'fixture-scrape2', reviewerUserId: 'system-deleted-user', notes: 'Reviewed robots and terms.' },
      db,
    )
    expect(recorded).toBe(true)
    expect(await setSearchSourceEnabled({ key: 'fixture-scrape2', enabled: true }, db)).toEqual({ status: 'updated', enabled: true })
    await db.execute(sql`delete from search_sources where key = 'fixture-scrape2'`)
  })

  it('distinguishes an unknown key from a no-op', async () => {
    expect((await setSearchSourceEnabled({ key: 'does-not-exist', enabled: true }, db)).status).toBe('not_found')
    expect(await setSearchSourceEnabled({ key: 'github', enabled: true }, db)).toEqual({ status: 'unchanged', enabled: true })
  })
})

describe('a disabled source is not contacted', () => {
  it('moves a disabled source out of the allowed set', async () => {
    expect(await setSearchSourceEnabled({ key: 'reddit', enabled: false }, db)).toEqual({ status: 'updated', enabled: false })
    invalidateSearchSourceCache()

    const partition = await partitionRequestedSources(['github', 'reddit', 'linkedin'], db)
    expect(partition.allowed).toEqual(['github'])
    // Both a switched-off connector and a never-enabled one land in `refused`: from the search's point
    // of view they are the same situation, which is why the UI reports `disabled` for both.
    expect(partition.refused.sort()).toEqual(['linkedin', 'reddit'])

    await setSearchSourceEnabled({ key: 'reddit', enabled: true }, db)
  })

  it('fails closed when the register cannot be read', async () => {
    // A database blip must not read as "everything is permitted": that would bring every disabled
    // source back online at once, which is the exact failure a kill switch exists to prevent.
    const broken = {
      select: () => { throw new Error('register unavailable') },
    } as unknown as PostgresJsDatabase

    invalidateSearchSourceCache()
    const partition = await partitionRequestedSources(['github', 'hn'], broken)
    expect(partition.allowed).toEqual([])
    expect(partition.refused).toEqual(['github', 'hn'])
  })
})
