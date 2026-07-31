// TeamActivityPage — fetches its own first page on mount.
//
// The route always hands this component an empty `initialRows`/`initialCursor`
// (see team/activity.tsx's own comment: SSR is intentionally minimal). Before
// this test existed, `loadMore` only ever ran from a "Load more" click, which
// requires a truthy `state.cursor` — starting from `null`, the button never
// even rendered, so the page silently showed "No activity yet" forever
// regardless of how much activity actually existed.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const navigateSpy = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateSpy,
  // The real Link needs a router context this component does not otherwise
  // require — rendered as a plain anchor, which is all these assertions need.
  Link: (props: { to: string; className?: string; children: React.ReactNode }) => (
    <a href={props.to} className={props.className}>{props.children}</a>
  ),
}))

const { TeamActivityPage } = await import('~/modules/dashboard/components/TeamActivityPage')
type ActivityRowDTO = Parameters<typeof TeamActivityPage>[0]['initialRows'][number]

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  navigateSpy.mockClear()
  fetchMock.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function row(overrides: Partial<ActivityRowDTO> = {}): ActivityRowDTO {
  return {
    id: 'row-1',
    type: 'saved_query_created',
    version: 1,
    actorUserId: 'u-1',
    actorDisplayName: 'Ada Lovelace',
    targetKey: 'q-1',
    metadata: { queryId: 'q-1', queryName: 'rust', visibility: 'private' },
    occurredAt: '2026-07-31T12:00:00.000Z',
    display: 'Created search "rust"',
    targetHref: '/search?q=rust',
    ...overrides,
  }
}

async function render() {
  await act(async () => {
    root.render(<TeamActivityPage initialRows={[]} initialCursor={null} />)
  })
}

describe('TeamActivityPage', () => {
  it('fetches its first page on mount without requiring a click', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ rows: [row()], nextCursor: null }),
    })
    await render()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).not.toContain('before=')
    expect(host.textContent).toContain('Created search "rust"')
    expect(host.textContent).toContain('Ada Lovelace')
  })

  it('shows the empty state only after a real fetch confirms there is nothing', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ rows: [], nextCursor: null }) })
    await render()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('No activity yet')
  })

  it('renders a fetch failure as an inline error rather than a silent empty state', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) })
    await render()
    expect(host.textContent).toContain('boom')
  })

  it('"Load more" appends the next page using the server-issued cursor, not a client-derived one', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rows: [row({ id: 'row-1' })], nextCursor: { before: '2026-07-31T12:00:00.000Z', id: 'row-1' } }),
    })
    await render()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rows: [row({ id: 'row-2', display: 'Created search "go"' })], nextCursor: null }),
    })
    const button = host.querySelector('[data-testid="team-activity-load-more"]') as HTMLButtonElement
    expect(button).toBeTruthy()
    await act(async () => {
      button.click()
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [secondUrl] = fetchMock.mock.calls[1]
    expect(String(secondUrl)).toContain('before=2026-07-31T12%3A00%3A00.000Z')
    expect(String(secondUrl)).toContain('id=row-1')
    expect(host.textContent).toContain('Created search "rust"')
    expect(host.textContent).toContain('Created search "go"')
  })
})
