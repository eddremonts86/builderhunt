/**
 * Public Profile Enrichment — robots.txt cache + evaluation.
 * Spec reference: plans/phase-1/42-stealth-scraping/spec.md §8, §14. Only
 * `authorized_crawl` connectors are required to honor this (spec §4); a
 * fetch or parse failure fails closed (denies) for that mode.
 */

import { ENRICHMENT_DEFAULT_USER_AGENT, SafeFetchError, safeFetch } from './network'

interface RobotsRule {
  userAgentPrefix: string
  disallow: string[]
  allow: string[]
}

interface CacheEntry {
  rules: RobotsRule[]
  /** The site answered 4xx: there is no robots.txt, which per RFC 9309 permits everything. */
  absent: boolean
  fetchedAt: number
}

const CACHE_TTL_MS = 60 * 60 * 1000
const cache = new Map<string, CacheEntry>()

/**
 * `unavailable` used to mean two different things, and the difference matters.
 *
 * RFC 9309 §2.3.1.3 is explicit: a 4xx on `/robots.txt` means the crawler **may access any resource**.
 * A site with no robots.txt has not failed to answer — it has answered "no restrictions". Collapsing that
 * into the same value as a timeout or a 5xx forced every caller to choose between refusing most of the
 * public web and ignoring genuine failures.
 *
 * So `no_robots_file` is its own outcome. A caller that wants to be conservative still refuses on
 * `unavailable`, which now means only what it says: we asked and could not get an answer.
 */
export type RobotsDecision = 'allowed' | 'disallowed' | 'no_robots_file' | 'unavailable'

export async function isPathAllowedByRobots(
  origin: string,
  path: string,
  userAgent: string = ENRICHMENT_DEFAULT_USER_AGENT,
): Promise<RobotsDecision> {
  try {
    const rules = await loadRobots(origin)
    if (rules === 'absent') return 'no_robots_file'
    if (!rules) return 'unavailable'
    return evaluate(rules, path, userAgent) ? 'allowed' : 'disallowed'
  } catch {
    return 'unavailable'
  }
}

/** `'absent'` means the site answered 4xx — per RFC 9309, that is permission, not a failure. */
async function loadRobots(origin: string): Promise<RobotsRule[] | 'absent' | null> {
  const host = new URL(origin).hostname
  const cached = cache.get(host)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.absent ? 'absent' : cached.rules

  const robotsUrl = new URL('/robots.txt', origin).toString()
  let result
  try {
    result = await safeFetch(robotsUrl, { allowedHosts: [host] })
  } catch (error) {
    // `safeFetch` throws `auth_required` for 401/403 and `upstream_error` for any other non-2xx, carrying the
    // status. A 4xx is the "no robots.txt" case; anything else is a real failure the caller must be told
    // about rather than have silently treated as permission.
    const status = error instanceof SafeFetchError ? error.status : undefined
    if (status !== undefined && status >= 400 && status < 500) {
      cache.set(host, { rules: [], absent: true, fetchedAt: Date.now() })
      return 'absent'
    }
    throw error
  }
  const rules = parseRobotsTxt(result.body)
  cache.set(host, { rules, absent: false, fetchedAt: Date.now() })
  return rules
}

export function parseRobotsTxt(text: string): RobotsRule[] {
  const rules: RobotsRule[] = []
  let current: RobotsRule | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const [rawKey, ...rest] = line.split(':')
    const key = rawKey.trim().toLowerCase()
    const value = rest.join(':').trim()
    if (key === 'user-agent') {
      current = { userAgentPrefix: value.toLowerCase(), disallow: [], allow: [] }
      rules.push(current)
      continue
    }
    if (!current) continue
    if (key === 'disallow' && value) current.disallow.push(value)
    if (key === 'allow' && value) current.allow.push(value)
  }
  return rules
}

function evaluate(rules: RobotsRule[], path: string, userAgent: string): boolean {
  const ua = userAgent.toLowerCase()
  const applicable = rules.filter((rule) => rule.userAgentPrefix === '*' || ua.includes(rule.userAgentPrefix))
  const specific = applicable.filter((rule) => rule.userAgentPrefix !== '*')
  const groups = specific.length > 0 ? specific : applicable

  let bestMatch: { type: 'allow' | 'disallow'; length: number } | null = null
  for (const group of groups) {
    for (const pattern of group.allow) {
      if (matchesRobotsPattern(path, pattern) && (!bestMatch || pattern.length > bestMatch.length)) {
        bestMatch = { type: 'allow', length: pattern.length }
      }
    }
    for (const pattern of group.disallow) {
      if (matchesRobotsPattern(path, pattern) && (!bestMatch || pattern.length > bestMatch.length)) {
        bestMatch = { type: 'disallow', length: pattern.length }
      }
    }
  }
  if (!bestMatch) return true
  return bestMatch.type === 'allow'
}

function matchesRobotsPattern(path: string, pattern: string): boolean {
  if (pattern === '') return false
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\$$/, '$$')
  return new RegExp(`^${escaped}`).test(path)
}
