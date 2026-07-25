import type { ClaimSourceAdapter } from './types'
import { githubClaimAdapter } from './github'
import { gitlabClaimAdapter } from './gitlab'
import { codebergClaimAdapter } from './codeberg'
import { devtoClaimAdapter } from './devto'

export type { ClaimProofResult, ClaimProofFailureReason, ClaimSourceAdapter } from './types'

/**
 * Only sources with a public, fetchable "bio"-shaped field support challenge
 * verification. Aggregator sources with no per-user profile page a claimant
 * could edit (HN, Reddit, npm, Hugging Face, Stack Overflow, Lobsters,
 * SourceHut, Product Hunt, Bluesky) are deliberately absent — claiming a
 * builder from one of those sources returns `unsupported` rather than a
 * false sense of proof.
 */
const CLAIM_SOURCE_ADAPTERS: Partial<Record<string, ClaimSourceAdapter>> = {
  github: githubClaimAdapter,
  gitlab: gitlabClaimAdapter,
  codeberg: codebergClaimAdapter,
  devto: devtoClaimAdapter,
}

export function getClaimSourceAdapter(source: string): ClaimSourceAdapter | null {
  return CLAIM_SOURCE_ADAPTERS[source] ?? null
}

export function isClaimSourceSupported(source: string): boolean {
  return source in CLAIM_SOURCE_ADAPTERS
}
