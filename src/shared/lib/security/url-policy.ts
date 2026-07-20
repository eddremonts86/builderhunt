import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface ExternalUrlPolicy {
  allowedHosts?: string[]
  lookup?: (hostname: string) => Promise<string[]>
}

export async function validateExternalHttpUrl(input: string, policy: ExternalUrlPolicy = {}) {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new Error('Invalid external URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('External URL must use HTTP or HTTPS')
  if (url.username || url.password) throw new Error('External URL credentials are forbidden')
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('External URL cannot target a private network')
  }
  if (policy.allowedHosts && !policy.allowedHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))) {
    throw new Error('External URL host is not allowlisted')
  }

  const addresses = isIP(hostname)
    ? [hostname]
    : await (policy.lookup ?? defaultLookup)(hostname)
  if (addresses.length === 0) throw new Error('External URL host did not resolve')
  if (addresses.some(isPrivateAddress)) throw new Error('External URL cannot target a private network')
  return url
}

export function normalizeSafeRedirect(target: string | null | undefined, trustedOrigin: string) {
  if (!target) return '/'
  try {
    const trusted = new URL(trustedOrigin)
    const candidate = new URL(target, trusted)
    if (candidate.origin !== trusted.origin || !target.startsWith('/') || target.startsWith('//')) return '/'
    return `${candidate.pathname}${candidate.search}${candidate.hash}`
  } catch {
    return '/'
  }
}

const builderProfileHosts: Record<string, string[]> = {
  github: ['github.com'],
  reddit: ['reddit.com'],
  hn: ['news.ycombinator.com'],
  devto: ['dev.to'],
  lobsters: ['lobste.rs'],
  stackoverflow: ['stackoverflow.com'],
  npm: ['npmjs.com'],
  huggingface: ['huggingface.co'],
  gitlab: ['gitlab.com'],
  codeberg: ['codeberg.org'],
  hashnode: ['hashnode.com'],
  sourcehut: ['sr.ht'],
}

export function isAllowedBuilderProfileUrl(source: string, input: string) {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password) return false
    const hostname = url.hostname.toLowerCase()
    return (builderProfileHosts[source] ?? [])
      .some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`))
  } catch {
    return false
  }
}

async function defaultLookup(hostname: string) {
  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  return results.map((result) => result.address)
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase()
    if (normalized === '::' || normalized === '::1') return true
    if (/^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized)) return true
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
    return mapped ? isPrivateAddress(mapped) : false
  }
  return true
}
