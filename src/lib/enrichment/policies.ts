/**
 * Public Profile Enrichment — compile-time source policy register.
 *
 * Spec reference: plans/phase-1/42-stealth-scraping/spec.md §4
 * Source register (owner/permission/lawful-basis detail): docs/operations/public-enrichment-source-register.md
 *
 * Rule: a connector with no entry here is disabled. Runtime allowlisting
 * (`ENRICHMENT_ALLOWED_CONNECTORS`) can only narrow this list — it can never
 * enable a connector that is `blocked` or missing here.
 */

import type { SourcePolicy } from './types'

const ALL_FIELDS: SourcePolicy['allowedFields'] = [
  'profileUrl',
  'username',
  'displayName',
  'headline',
  'organization',
  'role',
  'location',
  'bio',
  'topics',
  'recentActivitySummary',
]

/** Connectors that must never become executable, regardless of env/config. */
export const HARD_BLOCKED_CONNECTOR_IDS = ['linkedin', 'x', 'facebook', 'instagram'] as const

export const SOURCE_POLICIES: Readonly<Record<string, SourcePolicy>> = Object.freeze({
  github: {
    id: 'github',
    acquisitionMode: 'official_api',
    status: 'enabled',
    permissionReference: 'GitHub REST API terms — public read scope, existing token',
    lawfulBasisReference: 'docs/operations/public-enrichment-source-register.md#github',
    reviewExpiresAt: '2027-07-20',
    allowedHosts: ['github.com', 'api.github.com'],
    allowedFields: ALL_FIELDS,
    robotsRequired: false,
    maxRequestsPerMinute: 20,
    rawRetentionDays: 30,
    acceptedRetentionDays: 180,
  },
  'user-submitted': {
    id: 'user-submitted',
    acquisitionMode: 'user_submitted',
    status: 'enabled',
    permissionReference: 'Submitted directly by the organization member or verified profile owner',
    lawfulBasisReference: 'docs/operations/public-enrichment-source-register.md#user-submitted',
    reviewExpiresAt: '2027-07-20',
    // No fetch happens for this connector; hosts are validated per-URL against
    // every other connector's policy before any network call is made.
    allowedHosts: [],
    allowedFields: ALL_FIELDS,
    robotsRequired: false,
    maxRequestsPerMinute: 0,
    rawRetentionDays: 30,
    acceptedRetentionDays: 180,
  },
  linkedin: {
    id: 'linkedin',
    acquisitionMode: 'official_api',
    status: 'blocked',
    permissionReference: 'https://www.linkedin.com/legal/crawling-terms — no permission on file',
    lawfulBasisReference: 'none — blocked',
    reviewExpiresAt: '1970-01-01',
    allowedHosts: [],
    allowedFields: [],
    robotsRequired: true,
    maxRequestsPerMinute: 0,
    rawRetentionDays: 0,
    acceptedRetentionDays: 0,
  },
  x: {
    id: 'x',
    acquisitionMode: 'official_api',
    status: 'blocked',
    permissionReference: 'https://x.com/en/tos — no written consent on file',
    lawfulBasisReference: 'none — blocked',
    reviewExpiresAt: '1970-01-01',
    allowedHosts: [],
    allowedFields: [],
    robotsRequired: true,
    maxRequestsPerMinute: 0,
    rawRetentionDays: 0,
    acceptedRetentionDays: 0,
  },
  facebook: {
    id: 'facebook',
    acquisitionMode: 'official_api',
    status: 'blocked',
    permissionReference: 'https://www.facebook.com/legal/automated_data_collection_terms — no permission on file',
    lawfulBasisReference: 'none — blocked',
    reviewExpiresAt: '1970-01-01',
    allowedHosts: [],
    allowedFields: [],
    robotsRequired: true,
    maxRequestsPerMinute: 0,
    rawRetentionDays: 0,
    acceptedRetentionDays: 0,
  },
  instagram: {
    id: 'instagram',
    acquisitionMode: 'official_api',
    status: 'blocked',
    permissionReference: 'https://www.facebook.com/legal/automated_data_collection_terms — no permission on file',
    lawfulBasisReference: 'none — blocked',
    reviewExpiresAt: '1970-01-01',
    allowedHosts: [],
    allowedFields: [],
    robotsRequired: true,
    maxRequestsPerMinute: 0,
    rawRetentionDays: 0,
    acceptedRetentionDays: 0,
  },
})

export function getSourcePolicy(connectorId: string): SourcePolicy | null {
  return SOURCE_POLICIES[connectorId] ?? null
}

function isPolicyExecutable(policy: SourcePolicy | null, now: Date): policy is SourcePolicy {
  if (!policy) return false
  if (policy.status !== 'enabled') return false
  if ((HARD_BLOCKED_CONNECTOR_IDS as readonly string[]).includes(policy.id)) return false
  if (!policy.lawfulBasisReference || !policy.reviewExpiresAt) return false
  if (new Date(policy.reviewExpiresAt).getTime() <= now.getTime()) return false
  return true
}

/**
 * Narrows the compile-time enabled connector set with a runtime allowlist
 * (typically `ENRICHMENT_ALLOWED_CONNECTORS`, a comma-separated string).
 * Never returns a connector that isn't `enabled` at compile time, no matter
 * what the allowlist string contains — this is the fail-closed guarantee
 * tested in policies.test.ts.
 */
export function resolveExecutableConnectorIds(
  allowlistEnv: string | undefined,
  now: Date = new Date(),
): string[] {
  const requested = (allowlistEnv ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)

  const compileTimeEnabled = Object.values(SOURCE_POLICIES)
    .filter((policy) => isPolicyExecutable(policy, now))
    .map((policy) => policy.id)

  if (requested.length === 0) return []

  const unique = Array.from(new Set(requested))
  return unique.filter((id) => compileTimeEnabled.includes(id))
}
