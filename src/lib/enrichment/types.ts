/**
 * Public Profile Enrichment — shared contracts.
 *
 * Spec reference: plans/phase-1/41-stealth-scraping/spec.md §§4, 7, 8
 *
 * This module has no I/O. It only defines the compile-time shapes that the
 * rest of the enrichment pipeline (policies, resolver, network client,
 * connectors, worker, routes) share.
 */

export type AcquisitionMode = 'official_api' | 'authorized_crawl' | 'user_submitted'

export type SourcePolicyStatus = 'enabled' | 'blocked' | 'approval_required'

/** Fields a connector is allowed to write into `EnrichmentEvidencePayload`. */
export type EnrichmentField =
  | 'profileUrl'
  | 'username'
  | 'displayName'
  | 'headline'
  | 'organization'
  | 'role'
  | 'location'
  | 'bio'
  | 'topics'
  | 'recentActivitySummary'

export interface SourcePolicy {
  id: string
  acquisitionMode: AcquisitionMode
  status: SourcePolicyStatus
  /** Free-text reference to the written permission / API terms on file. */
  permissionReference: string
  /** Free-text reference to the lawful-basis / LIA record on file. */
  lawfulBasisReference: string
  /** ISO date. An expired or missing value fails closed in production. */
  reviewExpiresAt: string
  allowedHosts: readonly string[]
  allowedFields: readonly EnrichmentField[]
  robotsRequired: boolean
  maxRequestsPerMinute: number
  rawRetentionDays: number
  acceptedRetentionDays: number
}

export interface EnrichmentEvidencePayload {
  profileUrl: string
  username?: string
  displayName?: string
  headline?: string
  organization?: string
  role?: string
  location?: string
  bio?: string
  topics: string[]
  recentActivitySummary?: string
}

export interface EnrichmentCandidate {
  connector: string
  acquisitionMode: AcquisitionMode
  sourceUrl: string
  sourceRecordId?: string
  payload: EnrichmentEvidencePayload
  observedAt: Date
}

export interface EnrichmentTarget {
  builderIdentityId: string
  source: string
  sourceId: string
  username: string
  displayName?: string | null
  profileUrl: string
  knownOrganization?: string | null
  knownLocation?: string | null
  submittedUrls: string[]
}

export type ConnectorResult =
  | { kind: 'evidence'; candidates: EnrichmentCandidate[] }
  | { kind: 'no_data' | 'unsupported' | 'blocked' }
  | { kind: 'retry'; code: 'rate_limited' | 'upstream_unavailable'; retryAt: Date }
  | { kind: 'stop'; code: 'auth_required' | 'robots_denied' | 'challenge_detected' | 'policy_denied' }

export interface EnrichmentConnector {
  id: string
  policy: SourcePolicy
  supports(target: EnrichmentTarget): boolean
  collect(target: EnrichmentTarget, signal: AbortSignal): Promise<ConnectorResult>
}

/** Resolver decision on a single candidate. Spec §9. */
export type EnrichmentResolution = 'accepted' | 'review' | 'rejected'
