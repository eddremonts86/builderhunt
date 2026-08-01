/**
 * Fetches the candidate websites we are permitted to fetch (plan:
 * calendar-scheduling-interview-intelligence, Phase 6, "Implement policy-controlled public-web
 * import").
 *
 * ## Three independent gates, and each one can only narrow
 *
 * 1. `link-import-policy.ts` decided, at attestation time, that this URL *may* be fetched. Re-checked
 *    here rather than trusted, because the attestation may have been made against a notice version
 *    that has since been superseded, or the host may have entered the blocked list between the queue
 *    and the run.
 * 2. RFC 9309 robots, **fail-closed**. `unavailable` blocks the fetch; it does not permit it. A site
 *    whose robots.txt we cannot read has not told us yes.
 * 3. `safeFetch` — HTTPS only, exact-host allowlist, no embedded credentials, public-IP-only DNS with
 *    revalidation on every redirect hop, timeout, byte cap, content-type allowlist.
 *
 * Note that the envelope caps redirects at **3**, while the plan text says 5. The envelope is
 * stricter and it wins: loosening a shared SSRF guard to match a plan sentence would weaken every
 * other consumer of it for no gain here.
 *
 * ## The body is hashed and thrown away
 *
 * spec.md: "then the response body is discarded". What persists is the extracted visible text, a hash
 * of the response, and the robots decision. Keeping raw HTML would mean keeping a copy of someone
 * else's site, with its own retention question, to no benefit — the text is what a brief cites.
 *
 * ## A blocked import is a recorded outcome, not silence
 *
 * `status: 'blocked'` with a reason code, because "we did not fetch this, and here is why" is
 * information the candidate and the organizer both need. Silence is indistinguishable from a bug.
 */
import { createHash } from 'node:crypto'
import { SafeFetchError, safeFetch } from '~/lib/enrichment/network'
import { isPathAllowedByRobots, type RobotsDecision } from '~/lib/enrichment/robots'

/**
 * The three values `candidate_web_imports.robots_result` accepts
 * (`candidate_web_imports_robots_result_check`).
 *
 * Narrower than `RobotsDecision`, which gained `no_robots_file` when the robots reader learned to tell a 4xx
 * apart from a failure. Kept narrow deliberately rather than widened, for two reasons:
 *
 * 1. **This call site is stricter than RFC 9309, on purpose.** The RFC says a missing robots.txt permits
 *    everything. Plan 42 chose to block anyway for *candidate-supplied* links, because a link a person pasted
 *    into an interview record is fetched on their behalf and the conservative reading is the defensible one.
 *    Being stricter than required is always allowed; quietly becoming less strict because an unrelated module
 *    gained precision is not.
 * 2. Widening the type without the migration would store a value the CHECK constraint rejects, which is a
 *    runtime 23514 rather than a compile error.
 */
type StoredRobotsDecision = 'allowed' | 'disallowed' | 'unavailable'

/**
 * Collapses the reader's finer answer back onto this worker's policy.
 *
 * `no_robots_file` becomes `unavailable` because for this worker's question — "did the site say yes?" — the
 * answer is no either way. The distinction the reader now makes is real and useful; it is simply not a
 * distinction *this* policy acts on.
 */
function toStoredDecision(decision: RobotsDecision): StoredRobotsDecision {
  return decision === 'no_robots_file' ? 'unavailable' : decision
}
import { SOURCE_POLICIES } from '~/lib/enrichment/policies'
import {
  LINK_AUTHORIZATION_NOTICE_VERSION,
  decisionPermitsFetch,
  resolveLinkImportPolicy,
} from './link-import-policy'
import { EXTRACTION_VERSION, extractWebImportText } from './web-import-extraction'
import { workerDb } from '~/shared/lib/db/worker-db'
import { withJobRun, type JobRunOutcome } from '~/shared/lib/repositories/platform-operations'
import {
  leaseQueuedLinks,
  listWorkerOrganizationIds,
  recordWebImport,
  setLinkImportState,
  withWorkerOrganization,
  type CandidateLinkRow,
} from '~/shared/lib/repositories/interview-web-imports'

export const WEB_IMPORT_JOB_KEY = 'interviews.web-import'

