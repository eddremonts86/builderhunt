import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActiveSessionsPanel, type ActiveSessionEntry } from './ActiveSessionsPanel'

// better-auth's client uses its own internal fetch reference (captured at
// client-creation time, before any per-test `vi.stubGlobal('fetch', ...)`
// runs) — stubbing global `fetch` alone lets `revokeSession`/
// `revokeOtherSessions` escape to a real network call. Mock the module
// boundary instead: the panel's own `/api/me/sessions` GET still goes
// through plain (stubbed) `fetch`, only the two better-auth client calls are
// replaced here. `vi.hoisted` so these mocks exist before the (also hoisted)
// `vi.mock` factory below references them.
const { revokeSessionMock, revokeOtherSessionsMock } = vi.hoisted(() => ({
  revokeSessionMock: vi.fn(),
  revokeOtherSessionsMock: vi.fn(),
}))
vi.mock('~/shared/lib/auth/client', () => ({
  authClient: {
    revokeSession: (...args: unknown[]) => revokeSessionMock(...args),
    revokeOtherSessions: (...args: unknown[]) => revokeOtherSessionsMock(...args),
  },
}))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const NOW = new Date('2026-07-24T12:00:00.000Z').toISOString()

function sessions(overrides: Partial<ActiveSessionEntry>[] = []): ActiveSessionEntry[] {
  const base: ActiveSessionEntry[] = [
    {
      id: 'session-current', token: 'token-current', isCurrent: true, createdAt: NOW, lastActiveAt: NOW,
      uaFamily: 'chrome', trustState: 'trusted', isNewDevice: false, country: null,
    },
    {
      id: 'session-other', token: 'token-other', isCurrent: false, createdAt: NOW, lastActiveAt: NOW,
      uaFamily: 'firefox', trustState: 'new', isNewDevice: true, country: null,
    },
  ]
  return overrides.length ? overrides.map((o, i) => ({ ...base[i], ...o })) : base
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let fetchMock: ReturnType<typeof vi.fn>
let sessionsResponse: ActiveSessionEntry[] = sessions()

beforeEach(() => {
  sessionsResponse = sessions()
  revokeSessionMock.mockReset().mockResolvedValue({ data: { status: true }, error: null })
  revokeOtherSessionsMock.mockReset().mockResolvedValue({ data: { status: true }, error: null })
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/me/sessions')) {
      return new Response(JSON.stringify(sessionsResponse), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<ActiveSessionsPanel />)
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('ActiveSessionsPanel', () => {
  it('lists sessions with device family and current/new-device badges', async () => {
    await mount()
    const text = container!.textContent ?? ''
    expect(text).toContain('Chrome')
    expect(text).toContain('Firefox')
    expect(text).toContain('This device')
    expect(text).toContain('New')
  })

  it('shows a flagged badge for a device with trustState "flagged"', async () => {
    sessionsResponse = sessions([
      { trustState: 'trusted' },
      { trustState: 'flagged', isNewDevice: false },
    ])
    await mount()
    expect(container!.textContent).toContain('Flagged')
  })

  it('does not render a Sign out button for the current session', async () => {
    await mount()
    expect(container!.querySelector('[data-testid="sign-out-btn-session-current"]')).toBeNull()
    expect(container!.querySelector('[data-testid="sign-out-btn-session-other"]')).not.toBeNull()
  })

  it('signs out a single other session and refetches the list', async () => {
    await mount()
    const button = container!.querySelector('[data-testid="sign-out-btn-session-other"]') as HTMLButtonElement
    await act(async () => {
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(revokeSessionMock).toHaveBeenCalledWith({ token: 'token-other' })
    // Reloaded the list after revoking.
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/me/sessions')).length).toBe(2)
  })

  it('signs out every other session via "Sign out everywhere else"', async () => {
    await mount()
    const button = container!.querySelector('[data-testid="sign-out-others-btn"]') as HTMLButtonElement
    expect(button).not.toBeNull()
    await act(async () => {
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(revokeOtherSessionsMock).toHaveBeenCalledTimes(1)
  })

  it('hides "Sign out everywhere else" when there is only one session', async () => {
    sessionsResponse = sessions([{ isCurrent: true }]).slice(0, 1)
    await mount()
    expect(container!.querySelector('[data-testid="sign-out-others-btn"]')).toBeNull()
  })

  it('shows an empty state with no sessions', async () => {
    sessionsResponse = []
    await mount()
    expect(container!.querySelector('[data-testid="active-sessions-empty"]')).not.toBeNull()
  })

  it('shows an error state when the list fetch fails', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('error', { status: 500 }))
    await mount()
    expect(container!.querySelector('[data-testid="active-sessions-error"]')).not.toBeNull()
  })
})
