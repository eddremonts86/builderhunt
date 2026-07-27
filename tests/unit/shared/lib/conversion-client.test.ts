import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { getConversionSessionId, hasAnalyticsConsent, trackConversionEvent } from '~/shared/lib/conversion-client'

// This project's vitest/happy-dom setup does not provide `window.localStorage`
// (only `sessionStorage`) — the module under test already guards every real
// access in a try/catch and fails closed, but the tests themselves need a
// working store to set up fixtures against. Minimal in-memory polyfill.
class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() { return this.store.size }
  clear() { this.store.clear() }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null }
  removeItem(key: string) { this.store.delete(key) }
  setItem(key: string, value: string) { this.store.set(key, value) }
}

beforeAll(() => {
  if (!window.localStorage) {
    Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
  }
})

function setConsent(analytics: boolean) {
  window.localStorage.setItem('bh_cookie_consent', JSON.stringify({
    essential: true, functional: true, analytics, decidedAt: new Date().toISOString(),
  }))
}

describe('hasAnalyticsConsent', () => {
  afterEach(() => window.localStorage.clear())

  it('is false with no stored consent', () => {
    expect(hasAnalyticsConsent()).toBe(false)
  })

  it('is false when analytics was declined', () => {
    setConsent(false)
    expect(hasAnalyticsConsent()).toBe(false)
  })

  it('is true when analytics was accepted', () => {
    setConsent(true)
    expect(hasAnalyticsConsent()).toBe(true)
  })

  it('is false on malformed stored JSON', () => {
    window.localStorage.setItem('bh_cookie_consent', 'not json')
    expect(hasAnalyticsConsent()).toBe(false)
  })
})

describe('getConversionSessionId', () => {
  afterEach(() => window.sessionStorage.clear())

  it('returns a stable id across calls', () => {
    const a = getConversionSessionId()
    const b = getConversionSessionId()
    expect(a).toBe(b)
  })
})

describe('trackConversionEvent', () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not call fetch when analytics consent is absent', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    trackConversionEvent('landing_view', 'hero')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POSTs a valid event when consent is present', () => {
    setConsent(true)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    trackConversionEvent('landing_view', 'hero')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/analytics/conversion')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ name: 'landing_view', surface: 'hero', variant: expect.any(String) })
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('does not send the same (name, surface, variant) twice in one page load', () => {
    setConsent(true)
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    trackConversionEvent('hero_signup_click', 'hero')
    trackConversionEvent('hero_signup_click', 'hero')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('swallows a fetch rejection without throwing', async () => {
    setConsent(true)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    expect(() => trackConversionEvent('landing_view', 'hero')).not.toThrow()
  })
})