const LINKS_PER_TENANT = 10
const RETENTION_DAYS = 180

export interface WebImportWorkerResult extends JobRunOutcome {
  organizationsProcessed: number
  imported: number
  blocked: number
  failed: number
  failedOrganizations: string[]
  processedCount: number
  failedCount: number
}

export interface WebImportWorkerOptions {
  now?: Date
  db?: typeof workerDb
  linksPerTenant?: number
  /** Injected so tests can drive a fixture host without a real robots.txt or a real site. */
  fetchPage?: typeof safeFetch
  checkRobots?: typeof isPathAllowedByRobots
}

/**
 * What the import was permitted *by*, recorded on the row so a later reviewer can tell whether a page
 * was fetched under a registry entry or under the candidate's own attestation.
 */
function sourcePolicyVersionFor(connectorId: string | null): string {
  if (connectorId === null) return `attestation:${LINK_AUTHORIZATION_NOTICE_VERSION}`
  const policy = SOURCE_POLICIES[connectorId]
  return `${connectorId}:${policy?.reviewExpiresAt ?? 'unknown'}`
}

type ImportOutcome =
  | { kind: 'imported'; robots: StoredRobotsDecision; record: Parameters<typeof recordWebImport>[1] }
  | { kind: 'blocked'; robots: StoredRobotsDecision; errorCode: string; sourcePolicyVersion: string; finalUrl: string }
  | { kind: 'failed'; robots: StoredRobotsDecision; errorCode: string; sourcePolicyVersion: string; finalUrl: string }

async function importOne(params: {
  link: CandidateLinkRow
  now: Date
  fetchPage: typeof safeFetch
  checkRobots: typeof isPathAllowedByRobots
}): Promise<ImportOutcome> {
  const { link, now, fetchPage, checkRobots } = params

  // Gate 1, re-evaluated. The queued decision is a claim about a moment that has passed.
  const policy = resolveLinkImportPolicy({
    normalizedUrl: link.normalizedUrl,
    attested: link.authorizationAttestedAt !== null,
    attestedNoticeVersion: link.authorizationNoticeVersion,
  })
  const sourcePolicyVersion = sourcePolicyVersionFor(policy.connectorId)

  if (!decisionPermitsFetch(policy.decision)) {
    return {
      kind: 'blocked',
      robots: 'unavailable',
      errorCode: policy.reason,
      sourcePolicyVersion,
      finalUrl: link.normalizedUrl,
    }
  }

  const url = new URL(link.normalizedUrl)
  const host = url.hostname.toLowerCase()

  // Gate 2. `robotsRequired: false` exists for official APIs, which are governed by their terms
  // rather than by a crawl directive; anything reached by crawling is checked.
  const registryPolicy = policy.connectorId === null ? null : SOURCE_POLICIES[policy.connectorId]
  const robotsRequired = registryPolicy?.robotsRequired ?? true

  let robots: StoredRobotsDecision = 'allowed'
  if (robotsRequired) {
    robots = toStoredDecision(await checkRobots(url.origin, url.pathname))
    if (robots !== 'allowed') {
      // Fail-closed on `unavailable`. A site we could not ask has not said yes, and guessing in our
      // own favour is exactly the behaviour RFC 9309 exists to prevent.
      return { kind: 'blocked', robots, errorCode: `robots_${robots}`, sourcePolicyVersion, finalUrl: url.toString() }
    }
  }

  // Gate 3.
  let response
  try {
    response = await fetchPage(link.normalizedUrl, { allowedHosts: [host] })
  } catch (error) {
    const code = error instanceof SafeFetchError ? error.code : 'fetch_failed'
    return { kind: 'failed', robots, errorCode: code, sourcePolicyVersion, finalUrl: url.toString() }
  }

  const extraction = extractWebImportText(response.body)
  if (extraction.text.length === 0) {
    // A page with no visible text is not evidence. Recorded as failed rather than stored empty, so a
    // brief never cites "" as something the candidate published.
    return { kind: 'failed', robots, errorCode: 'no_extractable_text', sourcePolicyVersion, finalUrl: response.finalUrl }
  }

  return {
    kind: 'imported',
    robots,
    record: {
      organizationId: link.organizationId,
      candidateLinkId: link.id,
      finalUrl: response.finalUrl,
      sourcePolicyVersion,
      robotsResult: robots,
      status: 'succeeded',
      errorCode: null,
      fetchedAt: now,
      // The response hash is kept so a re-import can tell "unchanged" from "changed" without keeping
      // the bytes; the content hash keys the dedupe index.
      responseSha256: createHash('sha256').update(response.body, 'utf8').digest('hex'),
      contentSha256: createHash('sha256').update(extraction.text, 'utf8').digest('hex'),
      mediaType: response.contentType,
      bytes: Buffer.byteLength(response.body, 'utf8'),
      extractionVersion: EXTRACTION_VERSION,
      extractedText: extraction.text,
      evidenceMap: {
        title: extraction.title,
        canonicalUrl: extraction.canonicalUrl,
        headings: extraction.headings,
        truncated: extraction.truncated,
        // The URL the candidate submitted, alongside where we ended up. A redirect that changed the
        // page is a fact a reviewer needs, and it is unrecoverable once only `finalUrl` is stored.
        requestedUrl: link.normalizedUrl,
      },
      retentionExpiresAt: new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60_000),
    },
  }
}

