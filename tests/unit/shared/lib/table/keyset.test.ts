import { and, type SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import { env } from '~/shared/lib/env'
import { defineTableCapability } from '~/shared/lib/table/capability'
import { TABLE_PAGE_SIZE } from '~/shared/lib/table/constants'
import { createTableCursor } from '~/shared/lib/table/cursor'
import { planKeysetPage, TableQueryError, TIEBREAKER_ID } from '~/shared/lib/table/keyset'
import { emptyTableSearch } from '~/shared/lib/table/query-url'
import { organizationDeletionRequests, sprintResults } from '~/shared/lib/db/schema'
import type { PageRequest, TableQuery } from '~/shared/lib/table/types'

const dialect = new PgDialect()

// `verifyTableCursor` reads the signing secret through `env`, so a cursor minted here has to be
// signed with the same one — and it is *not* `process.env.BETTER_AUTH_SECRET`. This suite runs in
// `happy-dom`, so `env.ts` takes its `typeof window !== 'undefined'` branch and returns the
// browser stub. Reading it from `env` is the only way the two agree.
const SECRET = env.BETTER_AUTH_SECRET as string

/** Render a predicate or an `ORDER BY` term to the SQL Postgres would actually receive. */
function render(fragment: SQL): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(fragment)
  return { sql: query.sql, params: query.params }
}

function renderAll(fragments: SQL[]): string {
  return fragments.map((fragment) => render(fragment).sql).join(' | ')
}

const capability = defineTableCapability({
  table: 'sprint_results',
  sortable: {
    score: { column: sprintResults.score },
    createdAt: { column: sprintResults.createdAt },
  },
  filterable: {
    source: { column: sprintResults.source, facet: true },
    matchedVariant: { column: sprintResults.matchedVariant, values: ['a', 'b'] },
  },
  groupable: ['source'],
  searchable: [sprintResults.sourceId],
  tiebreaker: sprintResults.id,
  defaultSort: [{ id: 'score', dir: 'desc' }],
  organizationColumn: sprintResults.organizationId,
})

const ORG = 'org_alpha'
const context = { organizationId: ORG }

function query(overrides: Partial<TableQuery> = {}): TableQuery {
  return { search: '', filters: {}, sort: [], groupBy: null, ...overrides }
}

function page(overrides: Partial<PageRequest> = {}): PageRequest {
  return { cursor: null, limit: TABLE_PAGE_SIZE, ...overrides }
}

describe('every sort is a total order', () => {
  /**
   * Without this, `ORDER BY score DESC` over rows that share a score has no defined order between
   * them, and a page boundary landing inside a tie repeats a row or drops it. The failure is
   * silent: the list looks fine and is wrong.
   */
  it('appends the tiebreaker to a requested sort', () => {
    const plan = planKeysetPage(capability, query({ sort: [{ id: 'score', dir: 'desc' }] }), page(), context)
    expect(plan.sort.terms.map((term) => term.id)).toEqual(['score', TIEBREAKER_ID])
    expect(renderAll(plan.order)).toContain('"id"')
  })

  it('appends it to the default sort too', () => {
    const plan = planKeysetPage(capability, query(), page(), context)
    expect(plan.sort.terms.map((term) => term.id)).toEqual(['score', TIEBREAKER_ID])
  })

  it('does not append it twice when the caller already sorts by that column', () => {
    const idOnly = defineTableCapability({
      ...capability,
      sortable: { ...capability.sortable, id: { column: sprintResults.id } },
    })
    const plan = planKeysetPage(idOnly, query({ sort: [{ id: 'id', dir: 'asc' }] }), page(), context)
    expect(plan.sort.terms.map((term) => term.id)).toEqual(['id'])
  })

  it('gives the tiebreaker the sort direction, because a tuple comparison has only one', () => {
    const ascending = planKeysetPage(capability, query({ sort: [{ id: 'createdAt', dir: 'asc' }] }), page(), context)
    expect(ascending.sort.terms.at(-1)?.dir).toBe('asc')
    const descending = planKeysetPage(capability, query({ sort: [{ id: 'createdAt', dir: 'desc' }] }), page(), context)
    expect(descending.sort.terms.at(-1)?.dir).toBe('desc')
  })
})

