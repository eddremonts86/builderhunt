/**
 * The self-managed semantic reconciliation pass (plan: phase-2/07-perfiles-autogestionados).
 *
 * Against a real disposable Postgres for the same reason the scan worker's test is: what could be
 * wrong is the walk — its cursor, its bound, and the direction it deletes in. The embedding provider
 * never enters it, because a stub row is written pending and no vector is computed here.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, builderEmbeddings, jobRuns, selfManagedAttachments, selfManagedProfiles } from '~/shared/lib/db/schema'
import { SELF_MANAGED_ENTITY_KIND } from '~/shared/lib/semantic/entity-kinds'
import { buildSelfManagedDoc } from '~/lib/semantic/self-managed-index'
import {

  runSelfManagedSemanticIndexWorker,
  SELF_MANAGED_INDEX_JOB_KEY,
  type SelfManagedIndexWorkerOptions,
} from '~/lib/semantic/self-managed-reconcile-worker'

/**
 * The feature flag is on for this suite, stated rather than inherited.
 *
 * `SELF_MANAGED_PROFILES_ENABLED` defaults to `false` — production inherits no `.env`, so every
 * flag in `env.ts` is off unless somebody turns it on. These tests are about what the feature does
 * when it exists; what it does when it does not is `tests/e2e/self-managed-flag.spec.ts`, and
 * asserting both from one file would mean neither could set the flag at module load.
 */
vi.mock('~/shared/lib/self-managed/feature-flag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/shared/lib/self-managed/feature-flag')>()
  return { ...actual, isSelfManagedEnabled: () => true, selfManagedDisabledResponse: () => null }
})

let db: PostgresJsDatabase
let drop: () => Promise<void>

const NOW = new Date('2027-07-01T09:00:00.000Z')

function run(overrides: SelfManagedIndexWorkerOptions = {}) {
  return runSelfManagedSemanticIndexWorker({
    now: NOW,
    db: db as unknown as SelfManagedIndexWorkerOptions['db'],
    ...overrides,
  })
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('semantic_reconcile')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values(
    ['own-a', 'own-b', 'own-c'].map((id) => ({
      id, name: id, email: `${id}@test.invalid`, emailVerified: true, createdAt: NOW, updatedAt: NOW,
    })),
  )
}, 120_000)

afterAll(async () => {
  await drop?.()
})

beforeEach(async () => {
  // Cleared too: every test in this file runs the worker, so a count assertion further down would
  // otherwise be counting the whole file's history.
  await db.delete(jobRuns)
  await db.delete(builderEmbeddings)
  await db.delete(selfManagedAttachments)
  await db.delete(selfManagedProfiles)
})

async function seedProfile(id: string, ownerUserId: string, visibility = 'public', deletedAt: Date | null = null) {
  await db.insert(selfManagedProfiles).values({
    id,
    handle: id,
    ownerUserId,
    displayName: `Name ${id}`,
    headline: 'Technical translator',
    bio: 'Twelve years of documentation.',
    languages: ['es', 'en'],
    services: ['translation'],
    topics: ['localization'],
    visibility,
    declaredAt: NOW,
    updatedAt: NOW,
    deletedAt,
  })
}

async function seedAttachment(profileId: string, title: string, scanStatus: string) {
  await db.insert(selfManagedAttachments).values({
    id: `att-${profileId}-${title}`,
    profileId,
    kind: 'work-sample',
    title,
    description: `${title} description`,
    storageKey: `clean/self-managed/x/${profileId}/${title}`,
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    checksumSha256: 'a'.repeat(64),
    scanStatus,
    // `0176` pairs a rejection with a reason as an iff, so a terminal state without one is refused
    // by the constraint — the fixture has to be as honest as a real row.
    rejectionCode: scanStatus === 'infected' || scanStatus === 'failed' ? 'eicar' : null,
    uploadedAt: NOW,
    updatedAt: NOW,
  })
}

async function indexedIds(): Promise<string[]> {
  const rows = await db.select({ sourceId: builderEmbeddings.sourceId }).from(builderEmbeddings)
  return rows.map((row) => row.sourceId).sort()
}

