/**
 * Decides whether a candidate-submitted URL may be fetched at all (plan:
 * calendar-scheduling-interview-intelligence, Phase 6, "Implement policy-controlled public-web
 * import"; spec.md "Candidate URLs are imported only when the source registry returns `official_api`
 * or `authorized_crawl`").
 *
 * ## Consent is not permission
 *
 * The one sentence this module exists to enforce: **"A candidate's consent does not override a
 * third-party platform's access terms."** A candidate can grant `public_web_import` and enthusiastically
 * attest that a LinkedIn profile is theirs, and the answer is still no — the terms being broken would
 * be LinkedIn's, and the candidate is not a party who can waive them. LinkedIn, X, Facebook and
 * Instagram stay URL-only evidence: stored, shown, never fetched.
 *
 * That is why an attestation is a *precondition* here and never a *justification*. It can promote a
 * candidate's own site from "unauthorized" to "authorized_crawl"; it cannot promote a hard-blocked
 * platform to anything.
 *
 * ## Why the decision is separate from the fetch
 *
 * The safety envelope in `~/lib/enrichment/network.ts` already refuses private addresses, non-HTTPS
 * schemes, redirects that escape, oversized bodies and so on. Those are properties of a *request*.
 * This module answers a question that comes earlier and cannot be recovered from the response:
 * whether we are permitted to make the request at all. A module that conflated the two would decide
 * permission by observing whether a fetch succeeded.
 *
 * ## Fails closed on every unknown
 *
 * An unrecognised host is `not_importable`, not "probably a personal site". Guessing means the
 * default for anything new is to fetch it, and the first time that is wrong it is a crawl someone
 * did not authorize.
 */
import { HARD_BLOCKED_CONNECTOR_IDS, SOURCE_POLICIES } from '~/lib/enrichment/policies'

/** Mirrors `candidate_links_policy_decision_check`. */
export type LinkPolicyDecision = 'official_api' | 'authorized_crawl' | 'user_submitted' | 'not_importable'

/** The version an attestation is recorded against, so a later change to the notice is detectable. */
export const LINK_AUTHORIZATION_NOTICE_VERSION = '2026-07-28.1'

export interface LinkPolicyInput {
  /** Normalized absolute URL, as stored in `candidate_links.normalized_url`. */
  normalizedUrl: string
  /**
   * Whether the candidate has positively attested, against the current notice version, that they own
   * or are authorized to submit this site for this disclosed import. Unticked by default — spec.md
   * requires a "separate, unticked, versioned consent", so an absent attestation is a `false`, never
   * an assumed yes.
   */
  attested: boolean
  /** The notice version the attestation was made against, if any. */
  attestedNoticeVersion?: string | null
}

export interface LinkPolicyResult {
  decision: LinkPolicyDecision
  /** Which source-registry entry decided this, or `null` when no entry matched. */
  connectorId: string | null
  /** Stable reason code, safe to show a candidate and to store. */
  reason:
    | 'official_api'
    | 'authorized_crawl'
    | 'platform_terms_forbid_import'
    | 'attestation_required'
    | 'attestation_notice_outdated'
    | 'unknown_host'
    | 'unsupported_scheme'
    | 'invalid_url'
}

/**
 * The hosts of the hard-blocked platforms.
 *
 * **This list is load-bearing and cannot be derived from the source registry.** Every hard-blocked
 * connector in `policies.ts` has `allowedHosts: []` — correctly, because nothing may ever be fetched
 * from them — which means a host lookup against the registry finds *nothing* for `linkedin.com`. The
 * first version of this module did exactly that, and the consequence was precise and severe: a
 * LinkedIn URL matched no connector, fell through to the personal-site branch, and an attestation
 * promoted it to `authorized_crawl`. The one rule the module exists to enforce, inverted by an empty
 * array.
 *
 * The assertion below is what keeps this honest: a fifth hard-blocked platform added to
 * `HARD_BLOCKED_CONNECTOR_IDS` without hosts here fails at import rather than silently becoming
 * attestable.
 */
const HARD_BLOCKED_HOSTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  linkedin: ['linkedin.com', 'lnkd.in'],
  x: ['x.com', 'twitter.com', 't.co'],
  facebook: ['facebook.com', 'fb.com', 'fb.me', 'm.facebook.com'],
  instagram: ['instagram.com', 'instagr.am'],
})

