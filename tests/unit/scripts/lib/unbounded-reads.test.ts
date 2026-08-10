import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain .mjs analysis module with no type declarations; the CLI runs it under
// bare node, so it cannot be a .ts file.
import { analyzeSource } from '../../../../scripts/lib/unbounded-reads.mjs'

/**
 * The six cases plan 01's validation task names, as permanent tests rather than as scratch files in
 * `src/`.
 *
 * The task said "add scratch fixtures ... scratch files are removed", which proves the detector
 * behaved on the afternoon somebody ran it and then deletes the evidence. Three of these six were
 * recorded in the task as cases the text-matching predecessor got *wrong* — a nested route handler
 * and a non-exported helper both counted 0 because it only saw exported declarations, and
 * two-queries-one-limit counted 0 because any `.limit(` in the body satisfied it. Deleting the
 * fixtures would delete the only thing standing between the rewrite and that regression.
 */
function analyze(text: string, path = 'src/fixture.ts') {
  return analyzeSource({ path, text })
}

describe('unbounded-read detector', () => {
  it('counts a read in an exported repository function exactly once', () => {
    const result = analyze(`
      export async function listThings(db: PostgresJsDatabase) {
        return db.select({ id: things.id }).from(things).where(eq(things.live, true))
      }
    `)
    expect(result.unbounded).toHaveLength(1)
    expect(result.unbounded[0]).toMatchObject({ name: 'listThings', exported: true, kind: 'function' })
  })

  it('counts a read inside a nested route handler', () => {
    // The predecessor scored this 0: `GET` is a property of an object literal, not an exported
    // declaration, so an entire class of request-serving read was invisible to it.
    const result = analyze(
      `
      export const ServerRoute = createServerFileRoute('/api/things').methods({
        GET: async ({ request }) => {
          const rows = await db.select().from(things)
          return json(rows)
        },
      })
    `,
      'src/routes/api/things/index.ts',
    )
    expect(result.unbounded).toHaveLength(1)
    expect(result.unbounded[0]).toMatchObject({ name: 'GET', kind: 'handler' })
  })

  it('counts a read inside a non-exported helper', () => {
    // Also 0 before. A helper is not less able to load an entire table for being module-private.
    const result = analyze(`
      async function loadEveryRow(db: PostgresJsDatabase) {
        return db.select().from(things)
      }
      export async function caller(db: PostgresJsDatabase) {
        return loadEveryRow(db)
      }
    `)
    expect(result.unbounded).toHaveLength(1)
    expect(result.unbounded[0]).toMatchObject({ name: 'loadEveryRow', exported: false })
  })

  it('counts the unbounded query when a sibling query in the same function is bounded', () => {
    // The case that matters most, and the one the predecessor could see and chose to report only
    // under an opt-in flag: it is not missing coverage but a false negative. The bound belongs to a
    // chain, not to a function body.
    const result = analyze(`
      export async function loadTwo(db: PostgresJsDatabase) {
        const [one] = await db.select().from(things).where(eq(things.id, id)).limit(1)
        const all = await db.select().from(others).where(eq(others.thingId, id))
        return { one, all }
      }
    `)
    expect(result.unbounded).toHaveLength(1)
    expect(result.unbounded[0]).toMatchObject({ name: 'loadTwo', line: 4 })
  })

  it('classifies an aggregate-only projection as an aggregate, not as unbounded', () => {
    const result = analyze(`
      export async function countThings(db: PostgresJsDatabase) {
        return db.select({ total: count() }).from(things)
      }
    `)
    expect(result.unbounded).toHaveLength(0)
    expect(result.aggregates).toHaveLength(1)
  })

  it('honours an approved unbounded-read-ok comment', () => {
    const result = analyze(`
      export async function listRegistry(db: PostgresJsDatabase) {
        // unbounded-read-ok: one row per connector, and the registry is code-defined
        return db.select().from(searchSources)
      }
    `)
    expect(result.unbounded).toHaveLength(0)
    expect(result.exempted).toHaveLength(1)
    expect(result.exempted[0].reason).toBe('one row per connector, and the registry is code-defined')
  })

  describe('the two false positives that used to need name-based exclusion lists', () => {
    it('does not report the DOM select method', () => {
      // `SearchPage.tsx` was counted for `inputRef.current?.select()` — the method that selects an
      // input's text. A Drizzle read is always `select` *and* `from`, so requiring both excludes
      // this structurally, and the file-level "does this file reach a database" regex is gone.
      const result = analyze(`
        export function SearchBox() {
          const inputRef = useRef<HTMLInputElement>(null)
          const focus = () => inputRef.current?.select()
          return <input ref={inputRef} onFocus={focus} />
        }
      `, 'src/modules/search/SearchBox.tsx')
      expect(result.unbounded).toHaveLength(0)
      expect(result.aggregates).toHaveLength(0)
    })

    it('does not report Buffer.from', () => {
      // The false positive that inflated the first survey from 50 to 113 entries.
      const result = analyze(`
        export function decode(value: string) {
          return Buffer.from(value, 'base64').toString('utf8')
        }
      `)
      expect(result.unbounded).toHaveLength(0)
    })
  })

  describe('bounds that do count', () => {
    it('accepts a chain-local limit', () => {
      const result = analyze(`
        export async function listThings(db: PostgresJsDatabase) {
          return db.select().from(things).orderBy(asc(things.id)).limit(50)
        }
      `)
      expect(result.unbounded).toHaveLength(0)
    })

    it('accepts a limit property on findMany, which has no limit method', () => {
      const result = analyze(`
        export async function listThings(db: PostgresJsDatabase) {
          return db.query.things.findMany({ where: eq(things.live, true), limit: 50 })
        }
      `)
      expect(result.unbounded).toHaveLength(0)
    })

    it('reports findMany without a limit property', () => {
      const result = analyze(`
        export async function listThings(db: PostgresJsDatabase) {
          return db.query.things.findMany({ where: eq(things.live, true) })
        }
      `)
      expect(result.unbounded).toHaveLength(1)
    })
  })

  it('treats selectDistinct as a list read', () => {
    // Found in the sweep, not in the design: `listNotedOrganizationBuilders` opens with
    // `selectDistinct({ builderId }).from(builderNotes)` over a whole organization's notes, and only
    // the *second* query in that function was being reported. `selectDistinctOn` is the same shape.
    const distinct = analyze(`
      export async function listNoted(tx: TenantTransaction) {
        return tx.selectDistinct({ builderId: builderNotes.builderId }).from(builderNotes).where(eq(builderNotes.organizationId, id))
      }
    `)
    expect(distinct.unbounded).toHaveLength(1)

    const distinctOn = analyze(`
      export async function listLatest(tx: TenantTransaction) {
        return tx.selectDistinctOn([things.key], { key: things.key }).from(things)
      }
    `)
    expect(distinctOn.unbounded).toHaveLength(1)
  })

  it('reports one entry per chain, not one per method call in the chain', () => {
    // Walking the spine twice would report `.where`, `.orderBy` and `.from` as three reads.
    const result = analyze(`
      export async function listThings(db: PostgresJsDatabase) {
        return db.select({ id: things.id }).from(things).where(eq(things.live, true)).orderBy(asc(things.id))
      }
    `)
    expect(result.unbounded).toHaveLength(1)
  })
})
