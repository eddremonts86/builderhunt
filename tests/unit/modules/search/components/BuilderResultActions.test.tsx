// BuilderResultActions — the shared tracked/untracked/unsupported-source/plan-limit action
// contract (plans/UI/tasks.md Wave 2 "Create a shared builder result action contract").

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const navigateSpy = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return { ...actual, useNavigate: () => navigateSpy }
})

const { BuilderResultActions } = await import('~/modules/search/components/BuilderResultActions')
type BuilderResultActionsBuilder = Parameters<typeof BuilderResultActions>[0]['builder']

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
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

function baseBuilder(overrides: Partial<BuilderResultActionsBuilder> = {}): BuilderResultActionsBuilder {
  return {
    id: 'result-1',
    source: 'github',
    sourceId: 'gh-1',
    username: 'octocat',
    displayName: 'Octo Cat',
    profileUrl: 'https://github.com/octocat',
    ...overrides,
  }
}

function render(props: { builder: ReturnType<typeof baseBuilder>; from?: string; onTracked?: (id: string) => void }) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => {
    root.render(<BuilderResultActions builder={props.builder} from={props.from} onTracked={props.onTracked} />)
  })
  return host
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('BuilderResultActions', () => {
  it('renders "Open workspace" for an already-tracked result and navigates there on click', () => {
    const host = render({ builder: baseBuilder({ tracked: true, trackedRowId: 'org-builder-1' }) })
    const openButton = host.querySelector('[data-testid="open-workspace-result-1"]') as HTMLElement
    expect(openButton).toBeTruthy()
    expect(host.querySelector('[data-testid="track-and-open-result-1"]')).toBeNull()

    click(openButton)

    expect(navigateSpy).toHaveBeenCalledWith(expect.objectContaining({
      to: '/builder/$builderId',
      params: { builderId: 'org-builder-1' },
    }))
  })

  it('renders "Track & open" for an untracked, trackable result', () => {
    const host = render({ builder: baseBuilder() })
    expect(host.querySelector('[data-testid="track-and-open-result-1"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="open-workspace-result-1"]')).toBeNull()
  })

  it('tracks then navigates using the returned organization-builder id, and reports it via onTracked', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'new-org-builder-1', tracked: true }),
    } as Response)
    const onTracked = vi.fn()

    const host = render({ builder: baseBuilder(), from: '/search?q=rust', onTracked })
    click(host.querySelector('[data-testid="track-and-open-result-1"]') as HTMLElement)
    await flush()

    expect(fetchMock).toHaveBeenCalledWith('/api/builders/track', expect.objectContaining({ method: 'POST' }))
    expect(onTracked).toHaveBeenCalledWith('new-org-builder-1')
    expect(navigateSpy).toHaveBeenCalledWith(expect.objectContaining({
      to: '/builder/$builderId',
      params: { builderId: 'new-org-builder-1' },
      search: { from: '/search?q=rust' },
    }))
  })

  it('shows a disabled loading state while the track request is in flight', async () => {
    let resolveFetch!: (value: unknown) => void
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve }))

    const host = render({ builder: baseBuilder() })
    const button = host.querySelector('[data-testid="track-and-open-result-1"]') as HTMLButtonElement
    click(button)
    await flush()

    expect(button.disabled).toBe(true)

    resolveFetch({ ok: true, status: 200, json: async () => ({ id: 'x' }) })
    await flush()
  })

  it('shows an upgrade message on a 402 plan-limit response, without losing the result', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 402,
      json: async () => ({ error: "You've reached the free plan limit of 5 saved builders.", upgradeUrl: '/pricing' }),
    } as Response)

    const host = render({ builder: baseBuilder() })
    click(host.querySelector('[data-testid="track-and-open-result-1"]') as HTMLElement)
    await flush()

    const error = host.querySelector('[data-testid="track-error-result-1"]')
    expect(error?.textContent).toContain("You've reached the free plan limit")
    expect(host.querySelector('a[href="/pricing"]')).toBeTruthy()
    // The result itself is still rendered — this component never removes it on failure.
    expect(host.querySelector('[data-testid="builder-result-actions-result-1"]')).toBeTruthy()
    expect(navigateSpy).not.toHaveBeenCalled()
  })

  it('disables Track & open for a non-trackable source and explains why, but still offers the external link', () => {
    const host = render({ builder: baseBuilder({ id: 'result-2', source: 'bluesky', username: 'alice.bsky.social' }) })
    const button = host.querySelector('[data-testid="track-and-open-result-2"]') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.title).toContain("Tracking Bluesky builders isn't supported yet")

    const externalLink = host.querySelector('[data-testid="open-source-profile-result-2"]') as HTMLAnchorElement
    expect(externalLink.href).toBe('https://bsky.app/profile/alice.bsky.social')
  })

  it('never renders an external link that could resolve off the source\'s own host', () => {
    // A handle containing a path separator cannot safely form a same-host URL — the registry
    // returns null rather than guessing. With no server-provided profileUrl to fall back to
    // either, this component omits the link entirely rather than falling back to `#`.
    const host = render({ builder: baseBuilder({ username: '../evil.com', profileUrl: '' }) })
    expect(host.querySelector('[data-testid="open-source-profile-result-1"]')).toBeNull()
  })

  it('falls back to the API-provided profileUrl when the registry cannot build one for an unrecognized source', () => {
    const host = render({ builder: baseBuilder({ source: 'not-a-real-source', profileUrl: 'https://example.com/octocat' }) })
    const externalLink = host.querySelector('[data-testid="open-source-profile-result-1"]') as HTMLAnchorElement
    expect(externalLink.href).toBe('https://example.com/octocat')
  })
})
