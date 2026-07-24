import { describe, expect, it } from 'vitest'
import { computeDeviceHash, detectUaFamily, issueDeviceCookieValue } from './device'

describe('issueDeviceCookieValue', () => {
  it('returns a unique value on every call', () => {
    const a = issueDeviceCookieValue()
    const b = issueDeviceCookieValue()
    expect(a).not.toEqual(b)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
  })
})

describe('detectUaFamily', () => {
  it('buckets Chrome desktop', () => {
    expect(detectUaFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36')).toBe('chrome')
  })

  it('buckets Chrome on iOS as chrome, not safari', () => {
    expect(detectUaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1')).toBe('chrome')
  })

  it('buckets Firefox on iOS as firefox, not safari', () => {
    expect(detectUaFamily('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/120.0 Mobile/15E148 Safari/605.1.15')).toBe('firefox')
  })

  it('buckets Edge as edge, not chrome', () => {
    expect(detectUaFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0')).toBe('edge')
  })

  it('buckets genuine Safari', () => {
    expect(detectUaFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe('safari')
  })

  it('buckets Firefox desktop', () => {
    expect(detectUaFamily('Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0')).toBe('firefox')
  })

  it('returns unknown for missing user agent', () => {
    expect(detectUaFamily(null)).toBe('unknown')
    expect(detectUaFamily(undefined)).toBe('unknown')
  })

  it('returns other for an unrecognized user agent', () => {
    expect(detectUaFamily('curl/8.0.0')).toBe('other')
  })
})

describe('computeDeviceHash', () => {
  it('is stable for the same inputs', () => {
    const a = computeDeviceHash('cookie-1', 'chrome', 'salt-1')
    const b = computeDeviceHash('cookie-1', 'chrome', 'salt-1')
    expect(a).toEqual(b)
  })

  it('differs when the cookie value differs', () => {
    const a = computeDeviceHash('cookie-1', 'chrome', 'salt-1')
    const b = computeDeviceHash('cookie-2', 'chrome', 'salt-1')
    expect(a).not.toEqual(b)
  })

  it('differs when the UA family differs', () => {
    const a = computeDeviceHash('cookie-1', 'chrome', 'salt-1')
    const b = computeDeviceHash('cookie-1', 'firefox', 'salt-1')
    expect(a).not.toEqual(b)
  })

  it('differs when the salt differs', () => {
    const a = computeDeviceHash('cookie-1', 'chrome', 'salt-1')
    const b = computeDeviceHash('cookie-1', 'chrome', 'salt-2')
    expect(a).not.toEqual(b)
  })

  it('never leaks the raw cookie value in the hash', () => {
    const hash = computeDeviceHash('super-secret-cookie-value', 'chrome', 'salt-1')
    expect(hash).not.toContain('super-secret-cookie-value')
  })
})
