import { TABLE_PAGE_SIZE } from './constants'
import type { PageRequest, TableQuery, TableSearch } from './types'

/**
 * The URL is the table's state.
 *
 * A filtered, sorted, grouped view has to be a link — that is the whole reason this is a search
 * schema and not component state. `tableSearchSchema` is written to be handed straight to a
 * route's `validateSearch`, which is already the repo's idiom (see
 * `src/routes/_dashboard/admin/content.tsx`, which keeps its open tab in `?tab=`).
 *
 * Two properties are load-bearing rather than nice:
 *
 * 1. **Round-trip stability.** The shell writes the URL and the loader reads it back on every
 *    interaction, so `parse(serialize(q))` must deep-equal `q` or a single click can drift the
 *    view away from the link that produced it.
 * 2. **Tolerance.** An unrecognised parameter, a malformed sort term, an unknown direction — all
 *    ignored, never rejected. A stale link from an email six months ago still has to open the
 *    page, just without the part that no longer exists.
 *
 * `limit` is deliberately not in the URL. Page size is what the server is willing to serve, and a
 * link that could widen its own page is a link that can ask for the whole table.
 */

/** Column ids reach `ORDER BY` through plan 03's allowlist, but a malformed id never gets that far. */
const COLUMN_ID = /^[A-Za-z][A-Za-z0-9_-]*$/

const FILTER_PREFIX = 'filter.'
const DEFAULT_RENDERER = 'table'

function readString(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(readString).filter((entry): entry is string => entry !== null && entry !== '')
  }
  const single = readString(value)
  return single === null || single === '' ? [] : [single]
}

/** `name:asc,createdAt:desc` → sort terms. Malformed terms and repeated ids are dropped. */
function parseSort(raw: string | null): TableQuery['sort'] {
  if (!raw) return []
  const seen = new Set<string>()
  const sort: TableQuery['sort'] = []
  for (const term of raw.split(',')) {
    const [id, dir] = term.split(':')
    if (!id || !COLUMN_ID.test(id) || seen.has(id)) continue
    if (dir !== 'asc' && dir !== 'desc') continue
    seen.add(id)
    sort.push({ id, dir })
  }
  return sort
}

function serializeSort(sort: TableQuery['sort']): string {
  return sort.map((term) => `${term.id}:${term.dir}`).join(',')
}

/**
 * Parse a route's search params into the table contract.
 *
 * Usable directly as `validateSearch`. Anything it does not recognise is left where it found it.
 */
export function tableSearchSchema(search: Record<string, unknown>): TableSearch {
  const filters: Record<string, string[]> = {}
  for (const [key, raw] of Object.entries(search)) {
    if (!key.startsWith(FILTER_PREFIX)) continue
    const id = key.slice(FILTER_PREFIX.length)
    if (!COLUMN_ID.test(id)) continue
    // Duplicates are collapsed: `?filter.tier=pro&filter.tier=pro` is one selection, and keeping
    // both would make the round trip lossy for no gain.
    const values = [...new Set(readStringArray(raw))]
    // An empty array is the absence of a filter, not a filter matching nothing.
    if (values.length > 0) filters[id] = values
  }

  const groupRaw = readString(search.group)
  const rendererRaw = readString(search.as)
  const cursorRaw = readString(search.cursor)

  const query: TableQuery = {
    search: readString(search.q) ?? '',
    filters,
    sort: parseSort(readString(search.sort)),
    groupBy: groupRaw && COLUMN_ID.test(groupRaw) ? groupRaw : null,
  }

  const page: PageRequest = {
    cursor: cursorRaw === null || cursorRaw === '' ? null : cursorRaw,
    limit: TABLE_PAGE_SIZE,
  }

  return {
    query,
    page,
    renderer: rendererRaw && rendererRaw !== '' ? rendererRaw : DEFAULT_RENDERER,
  }
}

/**
 * The inverse: table state → search params.
 *
 * Defaults are omitted so a pristine table has a clean URL, and `tableSearchSchema` restores every
 * omission to the same default it dropped.
 */
export function serializeTableSearch(search: TableSearch): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {}

  if (search.query.search !== '') params.q = search.query.search
  if (search.query.sort.length > 0) params.sort = serializeSort(search.query.sort)
  if (search.query.groupBy !== null) params.group = search.query.groupBy
  if (search.renderer !== DEFAULT_RENDERER) params.as = search.renderer
  if (search.page.cursor !== null) params.cursor = search.page.cursor

  for (const [id, values] of Object.entries(search.query.filters)) {
    if (values.length === 0) continue
    params[`${FILTER_PREFIX}${id}`] = values
  }

  return params
}

/** The same thing as a `URLSearchParams`, for building an href. Multi-value filters repeat. */
export function tableSearchToParams(search: TableSearch): URLSearchParams {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(serializeTableSearch(search))) {
    if (Array.isArray(value)) {
      for (const entry of value) params.append(key, entry)
      continue
    }
    params.set(key, value)
  }
  return params
}

/** An empty table's state — page one, no search, no filters, no sort, default renderer. */
export function emptyTableSearch(): TableSearch {
  return {
    query: { search: '', filters: {}, sort: [], groupBy: null },
    page: { cursor: null, limit: TABLE_PAGE_SIZE },
    renderer: DEFAULT_RENDERER,
  }
}
