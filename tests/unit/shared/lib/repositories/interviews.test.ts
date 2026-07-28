/**
 * Real disposable Postgres, because most of what is under test is enforced by the database: the
 * version unique index, the status and provenance checks, and the composite FK to the event.
 *
 * The assertion that matters most is the concurrency one. `insertBriefVersion` computes the next
 * version *inside* the INSERT rather than reading a maximum into JS and incrementing it — a
 * distinction that is invisible in a single-threaded test and decides whether two simultaneous
 * generations overwrite each other or one loses cleanly.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, calendarEvents, interviewBriefs, organizations, userCalendars } from '~/shared/lib/db/schema'
import {
  InterviewBriefError,
  activateBriefVersion,
  findActiveBrief,
  findBriefVersion,
  findLatestBrief,
  insertBriefVersion,
  listBriefVersions,
  updateBriefContent,
} from '~/shared/lib/repositories/interviews'
import type { InterviewBriefRow } from '~/shared/lib/repositories/interviews'
import type { SourceManifestEntry } from '~/shared/lib/interviews'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'ib-brief-org'
const OWNER = 'ib-brief-owner'
const NOW = new Date('2027-06-10T09:00:00.000Z')
const RETENTION = new Date('2027-12-31T00:00:00.000Z')

let eventId = ''

const manifest: SourceManifestEntry[] = [
  { id: 'doc-1', kind: 'document', label: 'cv.pdf', text: 'Ten years of Rust.' },
  { id: 'web-1', kind: 'approved_web', label: 'someone.dev', text: 'Built a cache.' },
]

const content = {
  candidateSummary: 'Backend engineer.',
  relevantEvidence: [{ claim: 'Ten years of Rust.', sourceIds: ['doc-1'], confidence: 'high' as const }],
  informationGaps: [],
  contradictions: [],
  questionGroups: [{
    category: 'technical' as const,
    question: 'How did eviction work?',
    rationale: 'They built a cache.',
    sourceIds: ['web-1'],
  }],
}

const generated = (overrides: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  eventId,
  ownerUserId: OWNER,
  content,
  evidenceManifest: manifest,
  provider: 'mistral',
  model: 'mistral-medium-2604',
  promptVersion: '1',
  retentionExpiresAt: RETENTION,
  ...overrides,
})

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('interview_briefs_repo')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values({ id: ORG, name: 'Org', slug: ORG })
  await db.insert(authUsers).values({
    id: OWNER, name: 'Owner', email: 'ib-brief@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW,
  })
  const [calendar] = await db.insert(userCalendars).values({
    organizationId: ORG, ownerUserId: OWNER, name: 'Cal', timezone: 'UTC', isDefault: true,
  }).returning({ id: userCalendars.id })
  const [event] = await db.insert(calendarEvents).values({
    organizationId: ORG, calendarId: calendar.id, ownerUserId: OWNER, type: 'personal', status: 'scheduled',
    title: 'Interview', startsAt: NOW, endsAt: new Date(NOW.getTime() + 3_600_000),
    timezone: 'UTC', allDay: false, busy: true,
  }).returning({ id: calendarEvents.id })
  eventId = event.id
}, 120_000)

afterAll(async () => {
  await drop()
})

beforeEach(async () => {
  await db.delete(interviewBriefs)
})

describe('versions accumulate rather than overwrite', () => {
  it('starts at 1 and increments', async () => {
    const first = await db.transaction((tx) => insertBriefVersion(tx as never, generated()))
    const second = await db.transaction((tx) => insertBriefVersion(tx as never, generated()))

    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(await listBriefVersions(db as never, { organizationId: ORG, eventId })).toHaveLength(2)
  })

  it('supersedes the previously active version instead of leaving two', async () => {
    await db.transaction((tx) => insertBriefVersion(tx as never, generated({ status: 'active' })))
    await db.transaction((tx) => insertBriefVersion(tx as never, generated({ status: 'active' })))

    const rows = await listBriefVersions(db as never, { organizationId: ORG, eventId })
    expect(rows.map((row) => `v${row.version}:${row.status}`)).toEqual(['v2:active', 'v1:superseded'])
    // A reader between the two writes must never see two actives.
    expect((await findActiveBrief(db as never, { organizationId: ORG, eventId }))?.version).toBe(2)
  })

  it('never hands the same version to two concurrent generations', async () => {
    // The property the in-INSERT max() exists for. A read-then-increment in JS would let both
    // transactions compute 1 and one would silently replace the other's brief.
    const results = await Promise.allSettled([
      db.transaction((tx) => insertBriefVersion(tx as never, generated())),
      db.transaction((tx) => insertBriefVersion(tx as never, generated())),
      db.transaction((tx) => insertBriefVersion(tx as never, generated())),
    ])

    // Narrowed with the real settled type: a predicate written as `PromiseFulfilledResult<{version}>`
    // is not assignable to `PromiseSettledResult<InterviewBriefRow>` and tsc rejects it.
    const versions = results
      .filter((result) => result.status === 'fulfilled')
      .map((result) => (result as PromiseFulfilledResult<InterviewBriefRow>).value.version)
    expect(new Set(versions).size, 'no version claimed twice').toBe(versions.length)

    const stored = await listBriefVersions(db as never, { organizationId: ORG, eventId })
    expect(stored.length, 'every winner is persisted, no silent overwrite').toBe(versions.length)
  })
})

describe('nothing unvalidated reaches the column', () => {
  it('rejects content that is not a brief', async () => {
    await expect(db.transaction((tx) => insertBriefVersion(tx as never, generated({ content: { nope: true } }))))
      .rejects.toMatchObject({ name: 'InterviewBriefError', code: 'invalid_content' })
  })

  it('rejects a manifest that is not a source list', async () => {
    await expect(db.transaction((tx) => insertBriefVersion(tx as never, generated({ evidenceManifest: [{ id: 'x' }] }))))
      .rejects.toMatchObject({ code: 'invalid_manifest' })
  })

  it('rejects a citation the stored manifest does not contain', async () => {
    // The failure worth catching: both halves are well-formed and they disagree. The UI would render a
    // confident reference that resolves to nothing, and nobody could tell whether the source was removed
    // or never existed.
    await expect(db.transaction((tx) => insertBriefVersion(tx as never, generated({
      content: { ...content, relevantEvidence: [{ claim: 'x', sourceIds: ['doc-99'], confidence: 'high' }] },
    })))).rejects.toMatchObject({ code: 'dangling_source' })
  })

  it('names paths and not values when content is invalid', async () => {
    // The message reaches logs and the values are candidate material.
    let message = ''
    try {
      await db.transaction((tx) => insertBriefVersion(tx as never, generated({
        content: { ...content, candidateSummary: 'A very identifying sentence about Maria.' , relevantEvidence: 'not an array' },
      })))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('relevantEvidence')
    expect(message).not.toContain('Maria')
  })

  it('stores no model envelope', async () => {
    const row = await db.transaction((tx) => insertBriefVersion(tx as never, generated()))
    const [stored] = await db.select().from(interviewBriefs).where(eq(interviewBriefs.id, row.id))
    // The absence is the assertion: a stored prompt would be a second copy of the CV, in a table with
    // different access rules and a different retention from the documents it came from.
    for (const forbidden of ['prompt', 'rawResponse', 'messages', 'completion']) {
      expect(Object.keys(stored), `no '${forbidden}' column`).not.toContain(forbidden)
    }
  })
})

describe('provenance is all or nothing', () => {
  it('accepts a deterministic fallback with no provider at all', async () => {
    const row = await db.transaction((tx) => insertBriefVersion(tx as never, generated({
      provider: null, model: null, promptVersion: null,
    })))
    expect(row.provider).toBeNull()
  })

  it('refuses a half-filled provenance', async () => {
    // "Which model wrote this" must be answerable per row, or unanswerable in a way that says so.
    // The constraint name is on the Postgres error, not on drizzle's wrapper message — asserting
    // `toThrow(/name/)` against `.message` alone would pass for any query failure at all.
    let chain = ''
    try {
      await db.transaction((tx) => insertBriefVersion(tx as never, generated({ model: null })))
    } catch (error) {
      for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
        const candidate = current as { message?: string; constraint_name?: string; cause?: unknown }
        chain += `${candidate.message ?? ''} ${candidate.constraint_name ?? ''} `
        current = candidate.cause
      }
    }
    expect(chain).toContain('interview_briefs_provenance_check')
  })
})

describe('editing is guarded by the version the editor saw', () => {
  it('applies an edit in place and records who made it', async () => {
    const created = await db.transaction((tx) => insertBriefVersion(tx as never, generated()))
    const edited = await db.transaction((tx) => updateBriefContent(tx as never, {
      organizationId: ORG,
      eventId,
      expectedVersion: created.version,
      content: { ...content, candidateSummary: 'Corrected by the organizer.' },
      evidenceManifest: manifest,
      editedByUserId: OWNER,
    }))

    // In place: an edit is the organizer correcting *this* brief, not a new generation.
    expect(edited.version).toBe(created.version)
    expect(edited.content.candidateSummary).toBe('Corrected by the organizer.')
    expect(edited.editedByUserId).toBe(OWNER)
    expect(await listBriefVersions(db as never, { organizationId: ORG, eventId })).toHaveLength(1)
  })

  it('refuses an edit against a version that moved', async () => {
    // Two tabs. Without the guard the later write discards the earlier's work in silence.
    await db.transaction((tx) => insertBriefVersion(tx as never, generated()))
    await db.transaction((tx) => insertBriefVersion(tx as never, generated()))

    await expect(db.transaction((tx) => updateBriefContent(tx as never, {
      organizationId: ORG, eventId, expectedVersion: 99,
      content, evidenceManifest: manifest, editedByUserId: OWNER,
    }))).rejects.toMatchObject({ code: 'version_conflict' })
  })

  it('validates an edit as strictly as a generation', async () => {
    const created = await db.transaction((tx) => insertBriefVersion(tx as never, generated()))
    await expect(db.transaction((tx) => updateBriefContent(tx as never, {
      organizationId: ORG, eventId, expectedVersion: created.version,
      content: { ...content, contradictions: [{ description: 'x', sourceIds: ['nope'] }] },
      evidenceManifest: manifest, editedByUserId: OWNER,
    }))).rejects.toMatchObject({ code: 'dangling_source' })
  })
})

describe('reads', () => {
  it('finds a specific version, the latest, and the active one independently', async () => {
    await db.transaction((tx) => insertBriefVersion(tx as never, generated({ status: 'active' })))
    await db.transaction((tx) => insertBriefVersion(tx as never, generated({ status: 'draft' })))

    expect((await findBriefVersion(db as never, { organizationId: ORG, eventId, version: 1 }))?.status).toBe('active')
    // Latest is not the same question as active: a draft awaiting review is the newest but not what a
    // reader should be shown.
    expect((await findLatestBrief(db as never, { organizationId: ORG, eventId }))?.version).toBe(2)
    expect((await findActiveBrief(db as never, { organizationId: ORG, eventId }))?.version).toBe(1)
  })

  it('returns null rather than throwing for an event with no brief', async () => {
    expect(await findActiveBrief(db as never, { organizationId: ORG, eventId })).toBeNull()
    expect(await findLatestBrief(db as never, { organizationId: ORG, eventId })).toBeNull()
  })

  it('activating a draft supersedes the previous active', async () => {
    await db.transaction((tx) => insertBriefVersion(tx as never, generated({ status: 'active' })))
    await db.transaction((tx) => insertBriefVersion(tx as never, generated({ status: 'draft' })))

    const activated = await db.transaction((tx) => activateBriefVersion(tx as never, { organizationId: ORG, eventId, version: 2 }))
    expect(activated.status).toBe('active')
    expect((await findBriefVersion(db as never, { organizationId: ORG, eventId, version: 1 }))?.status).toBe('superseded')
  })

  it('refuses to activate a version that does not exist', async () => {
    await expect(db.transaction((tx) => activateBriefVersion(tx as never, { organizationId: ORG, eventId, version: 7 })))
      .rejects.toBeInstanceOf(InterviewBriefError)
  })
})
