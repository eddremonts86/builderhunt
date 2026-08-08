/**
 * `SearchPage` against the plan-11 response contract.
 *
 * Four behaviours, each of which was wrong or missing before this plan:
 *
 * 1. **Reset.** Changing a source, the country, the language or the semantic toggle discards the
 *    loaded rows and the cursor. Keeping them earned a 400 on the next scroll — the continuation is
 *    bound to all four — and, worse, put rows from two different queries under one heading.
 * 2. **Degraded empty.** Zero results with a source that did not answer is not "nobody matched".
 *    The endpoint has reported per-source health since connector isolation landed and this page
 *    never read it, so a GitHub timeout and an empty result set looked identical.
 * 3. **Retry keeps loaded rows.** A failing second page stops the walk; it does not throw away the
 *    first page the user is reading.
 * 4. **Unknown total.** `aria-rowcount` is -1, not the loaded count. A federation cannot count
 *    without exhausting every upstream, and announcing "row 50 of 50" at the top of a longer list
 *    is worse than announcing nothing.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...rest}>{children}</a>,
  useLocation: () => ({ pathname: '/search', searchStr: '' }),
  useSearch: () => ({}),
  // Reached through `BuilderResultActions`, which every rendered card mounts.
  useNavigate: () => () => {},
  useRouter: () => ({ navigate: () => {} }),
}))
vi.mock('~/shared/lib/ai/useAICapabilities', () => ({ useAICapabilities: () => ({ available: false }) }))
vi.mock('~/shared/lib/ai/client', () => ({ ai: async () => { throw new Error('unavailable') } }))

const { SearchPage } = await import('~/modules/search/components/SearchPage')

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // The page observes a sentinel for infinite scroll; happy-dom has no IntersectionObserver.
  ;(globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    disconnect() {}
  }
  /*
   * This happy-dom build exposes no `localStorage` at all.
   *
   * The page reads it for recent searches and for the persisted source/location/language
   * selection, inside try/catch, so it survives without one — but then the source pills would
   * silently take their defaults rather than anything a test set, and "the toggle changed" would
   * be untestable. A minimal in-memory stand-in makes that state real.
   */
  const store = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => { store.clear() },
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() { return store.size },
  } as Storage
})

interface BuilderStub {
  id: string
  kind: 'person'
  source: string
  sourceId: string
  username: string
  profileUrl: string
  topics: string[]
}

function builders(label: string, count: number): BuilderStub[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `github:${label}-${index}`,
    kind: 'person' as const,
    source: 'github',
    sourceId: `${label}-${index}`,
    username: `${label}-${index}`,
    profileUrl: `https://github.com/${label}-${index}`,
    topics: [],
  }))
}

/** Queued responses, consumed in order. `/api/plans/me` is answered separately and always. */
let searchResponses: Array<{ ok: boolean; body: unknown }> = []

function respond(body: unknown) {
  return { ok: true, body }
}

beforeEach(() => {
  searchResponses = []
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/plans/me')) {
      return { ok: true, json: async () => ({ plan: { plan: 'free' } }) } as Response
    }
    const next = searchResponses.shift()
    if (!next) return { ok: true, json: async () => ({ builders: [], nextCursor: null, sources: [] }) } as Response
    return { ok: next.ok, status: next.ok ? 200 : 500, json: async () => next.body } as Response
  }))
})

let host: HTMLDivElement
let root: Root

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function render(): HTMLDivElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root.render(<SearchPage />) })
  return host
}

/** Type a query and submit, letting every queued promise settle. */
async function search(term = 'rust'): Promise<void> {
  const input = host.querySelector('input[type="search"], input[name="q"], input') as HTMLInputElement
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, term)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const form = host.querySelector('form')!
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

