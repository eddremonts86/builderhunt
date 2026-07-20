import { createHmac, timingSafeEqual } from 'node:crypto'

interface FeedCapability {
  organizationId: string
  searchId: string
}

export function createFeedCapability(organizationId: string, searchId: string, secret: string) {
  const payload = Buffer.from(JSON.stringify({ organizationId, searchId })).toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

export function verifyFeedCapability(token: string, expectedSearchId: string, secret: string): FeedCapability | null {
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra) return null
  const expected = Buffer.from(sign(payload, secret), 'base64url')
  const actual = Buffer.from(signature, 'base64url')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    if (
      typeof decoded.organizationId !== 'string'
      || typeof decoded.searchId !== 'string'
      || decoded.searchId !== expectedSearchId
    ) return null
    return { organizationId: decoded.organizationId, searchId: decoded.searchId }
  } catch {
    return null
  }
}

function sign(payload: string, secret: string) {
  return createHmac('sha256', secret).update(`builderhunt:feed:v1:${payload}`).digest('base64url')
}
