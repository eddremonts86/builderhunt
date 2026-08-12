/**
 * Public Profile Enrichment — deterministic entity resolution.
 * Spec reference: plans/implemented/42-stealth-scraping/spec.md §9. Pure, versioned, no LLM.
 */

import type { EnrichmentEvidencePayload, EnrichmentResolution, EnrichmentTarget } from './types'
import { normalizeFullName, normalizeLocation, normalizeOrganization, normalizeTopic, normalizeUsername } from './normalize'

export const RESOLVER_VERSION = 1

export interface ResolverInput {
  target: EnrichmentTarget
  candidate: EnrichmentEvidencePayload
  candidateSourceRecordId?: string | null
  knownTopics?: string[]
  isVerifiedOwnerSubmitted?: boolean
  hasReciprocalLink?: boolean
  /** A different source reports a conflicting stable ID for the same identity. */
  contradictsStableId?: boolean
  /** The verified profile owner rejected this candidate as not them. */
  verifiedOwnerRejected?: boolean
  /**
   * An organization member pasted this URL in themselves — the `user-submitted` acquisition mode,
   * where nothing was fetched and there is nothing to match against.
   *
   * Such a candidate scores 0 bps, because there is genuinely no evidence that it is the same person;
   * that is honest and stays. But 0 bps mapped to `rejected`, and the tenant read only returns
   * `accepted`/`review` — so a link a recruiter typed was written to the database, never shown to
   * them, and deleted seven days later. The feature did nothing. This floors the *resolution* at
   * `review` without inventing confidence: an attributed link awaiting a human's confirmation, which
   * is exactly what it is. Found 2026-08-05 by the runtime adversarial matrix, case 02.
   *
   * No `RESOLVER_VERSION` bump: the input defaults false, so every previously-scored candidate
   * resolves bit-identically. A forced reject (conflicting stable id, owner rejection) still wins.
   */
  isOperatorSubmitted?: boolean
}

export interface ResolverOutput {
  resolution: EnrichmentResolution
  confidenceBps: number
  scoreComponents: Record<string, number>
  matchSignals: string[]
  contradictions: string[]
  resolverVersion: number
}

const MAX_BPS = 10000
const ACCEPT_THRESHOLD = 9000
const REVIEW_THRESHOLD = 7000
const NAME_ORG_MISMATCH_CAP = 6900

export function resolveEnrichmentCandidate(input: ResolverInput): ResolverOutput {
  const scoreComponents: Record<string, number> = {}
  const matchSignals: string[] = []
  const contradictions: string[] = []

  if (input.isVerifiedOwnerSubmitted) {
    scoreComponents.verified_owner_cross_link = 10000
    matchSignals.push('verified_owner_cross_link')
  }

  const candidateStableId = input.candidateSourceRecordId?.trim()
  if (candidateStableId && candidateStableId === input.target.sourceId) {
    scoreComponents.exact_stable_source_id = 10000
    matchSignals.push('exact_stable_source_id')
  }

  const candidateUsername = normalizeUsername(input.candidate.username)
  const targetUsername = normalizeUsername(input.target.username)
  if (candidateUsername && targetUsername && candidateUsername === targetUsername) {
    if (input.hasReciprocalLink) {
      scoreComponents.exact_username_reciprocal_link = 9500
      matchSignals.push('exact_username_reciprocal_link')
    } else {
      scoreComponents.exact_username = 4000
      matchSignals.push('exact_username')
    }
  }

  const candidateName = normalizeFullName(input.candidate.displayName)
  const targetName = normalizeFullName(input.target.displayName)
  const namesAgree = Boolean(candidateName && targetName && candidateName === targetName)
  if (namesAgree) {
    scoreComponents.exact_full_name = 2500
    matchSignals.push('exact_full_name')
  }

  const candidateOrg = normalizeOrganization(input.candidate.organization)
  const targetOrg = normalizeOrganization(input.target.knownOrganization)
  const orgsAgree = Boolean(candidateOrg && targetOrg && candidateOrg === targetOrg)
  if (orgsAgree) {
    scoreComponents.organization_agreement = 2000
    matchSignals.push('organization_agreement')
  }

  const candidateLocation = normalizeLocation(input.candidate.location)
  const targetLocation = normalizeLocation(input.target.knownLocation)
  if (candidateLocation && targetLocation && candidateLocation === targetLocation) {
    scoreComponents.location_agreement = 1000
    matchSignals.push('location_agreement')
  }

  const knownTopics = new Set((input.knownTopics ?? []).map(normalizeTopic).filter(Boolean))
  const candidateTopics = (input.candidate.topics ?? []).map(normalizeTopic).filter(Boolean)
  if (knownTopics.size > 0 && candidateTopics.length > 0) {
    const overlap = candidateTopics.filter((topic) => knownTopics.has(topic)).length
    const ratio = overlap / Math.max(knownTopics.size, candidateTopics.length)
    const points = Math.round(ratio * 1000)
    if (points > 0) {
      scoreComponents.topic_overlap = points
      matchSignals.push('topic_overlap')
    }
  }

  let totalBps = Math.min(MAX_BPS, Object.values(scoreComponents).reduce((sum, value) => sum + value, 0))

  const candidateNamePresent = Boolean(candidateName)
  const targetNamePresent = Boolean(targetName)
  const candidateOrgPresent = Boolean(candidateOrg)
  const targetOrgPresent = Boolean(targetOrg)
  const materiallyDifferentName = candidateNamePresent && targetNamePresent && !namesAgree
  const materiallyDifferentOrg = candidateOrgPresent && targetOrgPresent && !orgsAgree
  if (materiallyDifferentName && materiallyDifferentOrg) {
    contradictions.push('name_and_organization_mismatch')
    totalBps = Math.min(totalBps, NAME_ORG_MISMATCH_CAP)
  }

  let forcedReject = false
  if (input.contradictsStableId) {
    contradictions.push('conflicting_stable_source_id')
    forcedReject = true
  }
  if (input.verifiedOwnerRejected) {
    contradictions.push('verified_owner_rejected')
    forcedReject = true
  }

  let resolution: EnrichmentResolution
  if (forcedReject) {
    resolution = 'rejected'
  } else if (input.isOperatorSubmitted && totalBps < REVIEW_THRESHOLD) {
    // See `isOperatorSubmitted`: a pasted link is worth a human's decision, not a silent discard. It
    // keeps its real (usually zero) confidence — only where it lands changes.
    resolution = 'review'
  } else if (totalBps >= ACCEPT_THRESHOLD && (matchSignals.length >= 2 || input.isVerifiedOwnerSubmitted)) {
    // spec §9/§5.3: a verified-owner-submitted URL "may be accepted
    // automatically" even as the sole signal — every other single signal
    // still requires a second independent one to auto-accept.
    resolution = 'accepted'
  } else if (totalBps >= REVIEW_THRESHOLD) {
    resolution = 'review'
  } else {
    resolution = 'rejected'
  }

  return {
    resolution,
    confidenceBps: totalBps,
    scoreComponents,
    matchSignals,
    contradictions,
    resolverVersion: RESOLVER_VERSION,
  }
}
