import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { switchToPersonalWorkspace } from '~/routes/_dashboard/settings/team'

/**
 * Regression coverage for the "403 after leaving/deleting your active org" bug: the session's
 * `activeOrganizationId` gets FK-nulled the moment the org/membership row is gone, and nothing
 * auto-picks a replacement for an already-live session. `switchToPersonalWorkspace` is what
 * `leaveOrganizationContext` (shared by the "Leave" and "Delete immediately" handlers) calls right
 * before navigating away, to land the session back on a valid organization.
 */

let fetchMock: ReturnType<typeof vi.fn>

function organizations(overrides: Partial<{ id: string; isPersonal: boolean }>[] = []) {
  const base = [
    { id: 'org-team', name: 'Acme', slug: 'acme', role: 'owner' as const, isPersonal: false },
    { id: 'org-personal', name: 'Personal workspace', slug: 'personal-abc', role: 'owner' as const, isPersonal: true },
  ]
  return overrides.length ? overrides.map((o, i) => ({ ...base[i], ...o })) : base
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('switchToPersonalWorkspace', () => {
  it('finds the personal organization and switches the session onto it', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/organizations') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(organizations()), { status: 200 })
      }
      if (url.endsWith('/api/organizations/switch')) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    await switchToPersonalWorkspace()

    expect(fetchMock).toHaveBeenCalledWith('/api/organizations', { credentials: 'include' })
    const switchCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/organizations/switch'))
    expect(switchCall).toBeDefined()
    const [, init] = switchCall!
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    expect(JSON.parse(init.body as string)).toEqual({ organizationId: 'org-personal' })
  })

  it('does nothing (never throws) when the organizations fetch fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('error', { status: 500 }))

    await expect(switchToPersonalWorkspace()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does nothing (never throws) when fetch rejects outright', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    await expect(switchToPersonalWorkspace()).resolves.toBeUndefined()
  })

  it('does not call switch when no personal organization is present', async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/organizations')) {
        return new Response(JSON.stringify([{ id: 'org-team', name: 'Acme', slug: 'acme', role: 'owner', isPersonal: false }]), { status: 200 })
      }
      return new Response('not found', { status: 404 })
    })

    await switchToPersonalWorkspace()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalledWith('/api/organizations/switch', expect.anything())
  })
})
