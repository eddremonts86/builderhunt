const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  'upgrade-insecure-requests',
].join('; ')

export function applySecurityHeaders(
  headers: Headers,
  options: { production: boolean; secure: boolean },
): Headers {
  headers.set('Content-Security-Policy', contentSecurityPolicy)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  if (options.production && options.secure) {
    headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  return headers
}

export function isTrustedMutationOrigin(request: Request, trustedOrigin: string): boolean {
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return true
  if (!request.headers.has('cookie')) return true

  const origin = request.headers.get('origin')
  if (!origin) return false

  try {
    return new URL(origin).origin === new URL(trustedOrigin).origin
  } catch {
    return false
  }
}