for (const connectorId of HARD_BLOCKED_CONNECTOR_IDS) {
  if (!HARD_BLOCKED_HOSTS[connectorId]?.length) {
    throw new Error(
      `hard-blocked connector '${connectorId}' has no hosts in HARD_BLOCKED_HOSTS; without them a URL for it ` +
      'matches no connector and an ownership attestation would promote it to authorized_crawl',
    )
  }
}

function matchesHost(host: string, candidates: readonly string[]): boolean {
  return candidates.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

/** The hard-blocked platform a host belongs to, if any. Checked before the registry. */
function findHardBlockedConnector(host: string): string | null {
  for (const [connectorId, hosts] of Object.entries(HARD_BLOCKED_HOSTS)) {
    if (matchesHost(host, hosts)) return connectorId
  }
  return null
}

/**
 * Hosts a candidate may attest to owning: their own site, a project page, a personal domain.
 * Deliberately expressed as "not a platform we know about" rather than a list — a personal domain is
 * by definition not enumerable — which is only safe because hard-blocked platforms are resolved
 * first, by explicit host, and can never reach this branch.
 */
function isAttestableHost(host: string, matchedConnectorId: string | null): boolean {
  if (matchedConnectorId !== null) return false
  // A bare hostname with no dot is not a public site; `localhost` and friends would also be caught
  // by the network envelope, but there is no reason to let them get that far.
  if (!host.includes('.')) return false
  return true
}

function findConnectorForHost(host: string): string | null {
  for (const policy of Object.values(SOURCE_POLICIES)) {
    if (policy.allowedHosts.length > 0 && matchesHost(host, policy.allowedHosts)) {
      return policy.id
    }
  }
  return null
}

export function resolveLinkImportPolicy(input: LinkPolicyInput): LinkPolicyResult {
  let url: URL
  try {
    url = new URL(input.normalizedUrl)
  } catch {
    return { decision: 'not_importable', connectorId: null, reason: 'invalid_url' }
  }

  // HTTPS only, per the shared envelope's contract. Checked here too because a policy that said
  // "importable" for an `http://` URL would be handing the fetcher something it must then refuse,
  // and the candidate would see a fetch failure rather than a policy answer.
  if (url.protocol !== 'https:') {
    return { decision: 'not_importable', connectorId: null, reason: 'unsupported_scheme' }
  }

  const host = url.hostname.toLowerCase()

  // Hard block first, by explicit host, before anything can promote it. This ordering — and the fact
  // that it does not consult `allowedHosts` — is the module's whole point.
  const blocked = findHardBlockedConnector(host)
  if (blocked !== null) {
    return { decision: 'user_submitted', connectorId: blocked, reason: 'platform_terms_forbid_import' }
  }

  const connectorId = findConnectorForHost(host)

  if (connectorId !== null) {
    const policy = SOURCE_POLICIES[connectorId]
    if (policy.status !== 'enabled') {
      // The registry knows this source and has it switched off. URL-only rather than not_importable:
      // the link is still legitimate evidence a reviewer can open by hand.
      return { decision: 'user_submitted', connectorId, reason: 'platform_terms_forbid_import' }
    }
    if (policy.acquisitionMode === 'official_api') {
      return { decision: 'official_api', connectorId, reason: 'official_api' }
    }
    if (policy.acquisitionMode === 'authorized_crawl') {
      return { decision: 'authorized_crawl', connectorId, reason: 'authorized_crawl' }
    }
    // `user_submitted` in the registry means exactly that: evidence, not a fetch target.
    return { decision: 'user_submitted', connectorId, reason: 'platform_terms_forbid_import' }
  }

  if (!isAttestableHost(host, connectorId)) {
    return { decision: 'not_importable', connectorId: null, reason: 'unknown_host' }
  }

  if (!input.attested) {
    // Not a rejection — an unmet precondition. The candidate can attest and ask again.
    return { decision: 'user_submitted', connectorId: null, reason: 'attestation_required' }
  }
  if (input.attestedNoticeVersion !== LINK_AUTHORIZATION_NOTICE_VERSION) {
    // An attestation against superseded text is not an attestation to the current one. Re-asking is
    // the honest handling; silently accepting it would record consent to words nobody showed.
    return { decision: 'user_submitted', connectorId: null, reason: 'attestation_notice_outdated' }
  }

  return { decision: 'authorized_crawl', connectorId: null, reason: 'authorized_crawl' }
}

/** Whether a resolved decision permits an outbound fetch. The only place that question is answered. */
export function decisionPermitsFetch(decision: LinkPolicyDecision): boolean {
  return decision === 'official_api' || decision === 'authorized_crawl'
}
