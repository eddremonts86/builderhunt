/**
 * `z.string().url()` is not a safety check, and this file exists because that difference reached the public
 * candidate portal: `scheduling_invitations.meeting_url` was validated with it and rendered as an `<a href>`
 * on a signed-out page a candidate opens from an emailed capability link.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { httpUrlSchema, isSafeHttpUrl, safeHttpHref } from '~/shared/lib/url-safety'

describe('what z.string().url() actually accepts', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
  ])('accepts %s, which is why this module exists', (value) => {
    // Measured, not assumed. The whole premise of `httpUrlSchema` is that this assertion passes.
    expect(z.string().url().safeParse(value).success).toBe(true)
  })
})

describe('isSafeHttpUrl', () => {
  it.each([
    'https://meet.google.com/abc-defg-hij',
    'http://localhost:3000/room',
    'https://example.test/path?query=1#frag',
  ])('accepts %s', (value) => {
    expect(isSafeHttpUrl(value)).toBe(true)
  })

  const dangerous = [
    ['a javascript scheme', 'javascript:alert(1)'],
    ['an uppercase javascript scheme', 'JavaScript:alert(1)'],
    ['a javascript scheme with whitespace', ' javascript:alert(1)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['a vbscript scheme', 'vbscript:msgbox(1)'],
    ['a blob URL', 'blob:https://app.test/1234'],
    ['a file URL', 'file:///etc/passwd'],
    ['a filesystem URL', 'filesystem:https://app.test/temporary/x'],
  ] as const

  it.each(dangerous)('refuses %s', (_label, value) => {
    // An allowlist, not a denylist: a denylist has to anticipate every scheme a future browser adds.
    expect(isSafeHttpUrl(value)).toBe(false)
  })

  it('refuses a relative URL', () => {
    // Every caller stores an externally-supplied absolute link. A relative one would silently point at our
    // own application, which is not what "join the call" means.
    expect(isSafeHttpUrl('/dashboard')).toBe(false)
    expect(isSafeHttpUrl('meet.google.com/abc')).toBe(false)
  })

  it('refuses empty and absent values', () => {
    expect(isSafeHttpUrl('')).toBe(false)
    expect(isSafeHttpUrl(null)).toBe(false)
    expect(isSafeHttpUrl(undefined)).toBe(false)
  })
})

describe('safeHttpHref', () => {
  it('returns the URL when it is safe', () => {
    expect(safeHttpHref('https://meet.example/x')).toBe('https://meet.example/x')
  })

  it('returns null rather than a sanitized string', () => {
    // Null, not `'#'` or `'about:blank'`: the caller must decide whether to render text instead, and a
    // placeholder href would still be a link the candidate could click expecting a meeting.
    expect(safeHttpHref('javascript:alert(1)')).toBeNull()
    expect(safeHttpHref(null)).toBeNull()
  })
})

describe('httpUrlSchema', () => {
  it('accepts an ordinary meeting link', () => {
    expect(httpUrlSchema.safeParse('https://zoom.us/j/123456').success).toBe(true)
  })

  it('refuses what z.string().url() would have let through', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      const result = httpUrlSchema.safeParse(value)
      expect(result.success, value).toBe(false)
    }
  })

  it('names the constraint in its message, so an operator can act on it', () => {
    const result = httpUrlSchema.safeParse('javascript:alert(1)')
    expect(result.success ? '' : result.error.issues[0].message).toMatch(/http or https/)
  })
})