describe('no OFFSET, ever', () => {
  /** `OFFSET` walks and discards every skipped row, and it shifts under concurrent writes, so a row inserted mid-paging is seen twice or missed. */
  it('emits a row-value tuple comparison instead', () => {
    const first = planKeysetPage(capability, query(), page(), context)
    const cursor = createTableCursor(
      { t: 'sprint_results', s: first.sort.descriptor, o: ORG, k: [7, 'result_7'] },
      SECRET,
    )
    const next = planKeysetPage(capability, query(), page({ cursor }), context)

    const sql = renderAll(next.rowConditions).toLowerCase()
    expect(sql).not.toContain('offset')
    expect(sql).toMatch(/\("sprint_results"\."score", "sprint_results"\."id"\) < \(\$\d+, \$\d+\)/)
  })

  it('never puts an offset in the ORDER BY either', () => {
    const plan = planKeysetPage(capability, query(), page(), context)
    expect(renderAll(plan.order).toLowerCase()).not.toContain('offset')
  })
})

describe('unknown ids are refused, not absorbed', () => {
  /**
   * Deliberately not a fallback to `defaultSort`. A fallback teaches a caller that a typo is
   * harmless and hides the bug until the day the id matters.
   */
  it('throws on an unknown sort id rather than falling back to the default sort', () => {
    expect(() => planKeysetPage(capability, query({ sort: [{ id: 'salary', dir: 'desc' }] }), page(), context))
      .toThrow(TableQueryError)
    expect(() => planKeysetPage(capability, query({ sort: [{ id: 'salary', dir: 'desc' }] }), page(), context))
      .toThrow(/Unknown sort column: salary/)
  })

  it('throws on an unknown filter id', () => {
    expect(() => planKeysetPage(capability, query({ filters: { salary: ['high'] } }), page(), context))
      .toThrow(/Unknown filter column: salary/)
  })

  it('throws on a filter value outside the declared allowlist', () => {
    expect(() => planKeysetPage(capability, query({ filters: { matchedVariant: ['c'] } }), page(), context))
      .toThrow(/Unknown value for filter matchedVariant: c/)
  })

  it('accepts a declared filter value', () => {
    const plan = planKeysetPage(capability, query({ filters: { matchedVariant: ['a'] } }), page(), context)
    expect(plan.filters.has('matchedVariant')).toBe(true)
  })

  it('throws on an unknown group id', () => {
    expect(() => planKeysetPage(capability, query({ groupBy: 'salary' }), page(), context))
      .toThrow(/Unknown group column: salary/)
  })

  it('refuses a mixed-direction sort rather than emitting an incorrect keyset', () => {
    expect(() => planKeysetPage(
      capability,
      query({ sort: [{ id: 'score', dir: 'desc' }, { id: 'createdAt', dir: 'asc' }] }),
      page(),
      context,
    )).toThrow(/Mixed sort directions/)
  })
})

describe('the tenant predicate is emitted as well as enforced by RLS', () => {
  it('adds organization_id = :current to every query', () => {
    const plan = planKeysetPage(capability, query(), page(), context)
    const rendered = render(and(...plan.base) as SQL)
    expect(rendered.sql).toContain('"organization_id"')
    expect(rendered.params).toContain(ORG)
  })

  it('omits it for a table that declares no organization column', () => {
    const global = defineTableCapability({ ...capability, organizationColumn: undefined })
    const plan = planKeysetPage(global, query(), page(), { organizationId: null })
    expect(plan.base).toHaveLength(0)
  })
})

describe('values are bound, never interpolated', () => {
  /**
   * The whole point of the allowlist is that an id cannot reach a column reference. This asserts
   * the other half: a *value* full of quotes and keywords changes the parameter list and nothing
   * structural about the SQL.
   */
  it('binds a quote-heavy filter value as a parameter', () => {
    const hostile = "a'); drop table sprint_results; --"
    const open = defineTableCapability({
      ...capability,
      filterable: { source: { column: sprintResults.source } },
      groupable: [],
    })
    const clean = planKeysetPage(open, query({ filters: { source: ['github'] } }), page(), context)
    const attacked = planKeysetPage(open, query({ filters: { source: [hostile] } }), page(), context)

    expect(render(attacked.filters.get('source') as SQL).sql)
      .toBe(render(clean.filters.get('source') as SQL).sql)
    expect(render(attacked.filters.get('source') as SQL).params).toEqual([hostile])
  })

  it('escapes ILIKE wildcards so a user typing % does not search for everything', () => {
    const plan = planKeysetPage(capability, query({ search: '100%_x' }), page(), context)
    const rendered = render(plan.base.at(-1) as SQL)
    expect(rendered.sql).toContain('ilike')
    expect(rendered.params).toEqual(['%100\\%\\_x%'])
  })
})