export async function runWebImportWorker(options: WebImportWorkerOptions = {}): Promise<WebImportWorkerResult> {
  const now = options.now ?? new Date()
  const db = options.db ?? workerDb
  const perTenant = options.linksPerTenant ?? LINKS_PER_TENANT
  const fetchPage = options.fetchPage ?? safeFetch
  const checkRobots = options.checkRobots ?? isPathAllowedByRobots

  return withJobRun({ jobKey: WEB_IMPORT_JOB_KEY, now, db }, async () => {
    const result: WebImportWorkerResult = {
      organizationsProcessed: 0,
      imported: 0,
      blocked: 0,
      failed: 0,
      failedOrganizations: [],
      processedCount: 0,
      failedCount: 0,
    }

    for (const { id: organizationId } of await listWorkerOrganizationIds(db)) {
      try {
        // Claimed and committed before any outbound request, so the network I/O below holds no
        // transaction open — the same shape as the document worker, for the same reason.
        const links = await withWorkerOrganization(organizationId, (transaction) =>
          leaseQueuedLinks(transaction, organizationId, perTenant), db)

        for (const link of links) {
          const outcome = await importOne({ link, now, fetchPage, checkRobots })
          result.processedCount += 1

          await withWorkerOrganization(organizationId, async (transaction) => {
            if (outcome.kind === 'imported') {
              await recordWebImport(transaction, outcome.record)
              await setLinkImportState(transaction, { organizationId, linkId: link.id, importState: 'succeeded' })
              return
            }

            await recordWebImport(transaction, {
              organizationId,
              candidateLinkId: link.id,
              finalUrl: outcome.finalUrl,
              sourcePolicyVersion: outcome.sourcePolicyVersion,
              robotsResult: outcome.robots,
              status: outcome.kind === 'blocked' ? 'blocked' : 'failed',
              errorCode: outcome.errorCode,
              fetchedAt: null,
              responseSha256: null,
              contentSha256: null,
              mediaType: null,
              bytes: null,
              extractionVersion: null,
              extractedText: null,
              evidenceMap: { requestedUrl: link.normalizedUrl },
              retentionExpiresAt: new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60_000),
            })
            await setLinkImportState(transaction, {
              organizationId,
              linkId: link.id,
              // `not_importable` for a policy refusal — it will not become importable by retrying —
              // and `failed` for a fetch problem, which might.
              importState: outcome.kind === 'blocked' ? 'not_importable' : 'failed',
            })
          }, db)

          if (outcome.kind === 'imported') result.imported += 1
          else if (outcome.kind === 'blocked') { result.blocked += 1; result.failedCount += 1 }
          else { result.failed += 1; result.failedCount += 1 }
        }

        result.organizationsProcessed += 1
      } catch (error) {
        // Per-tenant isolation, and the name only: a fetch error message can carry a full URL.
        result.failedOrganizations.push(organizationId)
        result.failedCount += 1
        console.error('web import worker tenant failed:', organizationId, (error as Error)?.name)
      }
    }

    return result
  })
}
