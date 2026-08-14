import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { UserSegmentSettings } from '~/modules/dashboard/components/UserSegmentSettings'
import { USER_SEGMENT_COPY, USER_SEGMENTS } from '~/shared/lib/user-segments'
import type { UserPreferencesResponse } from '~/shared/lib/user-preferences-api'

/**
 * The settings surface, and the two things it must never get wrong.
 *
 * **It must disappear when the feature is off.** The flag lives on the server — the API answers 404
 * while `USER_SEGMENTATION_ENABLED` is `false` — and this component hiding itself on that 404 is
 * what stops the flag from having a second home in the client that could drift out of step.
 *
 * **It must not claim a save it did not get.** A preference that silently fails to persist is
 * discovered days later, by which point nobody connects the two.
 */

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  container = null
  root = null
})

async function mount(node: React.ReactElement) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(node)
  })
  return container
}

function preferences(overrides: Partial<UserPreferencesResponse> = {}): UserPreferencesResponse {
  return {
    primarySegment: null,
    source: null,
    schemaVersion: null,
    selectedAt: null,
    available: [...USER_SEGMENTS],
    ...overrides,
  }
}

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response
const failed = (status: number) => ({ ok: false, status, json: async () => ({ error: 'x' }) }) as Response

function radios(root: HTMLElement): HTMLInputElement[] {
  return [...root.querySelectorAll<HTMLInputElement>('input[type="radio"]')]
}

function radioFor(root: HTMLElement, segment: (typeof USER_SEGMENTS)[number]): HTMLInputElement {
  const found = radios(root).find((input) => input.value === segment)
  if (!found) throw new Error(`no radio for ${segment}`)
  return found
}

describe('when the feature is off', () => {
  it('renders nothing on the 404 the API returns while the flag is false', async () => {
    const fetchImpl = vi.fn(async () => failed(404)) as unknown as typeof fetch
    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)

    expect(fetchImpl).toHaveBeenCalled()
    expect(mounted.innerHTML).toBe('')
  })

  /** A section that cannot save is worse than one that is not there. */
  it('renders nothing when the request fails outright', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)

    expect(mounted.innerHTML).toBe('')
  })
})

describe('when the feature is on', () => {
  it('offers every segment, each with its description tied to its own control', async () => {
    const fetchImpl = vi.fn(async () => okJson(preferences())) as unknown as typeof fetch
    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)

    expect(radios(mounted)).toHaveLength(USER_SEGMENTS.length)
    expect(mounted.querySelector('legend')?.textContent).toMatch(/primary goal/i)

    for (const segment of USER_SEGMENTS) {
      const radio = radioFor(mounted, segment)
      // Announced with the option rather than after all four — otherwise the choice is made
      // without the sentence that distinguishes the options.
      const describedBy = radio.getAttribute('aria-describedby')
      expect(describedBy).toBeTruthy()
      expect(mounted.querySelector(`#${describedBy}`)?.textContent).toBe(USER_SEGMENT_COPY[segment].description)
    }
  })

  /** One `name` is what makes a radio group a group, and arrow-key navigation work at all. */
  it('puts every radio in one named group', async () => {
    const fetchImpl = vi.fn(async () => okJson(preferences())) as unknown as typeof fetch
    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)

    expect(new Set(radios(mounted).map((input) => input.name))).toEqual(new Set(['primary-segment']))
    expect(mounted.querySelector('fieldset')).not.toBeNull()
  })

  it('shows the stored choice as the checked control', async () => {
    const fetchImpl = vi.fn(async () => okJson(preferences({ primarySegment: 'investing' }))) as unknown as typeof fetch
    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)

    expect(radioFor(mounted, 'investing').checked).toBe(true)
    expect(radioFor(mounted, 'hiring').checked).toBe(false)
  })

  it('states that the choice changes suggestions and not access', async () => {
    const fetchImpl = vi.fn(async () => okJson(preferences())) as unknown as typeof fetch
    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)

    expect(mounted.textContent).toMatch(/does not change your permissions/i)
    expect(mounted.textContent).toMatch(/never deletes your searches/i)
  })

  it('saves the selection as coming from settings, and confirms it', async () => {
    const bodies: string[] = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        bodies.push(String(init.body))
        return okJson(preferences({ primarySegment: 'hiring', source: 'settings' }))
      }
      return okJson(preferences())
    }) as unknown as typeof fetch

    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)
    await act(async () => {
      radioFor(mounted, 'hiring').click()
    })

    expect(JSON.parse(bodies[0])).toEqual({ primarySegment: 'hiring', source: 'settings' })
    expect(mounted.querySelector('[role="status"]')?.textContent).toMatch(/saved/i)
  })

  /** Clearing is a real choice; without a control there is no way back to the general experience. */
  it('offers a way to clear a selection, and sends an explicit null', async () => {
    const bodies: string[] = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        bodies.push(String(init.body))
        return okJson(preferences({ primarySegment: null }))
      }
      return okJson(preferences({ primarySegment: 'building' }))
    }) as unknown as typeof fetch

    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)
    const clear = [...mounted.querySelectorAll('button')].find((b) => /clear my selection/i.test(b.textContent ?? ''))
    expect(clear).toBeTruthy()
    await act(async () => {
      clear!.click()
    })

    expect(JSON.parse(bodies[0]).primarySegment).toBeNull()
  })

  it('hides the clear control when there is nothing to clear', async () => {
    const fetchImpl = vi.fn(async () => okJson(preferences({ primarySegment: null }))) as unknown as typeof fetch
    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)

    const clear = [...mounted.querySelectorAll('button')].find((b) => /clear my selection/i.test(b.textContent ?? ''))
    expect(clear).toBeUndefined()
  })

  it('reports a failed save instead of pretending it worked', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH' ? failed(500) : okJson(preferences()),
    ) as unknown as typeof fetch

    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)
    await act(async () => {
      radioFor(mounted, 'building').click()
    })

    expect(mounted.querySelector('[role="status"]')?.textContent).toMatch(/did not save/i)
  })

  /** `aria-live` so the outcome is announced without stealing focus from the group. */
  it('announces the outcome politely', async () => {
    const fetchImpl = vi.fn(async () => okJson(preferences())) as unknown as typeof fetch
    const mounted = await mount(<UserSegmentSettings fetchImpl={fetchImpl} />)

    const status = mounted.querySelector('[role="status"]')
    expect(status?.getAttribute('aria-live')).toBe('polite')
  })
})