describe('page size is the server\'s', () => {
  it('clamps a client asking for more', () => {
    expect(planKeysetPage(capability, query(), page({ limit: 5000 }), context).limit).toBe(TABLE_PAGE_SIZE)
  })

  it('honours a client asking for fewer', () => {
    expect(planKeysetPage(capability, query(), page({ limit: 10 }), context).limit).toBe(10)
  })

  it('defaults a missing limit to the page size', () => {
    expect(planKeysetPage(capability, query(), page({ limit: 0 }), context).limit).toBe(TABLE_PAGE_SIZE)
  })

  it('reads its default straight out of the URL codec', () => {
    const parsed = emptyTableSearch()
    expect(planKeysetPage(capability, parsed.query, parsed.page, context).limit).toBe(TABLE_PAGE_SIZE)
  })
})

describe('a nullable sort column', () => {
  /**
   * A row-value comparison has no notion of `NULLS LAST`, so on a nullable column it silently
   * skips rows on one side of the null boundary. The builder switches to the lexicographic
   * OR-form instead — which is why `nullsLast` is part of the capability and not a display hint.
   */
  const nullable = defineTableCapability({
    table: 'organization_deletion_requests',
    sortable: { completedAt: { column: organizationDeletionRequests.completedAt, nullsLast: true } },
    filterable: {},
    groupable: [],
    searchable: [],
    tiebreaker: organizationDeletionRequests.id,
    defaultSort: [{ id: 'completedAt', dir: 'asc' }],
    organizationColumn: organizationDeletionRequests.organizationId,
  })

  function cursorFor(tuple: Array<string | number | null>) {
    const plan = planKeysetPage(nullable, query(), page(), context)
    return createTableCursor(
      { t: 'organization_deletion_requests', s: plan.sort.descriptor, o: ORG, k: tuple },
      SECRET,
    )
  }

  it('emits the null-aware form, not a row-value comparison', () => {
    const plan = planKeysetPage(nullable, query(), page({ cursor: cursorFor(['2026-01-01T00:00:00Z', 'e1']) }), context)
    const sql = render(plan.rowConditions.at(-1) as SQL)
    expect(sql.sql).toContain('is null')
    expect(sql.sql).toContain('is not distinct from')
    expect(sql.sql).not.toMatch(/\("organization_deletion_requests"\."completed_at", "organization_deletion_requests"\."id"\) >/)
  })

  it('treats a null cursor value as "past the end of that term"', () => {
    const plan = planKeysetPage(nullable, query(), page({ cursor: cursorFor([null, 'e1']) }), context)
    const sql = render(plan.rowConditions.at(-1) as SQL).sql
    // Nulls sort last, so nothing follows a null in the first term; only the tiebreaker branch
    // survives, and it is guarded by `ends_at is not distinct from null`.
    expect(sql).toContain('is not distinct from')
    expect(sql).toContain('"id" >')
  })

  it('still emits NULLS LAST in the ORDER BY', () => {
    const plan = planKeysetPage(nullable, query(), page(), context)
    expect(renderAll(plan.order).toLowerCase()).toContain('nulls last')
  })
})

describe('a cursor that does not match the request', () => {
  it('is refused when its tuple is the wrong length', () => {
    const plan = planKeysetPage(capability, query(), page(), context)
    const short = createTableCursor({ t: 'sprint_results', s: plan.sort.descriptor, o: ORG, k: [7] }, SECRET)
    expect(() => planKeysetPage(capability, query(), page({ cursor: short }), context))
      .toThrow(/Cursor does not match the sort/)
  })
})