function click(testId: string): Promise<void> {
  // `document`, not `host`: the filters dialog renders through a portal, so its controls are not
  // inside the container this test mounted into.
  const element = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement
  expect(element, `missing [data-testid="${testId}"]`).toBeTruthy()
  return act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('SearchPage — plan 11 response contract', () => {
  it('announces an unknown row count rather than the loaded one', async () => {
    render()
    searchResponses.push(respond({
      builders: builders('a', 3),
      nextCursor: 'cursor-1',
      total: null,
      consistency: 'provider-best-effort',
      sources: [{ source: 'github', health: 'ok', resultCount: 3, durationMs: 0 }],
      degraded: false,
    }))
    await search()

    const grid = host.querySelector('[role="grid"]')
    expect(grid, 'results render through the shared shell').toBeTruthy()
    // -1 is what ARIA reserves for "not known". The loaded count would be 4 here (3 rows + header).
    expect(grid!.getAttribute('aria-rowcount')).toBe('-1')
  })

  it('treats an empty result with an unanswered source as degraded, not as "nobody matched"', async () => {
    render()
    searchResponses.push(respond({
      builders: [],
      nextCursor: null,
      total: null,
      sources: [
        { source: 'github', health: 'timeout', resultCount: 0, durationMs: 8000, detail: 'No response within 8000ms' },
        { source: 'hn', health: 'ok', resultCount: 0, durationMs: 12 },
      ],
      degraded: true,
    }))
    await search()

    expect(host.querySelector('[data-testid="search-degraded-notice"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="search-source-status-github"]')?.textContent)
      .toContain('No response within 8000ms')
    // A healthy source that simply found nothing is not listed as a problem.
    expect(host.querySelector('[data-testid="search-source-status-hn"]')).toBeNull()
    // And the "try a different query" advice is suppressed, because the query may have been fine.
    expect(host.textContent).not.toContain('Try a popular search')
  })

  it('keeps the loaded rows when the next page fails', async () => {
    render()
    searchResponses.push(respond({
      builders: builders('a', 3),
      nextCursor: 'cursor-1',
      total: null,
      sources: [{ source: 'github', health: 'ok', resultCount: 3, durationMs: 0 }],
      degraded: false,
    }))
    await search()
    expect(host.querySelectorAll('[role="row"][data-testid^="search-result-"]')).toHaveLength(3)

    searchResponses.push({ ok: false, body: { error: 'upstream exploded' } })
    await click('load-more-button')

    // The rows the user is reading survive; only the walk stops.
    expect(host.querySelectorAll('[role="row"][data-testid^="search-result-"]')).toHaveLength(3)
    expect(host.querySelector('[data-testid="load-more-button"]')).toBeNull()
    expect(host.querySelector('[data-testid="end-of-results"]')).toBeTruthy()
  })

  it('appends the next page rather than replacing it', async () => {
    render()
    searchResponses.push(respond({
      builders: builders('a', 3),
      nextCursor: 'cursor-1',
      total: null,
      sources: [{ source: 'github', health: 'ok', resultCount: 3, durationMs: 0 }],
      degraded: false,
    }))
    await search()

    searchResponses.push(respond({
      builders: builders('b', 2),
      nextCursor: null,
      total: null,
      sources: [{ source: 'github', health: 'ok', resultCount: 2, durationMs: 0 }],
      degraded: false,
    }))
    await click('load-more-button')

    expect(host.querySelectorAll('[role="row"][data-testid^="search-result-"]')).toHaveLength(5)
    // The second request carried the cursor and no page number.
    const body = JSON.parse((vi.mocked(fetch).mock.calls.at(-1)![1] as RequestInit).body as string)
    expect(body.cursor).toBe('cursor-1')
    expect(body.page).toBeUndefined()
    expect(body.perPage).toBeUndefined()
  })

  it('discards the loaded rows and the cursor when a source toggle changes', async () => {
    render()
    searchResponses.push(respond({
      builders: builders('a', 3),
      nextCursor: 'cursor-1',
      total: null,
      sources: [{ source: 'github', health: 'ok', resultCount: 3, durationMs: 0 }],
      degraded: false,
    }))
    await search()
    expect(host.querySelectorAll('[role="row"][data-testid^="search-result-"]')).toHaveLength(3)

    // The source pills live in the "Sources & filters" dialog.
    const filters = host.querySelector('button[aria-label="Sources & filters"]') as HTMLElement
    await act(async () => { filters.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // `hn` is on by default, so this turns it off — a change to the source snapshot the cursor is
    // bound to.
    await click('search-source-hn')

    expect(host.querySelectorAll('[role="row"][data-testid^="search-result-"]')).toHaveLength(0)
    expect(host.querySelector('[data-testid="load-more-button"]')).toBeNull()
  })

  it('offers no sort control, because neither backend can sort a result set it has not exhausted', () => {
    render()
    expect(host.textContent).not.toContain('Most followers')
    expect(host.textContent).not.toContain('Best match')
  })
})
