import { describe, expect, it } from 'vitest'
import { isAllowedBuilderProfileUrl, normalizeSafeRedirect, validateExternalHttpUrl } from '~/shared/lib/security/url-policy'

describe('URL security policy', () => {
  it.each(['http://127.0.0.1/a', 'http://169.254.169.254/latest', 'http://[::1]/', 'file:///etc/passwd'])('rejects private or non-http destination %s', async (url) => {
    await expect(validateExternalHttpUrl(url, { lookup: async () => ['127.0.0.1'] })).rejects.toThrow()
  })

  it('rejects public-looking hostnames that resolve to private addresses', async () => {
    await expect(validateExternalHttpUrl('https://public.example/a', {
      lookup: async () => ['10.0.0.5'],
    })).rejects.toThrow('private network')
  })

  it('accepts an allowed HTTPS host resolving publicly', async () => {
    await expect(validateExternalHttpUrl('https://api.github.com/users/a', {
      allowedHosts: ['api.github.com'],
      lookup: async () => ['140.82.121.6'],
    })).resolves.toMatchObject({ hostname: 'api.github.com' })
  })

  it('normalizes redirects to same-origin paths only', () => {
    expect(normalizeSafeRedirect('/dashboard?tab=a', 'https://builderhunt.example')).toBe('/dashboard?tab=a')
    expect(normalizeSafeRedirect('https://evil.example', 'https://builderhunt.example')).toBe('/')
    expect(normalizeSafeRedirect('//evil.example/path', 'https://builderhunt.example')).toBe('/')
  })

  it('binds stored builder profile links to the declared provider', () => {
    expect(isAllowedBuilderProfileUrl('github', 'https://github.com/alice')).toBe(true)
    expect(isAllowedBuilderProfileUrl('github', 'javascript:alert(1)')).toBe(false)
    expect(isAllowedBuilderProfileUrl('github', 'https://evil.example/alice')).toBe(false)
  })
})
