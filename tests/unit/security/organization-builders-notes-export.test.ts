/**
 * plans/UI/tasks.md Wave 6 "Build a scoped Export Center and reconcile public claims".
 *
 * `listNotedOrganizationBuilders` — the "note collection" export scope — against a real database.
 * `builder_notes.builder_id` FKs directly to `organization_builders(id)` (migration 0120 fixed the
 * stale FK to the legacy, never-populated `builders` table).
 */
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, builderIdentities, builderNotes, organizationBuilders, organizations } from '~/shared/lib/db/schema'
import { listNotedOrganizationBuilders } from '~/shared/lib/repositories/organization-builders'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const OWNER = 'nb-owner'
const ORG = 'nb-org'

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('org_builders_notes_export')
  db = disposable.db
  drop = disposable.drop

  await db.insert(authUsers).values({ id: OWNER, name: 'Owner', email: 'nb-owner@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
  await db.insert(organizations).values({ id: ORG, name: 'Org', slug: 'nb-org' })
}, 60_000)

afterAll(async () => { await drop() })

beforeEach(async () => {
  await db.delete(builderNotes)
  await db.delete(organizationBuilders)
  await db.delete(builderIdentities)
})

let seq = 0
async function seedTrackedBuilder() {
  seq += 1
  const identityId = `identity-${seq}`
  const orgBuilderId = `org-builder-${seq}`
  await db.insert(builderIdentities).values({
    id: identityId, source: 'github', sourceId: `gh-${seq}`, username: `user${seq}`, profileUrl: `https://github.com/user${seq}`,
  })
  await db.insert(organizationBuilders).values({ id: orgBuilderId, organizationId: ORG, builderIdentityId: identityId, creatorUserId: OWNER })
  return { identityId, orgBuilderId }
}

async function addNote(orgBuilderId: string) {
  await db.insert(builderNotes).values({ id: `note-${orgBuilderId}`, organizationId: ORG, userId: OWNER, builderId: orgBuilderId, content: 'A note.' })
}

describe('listNotedOrganizationBuilders', () => {
  it('returns only builders with at least one note, not every tracked builder', async () => {
    const noted = await seedTrackedBuilder()
    const unnoted = await seedTrackedBuilder()
    await addNote(noted.orgBuilderId)

    const rows = await listNotedOrganizationBuilders(db as never, ORG)
    expect(rows).toHaveLength(1)
    expect(rows[0].identityId).toBe(noted.identityId)
    expect(rows.some((r) => r.identityId === unnoted.identityId)).toBe(false)
  })

  it('returns [] when no tracked builder has a note', async () => {
    await seedTrackedBuilder()
    expect(await listNotedOrganizationBuilders(db as never, ORG)).toEqual([])
  })

  it('does not duplicate a builder with multiple notes', async () => {
    const noted = await seedTrackedBuilder()
    await addNote(noted.orgBuilderId)
    await db.insert(builderNotes).values({ id: `note-2-${noted.orgBuilderId}`, organizationId: ORG, userId: OWNER, builderId: noted.orgBuilderId, content: 'Another note.' })

    const rows = await listNotedOrganizationBuilders(db as never, ORG)
    expect(rows).toHaveLength(1)
  })

  it('scopes to the given organization only', async () => {
    const otherOrg = 'nb-org-2'
    await db.insert(organizations).values({ id: otherOrg, name: 'Other Org', slug: 'nb-org-2' }).onConflictDoNothing()
    const noted = await seedTrackedBuilder()
    await addNote(noted.orgBuilderId)

    expect(await listNotedOrganizationBuilders(db as never, otherOrg)).toEqual([])
  })
})
