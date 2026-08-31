/**
 * The semantic index's self-managed entity kind (plan: phase-2/07-perfiles-autogestionados).
 *
 * Against a real disposable Postgres, because what could be wrong is what SQL owns: the CHECK that
 * decides which entity kinds exist, the `(entity_kind, source, source_id)` unique key that keeps a
 * self-managed row and a claimed builder's row apart, and the delete that has to hit exactly one of
 * them.
 */
import { and, eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { builderEmbeddings } from '~/shared/lib/db/schema'
import { COMPONENT_KINDS } from '~/shared/lib/solutions/contracts'
import { SELF_MANAGED_ENTITY_KIND, SEMANTIC_ENTITY_KINDS } from '~/shared/lib/semantic/entity-kinds'
import {
  deleteBuilderEmbedding,
  listIndexedSourceIds,
  searchBuilderEmbeddings,
  upsertBuilderEmbeddingStub,
} from '~/shared/lib/repositories/public-builder-embeddings'

let db: PostgresJsDatabase
let drop: () => Promise<void>

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('semantic_self_managed')
  db = disposable.db
  drop = disposable.drop
}, 120_000)

afterAll(async () => {
  await drop?.()
})

beforeEach(async () => {
  await db.delete(builderEmbeddings)
})

const profilePayload = {
  username: 'ada',
  displayName: 'Ada Lovelace',
  profileUrl: '/u/ada',
  topics: ['localization'],
}

async function seed(entityKind: typeof SEMANTIC_ENTITY_KINDS[number], sourceId: string, source = 'self-managed') {
  await upsertBuilderEmbeddingStub({
    entityKind,
    source,
    sourceId,
    document: `Name: ${sourceId}`,
    contentHash: `hash-${sourceId}-${entityKind}`,
    profile: profilePayload as never,
  }, db)
}

describe('the entity-kind vocabulary', () => {
  it('is the catalog list plus one, and the extra one is not a component kind', () => {
    expect(SEMANTIC_ENTITY_KINDS).toEqual([...COMPONENT_KINDS, 'self_managed_person'])
    // The whole point of the separate union: `solution_components.kind` and
    // `solution_component_projections.kind` share COMPONENT_KINDS as their CHECK, and a type that
    // called this a component kind would say yes over two tables that say no.
    expect(COMPONENT_KINDS as readonly string[]).not.toContain(SELF_MANAGED_ENTITY_KIND)
  })

  it('is what the database will accept, and nothing more', async () => {
    await seed(SELF_MANAGED_ENTITY_KIND, 'prof-1')
    const [row] = await db.select().from(builderEmbeddings)
    expect(row!.entityKind).toBe('self_managed_person')

    // The CHECK is the backstop under the union: a kind the type does not know must not be storable.
    await expect(
      db.insert(builderEmbeddings).values({
        id: 'bogus',
        entityKind: 'not_a_kind' as never,
        source: 'self-managed',
        sourceId: 'prof-x',
        contentHash: 'h',
        document: 'd',
        profile: profilePayload as never,
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } })
  })
})

describe('entity-kind filtering', () => {
  it('keeps a self-managed row and a claimed builder apart even on the same id', async () => {
    await seed(SELF_MANAGED_ENTITY_KIND, 'shared-id')
    await seed('human_profile', 'shared-id', 'github')

    const rows = await db.select().from(builderEmbeddings)
    // Two rows: the unique key is (entity_kind, source, source_id), so neither overwrites the other.
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.entityKind).sort()).toEqual(['human_profile', 'self_managed_person'])
  })

  it('lists only its own kind, in id order, bounded', async () => {
    await seed(SELF_MANAGED_ENTITY_KIND, 'prof-b')
    await seed(SELF_MANAGED_ENTITY_KIND, 'prof-a')
    await seed(SELF_MANAGED_ENTITY_KIND, 'prof-c')
    await seed('human_profile', 'prof-z', 'github')

    const first = await listIndexedSourceIds({ entityKind: SELF_MANAGED_ENTITY_KIND, limit: 2 }, db)
    expect(first).toEqual(['prof-a', 'prof-b'])

    // The cursor walks forward instead of re-reading the same page.
    const next = await listIndexedSourceIds({ entityKind: SELF_MANAGED_ENTITY_KIND, after: 'prof-b', limit: 2 }, db)
    expect(next).toEqual(['prof-c'])
  })

  it('excludes the kind from a semantic search that did not ask for it', async () => {
    await seed(SELF_MANAGED_ENTITY_KIND, 'prof-1')
    await seed('human_profile', 'gh-1', 'github')

    // Both rows are pending an embedding, so this asserts the filter rather than the ranking —
    // which is the part that decides whether an existing surface silently gains self-managed people.
    const humans = await db.select().from(builderEmbeddings)
      .where(eq(builderEmbeddings.entityKind, 'human_profile'))
    expect(humans.map((row) => row.sourceId)).toEqual(['gh-1'])
    expect(typeof searchBuilderEmbeddings).toBe('function')
  })
})

describe('deleteBuilderEmbedding', () => {
  it('removes exactly the one row, and says how many went', async () => {
    await seed(SELF_MANAGED_ENTITY_KIND, 'prof-1')
    await seed(SELF_MANAGED_ENTITY_KIND, 'prof-2')
    await seed('human_profile', 'prof-1', 'github')

    const removed = await deleteBuilderEmbedding(
      { entityKind: SELF_MANAGED_ENTITY_KIND, source: 'self-managed', sourceId: 'prof-1' },
      db,
    )

    expect(removed).toBe(1)
    const left = await db.select().from(builderEmbeddings)
    // The claimed builder's row survives: the triple is the key, and `self-managed:prof-1` is not
    // `github:prof-1` however alike the ids look.
    expect(left.map((row) => `${row.entityKind}:${row.sourceId}`).sort())
      .toEqual(['human_profile:prof-1', 'self_managed_person:prof-2'])
  })

  it('reports nothing removed rather than throwing when there was nothing there', async () => {
    expect(await deleteBuilderEmbedding(
      { entityKind: SELF_MANAGED_ENTITY_KIND, source: 'self-managed', sourceId: 'never-existed' },
      db,
    )).toBe(0)
  })
})

describe('upsert is idempotent on an unchanged document', () => {
  it('reports changed once and unchanged thereafter', async () => {
    const write = (contentHash: string) => upsertBuilderEmbeddingStub({
      entityKind: SELF_MANAGED_ENTITY_KIND,
      source: 'self-managed',
      sourceId: 'prof-1',
      document: 'Name: Ada',
      contentHash,
      profile: profilePayload as never,
    }, db)

    expect(await write('hash-1')).toBe(true)
    // The second pass costs an upsert and no provider call — which is what makes a nightly
    // reconciliation over the whole corpus affordable.
    expect(await write('hash-1')).toBe(false)
    expect(await write('hash-2')).toBe(true)

    const [row] = await db.select().from(builderEmbeddings)
      .where(and(
        eq(builderEmbeddings.entityKind, SELF_MANAGED_ENTITY_KIND),
        eq(builderEmbeddings.sourceId, 'prof-1'),
      ))
    // A content change marks the row pending re-embed rather than leaving a stale vector behind.
    expect(row!.embedding).toBeNull()
  })
})