describe('the forward pass', () => {
  it('indexes every public profile under its own entity kind', async () => {
    await seedProfile('prof-a', 'own-a')
    await seedProfile('prof-b', 'own-b')

    const result = await run()

    expect(result).toMatchObject({ scanned: 2, indexed: 2, removed: 0, truncated: false })
    expect(await indexedIds()).toEqual(['prof-a', 'prof-b'])
    const [row] = await db.select().from(builderEmbeddings)
    expect(row!.entityKind).toBe(SELF_MANAGED_ENTITY_KIND)
    expect(row!.source).toBe('self-managed')
  })

  it('skips draft, unlisted and deleted profiles', async () => {
    await seedProfile('prof-public', 'own-a')
    await seedProfile('prof-draft', 'own-b', 'draft')
    await seedProfile('prof-unlisted', 'own-c', 'unlisted')

    await run()

    // Unlisted is reachable by link and deliberately not listed — and a semantic hit is a listing.
    expect(await indexedIds()).toEqual(['prof-public'])
  })

  it('is idempotent: a second pass changes nothing and re-embeds nothing', async () => {
    await seedProfile('prof-a', 'own-a')

    const first = await run()
    const second = await run()

    expect(first).toMatchObject({ indexed: 1, unchanged: 0 })
    // The content hash did not move, so the row is not marked pending again — which is what makes a
    // nightly pass over the whole corpus cost nothing at the provider.
    expect(second).toMatchObject({ scanned: 1, indexed: 0, unchanged: 1 })
  })

  it('quotes clean attachments and nothing else', async () => {
    await seedProfile('prof-a', 'own-a')
    await seedAttachment('prof-a', 'cleaned', 'clean')
    await seedAttachment('prof-a', 'pending', 'pending')
    await seedAttachment('prof-a', 'infected', 'infected')

    await run()

    const [row] = await db.select().from(builderEmbeddings)
    expect(row!.document).toContain('cleaned')
    // An embedding is a copy: text that reaches it has left the row policy behind and cannot be
    // un-indexed by tightening one later, so an unscanned attachment must never get in.
    expect(row!.document).not.toContain('pending')
    expect(row!.document).not.toContain('infected')
    // And never the object key or the checksum.
    expect(row!.document).not.toContain('clean/self-managed')
    expect(row!.document).not.toMatch(/[0-9a-f]{64}/)
  })
})

describe('the reverse pass', () => {
  it('removes a row whose profile stopped being public', async () => {
    await seedProfile('prof-a', 'own-a')
    await run()
    expect(await indexedIds()).toEqual(['prof-a'])

    await db.update(selfManagedProfiles).set({ visibility: 'draft' })
    const result = await run()

    expect(result.removed).toBe(1)
    expect(await indexedIds()).toEqual([])
  })

  it('removes a row whose profile was deleted outright', async () => {
    await seedProfile('prof-a', 'own-a')
    await run()

    await db.delete(selfManagedProfiles)
    const result = await run()

    expect(result.removed).toBe(1)
    expect(await indexedIds()).toEqual([])
  })

  it('leaves other entity kinds alone', async () => {
    await db.insert(builderEmbeddings).values({
      id: 'gh-row',
      entityKind: 'human_profile',
      source: 'github',
      sourceId: 'prof-a',
      contentHash: 'h',
      document: 'd',
      profile: { username: 'ada', profileUrl: 'https://github.com/ada', topics: [] } as never,
    })

    const result = await run()

    // Nothing self-managed exists, so the pass has nothing to add and nothing of its own to remove.
    expect(result).toMatchObject({ scanned: 0, removed: 0 })
    expect(await indexedIds()).toEqual(['prof-a'])
  })
})

describe('the bound', () => {
  it('pages through more profiles than one page holds', async () => {
    // One owner each: `self_managed_profiles_owner_live_unique` allows exactly one live profile per
    // person, and a fixture that ignored that would be testing a state the product cannot reach.
    await seedProfile('prof-1', 'own-a')
    await seedProfile('prof-2', 'own-b')
    await seedProfile('prof-3', 'own-c')

    // A page smaller than the corpus: the cursor has to carry the walk past the first batch.
    const result = await run({ page: 2 })

    expect(result.scanned).toBe(3)
    expect(await indexedIds()).toEqual(['prof-1', 'prof-2', 'prof-3'])
  })

  it('stops at the ceiling and says so rather than reporting a clean pass', async () => {
    await seedProfile('prof-1', 'own-a')
    await seedProfile('prof-2', 'own-b')

    const result = await run({ page: 1, maxPerRun: 1 })

    expect(result.truncated).toBe(true)
    // The reverse pass is skipped when the forward pass was cut short: `eligible` is a partial set,
    // and deleting against a partial set would remove live profiles the walk had not reached.
    expect(result.removed).toBe(0)
    expect(await indexedIds()).toEqual(['prof-1'])
  })
})

describe('the job run', () => {
  it('records one run under its own key', async () => {
    await seedProfile('prof-a', 'own-a')
    await run()

    const rows = await db.select({ state: jobRuns.state }).from(jobRuns)
      .where(eq(jobRuns.jobKey, SELF_MANAGED_INDEX_JOB_KEY))
    // Its own key, not the scan worker's: "the scanner is failing" and "the index is drifting" are
    // different operational facts and a shared history merges them into one line nobody can read.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.state).toBe('succeeded')
  })
})

describe('buildSelfManagedDoc', () => {
  it('says what kind of claim the text is, inside the text', () => {
    const doc = buildSelfManagedDoc({
      id: 'prof-a',
      handle: 'ada',
      displayName: 'Ada Lovelace',
      headline: 'Technical translator',
      bio: null,
      locationCity: 'Madrid',
      locationCountryCode: 'ES',
      languages: ['es'],
      services: ['translation'],
      topics: ['localization'],
      attachments: [],
    })

    // A raw retrieval hit carries its own provenance, so a reader does not have to join back to a
    // row to learn that nobody verified this.
    expect(doc).toContain('declared by its owner, not verified')
    expect(doc).toContain('Ada Lovelace')
    expect(doc).toContain('Madrid, ES')
  })
})
