/**
 * Public Profile Enrichment — robots.txt cache + evaluation.
 * Spec reference: plans/phase-1/42-stealth-scraping/spec.md §8, §14. Only
 * `authorized_crawl` connectors are required to honor this (spec §4); a
 * fetch or parse failure fails closed (denies) for that mode.
 */

import { ENRICHMENT_DEFAULT_USER_AGENT, safeFetch } from './network'

interface RobotsRule {
  userAgentPrefix: string
  disallow: string[]
  allow: string[]
}

interface CacheEntry {
  rules: RobotsRule[]
  fetchedAt: number
}

const CACHE_TTL_MS = 60 * 60 * 1000
const cache = new Map<string, CacheEntry>()

export type RobotsDecision = 'allowed' | 'disallowed' | 'unavailable'

export async function isPathAllowedByRobots(
  origin: string,
  path: string,
  userAgent: string = ENRICHMENT_DEFAULT_USER_AGENT,
): Promise<RobotsDecision> {
  try {
    const rules = await loadRobots(origin)
    if (!rules) return 'unavailable'
    return evaluate(rules, path, userAgent) ? 'allowed' : 'disallowed'
  } catch {
    return 'unavailable'
  }
}

async function loadRobots(origin: string): Promise<RobotsRule[] | null> {
  const host = new URL(origin).hostname
  const cached = cache.get(host)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.rules

  const robotsUrl = new URL('/robots.txt', origin).toString()
  const result = await safeFetch(robotsUrl, { allowedHosts: [host] })
  const rules = parseRobotsTxt(result.body)
  cache.set(host, { rules, fetchedAt: Date.now() })
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
