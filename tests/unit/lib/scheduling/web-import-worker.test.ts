/**
 * Real disposable Postgres, injected fetch and robots.
 *
 * The fetch is injected rather than pointed at a fixture server because the properties under test
 * here are the *worker's* decisions — does it ask robots first, does it fail closed on `unavailable`,
 * does it re-check the policy it was queued under, does it store the robots answer it actually got.
 * `safeFetch`'s own guarantees (SSRF, redirect revalidation, byte caps, content-type allowlist) are
 * already covered by `tests/unit/lib/enrichment/network.test.ts` against a real fixture server, and
 * re-testing them here would duplicate that suite while proving nothing about this worker.
 *
 * What the injected seam must never do is let a fetch through that the worker should have refused —
 * so the recorded calls are asserted, not just the outcome.
 */
import { eq } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import {
  authUsers,
  candidateLinks,
  candidateSubmissions,
  candidateWebImports,
  organizations,
  schedulingInvitations,
} from '~/shared/lib/db/schema'
import { SafeFetchError } from '~/lib/enrichment/network'
import type { RobotsDecision } from '~/lib/enrichment/robots'
import { LINK_AUTHORIZATION_NOTICE_VERSION } from '~/lib/scheduling/link-import-policy'
import { runWebImportWorker, type WebImportWorkerOptions } from '~/lib/scheduling/web-import-worker'

let db: PostgresJsDatabase
let drop: () => Promise<void>

const ORG = 'wi-org'
const OWNER = 'wi-owner'
const NOW = new Date('2027-06-10T09:00:00.000Z')
const RETENTION = new Date('2027-12-31T00:00:00.000Z')

let submission: string

const PAGE = [
  '<!DOCTYPE html><html><head><title>Someone — Projects</title>',
  '<link rel="canonical" href="https://someone.dev/projects"></head><body>',
  '<h1>Projects</h1><p>Built a distributed cache.</p>',
  '<script>var tracking = "should never appear";</script>',
  '</body></html>',
].join('')

let fetchCalls: string[] = []
let robotsCalls: string[] = []
let robotsAnswer: RobotsDecision = 'allowed'
let fetchImpl: (url: string) => Promise<{ status: number; contentType: string; body: string; finalUrl: string }>

function options(overrides: WebImportWorkerOptions = {}): WebImportWorkerOptions {
  return {
    now: NOW,
    db: db as unknown as WebImportWorkerOptions['db'],
    fetchPage: (async (url: string) => {
      fetchCalls.push(url)
      return fetchImpl(url)
    }) as unknown as WebImportWorkerOptions['fetchPage'],
    checkRobots: (async (origin: string) => {
      robotsCalls.push(origin)
      return robotsAnswer
    }) as unknown as WebImportWorkerOptions['checkRobots'],
    ...overrides,
  }
}

beforeAll(async () => {
  const disposable = await createDisposableTestDatabase('interview_web_import_worker')
  db = disposable.db
  drop = disposable.drop

  await db.insert(organizations).values({ id: ORG, name: 'Org', slug: 'wi-org' })
  await db.insert(authUsers).values({
    id: OWNER, name: 'Owner', email: 'wi-owner@test.invalid', emailVerified: true, createdAt: NOW, updatedAt: NOW,
  })
  const [invitation] = await db.insert(schedulingInvitations).values({
    organizationId: ORG,
    ownerUserId: OWNER,
    roleTitle: 'Engineer',
    roleContext: 'Backend',
    durationMinutes: 45,
    timezone: 'UTC',
    modality: 'remote_call',
    policyVersion: 'v1',
  }).returning({ id: schedulingInvitations.id })

  const [row] = await db.insert(candidateSubmissions).values({
    organizationId: ORG,
    invitationId: invitation.id,
    displayName: 'Candidate',
    emailNormalized: 'cand@test.invalid',
    retentionExpiresAt: RETENTION,
  }).returning({ id: candidateSubmissions.id })
  submission = row.id
}, 120_000)

afterAll(async () => {
  await drop()
})

beforeEach(async () => {
  await db.delete(candidateWebImports)
  await db.delete(candidateLinks)
  fetchCalls = []
  robotsCalls = []
  robotsAnswer = 'allowed'
  fetchImpl = async (url) => ({ status: 200, contentType: 'text/html', body: PAGE, finalUrl: url })
})

async function seedLink(overrides: {
  normalizedUrl?: string
  policyDecision?: string
  importState?: string
  attested?: boolean
  noticeVersion?: string | null
} = {}) {
  const attested = overrides.attested ?? true
  const [row] = await db.insert(candidateLinks).values({
    organizationId: ORG,
    submissionId: submission,
    url: overrides.normalizedUrl ?? 'https://someone.dev/projects',
    normalizedUrl: overrides.normalizedUrl ?? 'https://someone.dev/projects',
    sourceType: 'personal_site',
    acquisitionMode: 'authorized_crawl',
    policyDecision: overrides.policyDecision ?? 'authorized_crawl',
    importState: overrides.importState ?? 'queued',
    authorizationNoticeVersion: attested ? (overrides.noticeVersion ?? LINK_AUTHORIZATION_NOTICE_VERSION) : null,
    authorizationAttestedAt: attested ? NOW : null,
  }).returning({ id: candidateLinks.id })
  return row.id
}

const readLink = async (id: string) => {
  const [row] = await db.select().from(candidateLinks).where(eq(candidateLinks.id, id))
  return row
}
const readImport = async (linkId: string) => {
  const [row] = await db.select().from(candidateWebImports).where(eq(candidateWebImports.candidateLinkId, linkId))
  return row
}

describe('an authorized personal site is imported', () => {
  it('asks robots, fetches, stores visible text and discards the markup', async () => {
    const linkId = await seedLink()

    const result = await runWebImportWorker(options())
    expect(result.imported).toBe(1)

    // Robots before the page, not after.
    expect(robotsCalls).toEqual(['https://someone.dev'])
    expect(fetchCalls).toEqual(['https://someone.dev/projects'])

    expect((await readLink(linkId)).importState).toBe('succeeded')
    const record = await readImport(linkId)
    expect(record.status).toBe('succeeded')
    expect(record.robotsResult).toBe('allowed')
    expect(record.extractedText).toContain('Built a distributed cache.')
    // The whole point of the extraction step.
    expect(record.extractedText).not.toContain('tracking')
    expect(record.extractedText).not.toMatch(/[<>]/)
    expect(record.evidenceMap).toMatchObject({
      title: 'Someone — Projects',
      canonicalUrl: 'https://someone.dev/projects',
      requestedUrl: 'https://someone.dev/projects',
    })
    // Hashes present, raw body absent — spec.md: "then the response body is discarded".
    expect(record.responseSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(record.contentSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(Object.keys(record)).not.toContain('rawBody')
  })

  it('does not duplicate a re-import of unchanged content', async () => {
    const linkId = await seedLink()
    await runWebImportWorker(options())

    await db.update(candidateLinks).set({ importState: 'queued' }).where(eq(candidateLinks.id, linkId))
    await runWebImportWorker(options())

    const rows = await db.select().from(candidateWebImports).where(eq(candidateWebImports.candidateLinkId, linkId))
    expect(rows, 'the content hash keys the dedupe index').toHaveLength(1)
  })
})

describe('robots is fail-closed', () => {
  it.each([
    ['disallowed', 'robots_disallowed'],
    ['unavailable', 'robots_unavailable'],
  ])('does not fetch when robots is %s', async (answer, errorCode) => {
    // `unavailable` is the case worth having a test for: a site we could not ask has not said yes,
    // and treating silence as permission is exactly what RFC 9309 exists to prevent.
    robotsAnswer = answer as RobotsDecision
    const linkId = await seedLink()

    const result = await runWebImportWorker(options())

    expect(result.blocked).toBe(1)
    expect(fetchCalls, 'no page request may be made').toEqual([])
    expect((await readLink(linkId)).importState).toBe('not_importable')
    const record = await readImport(linkId)
    expect(record.status).toBe('blocked')
    expect(record.errorCode).toBe(errorCode)
    expect(record.robotsResult).toBe(answer)
    expect(record.extractedText).toBeNull()
  })
})

describe('the queued policy decision is re-checked, not trusted', () => {
  it('refuses a blocked platform even when the row says authorized_crawl', async () => {
    // The row is deliberately inconsistent: someone queued a LinkedIn URL with a crawl decision and a
    // valid attestation. The worker must not fetch it — its own evaluation is what counts, because a
    // decision recorded earlier is a claim about a moment that has passed.
    const linkId = await seedLink({ normalizedUrl: 'https://linkedin.com/in/someone' })

    const result = await runWebImportWorker(options())

    expect(result.blocked).toBe(1)
    expect(fetchCalls).toEqual([])
    expect(robotsCalls, 'not even a robots lookup for a blocked platform').toEqual([])
    const record = await readImport(linkId)
    expect(record.errorCode).toBe('platform_terms_forbid_import')
  })

  it('refuses an attestation made against a superseded notice', async () => {
    const linkId = await seedLink({ noticeVersion: '2020-01-01.1' })

    const result = await runWebImportWorker(options())

    expect(result.blocked).toBe(1)
    expect(fetchCalls).toEqual([])
    expect((await readImport(linkId)).errorCode).toBe('attestation_notice_outdated')
  })

  it('refuses a link with no attestation at all', async () => {
    const linkId = await seedLink({ policyDecision: 'user_submitted', attested: false })
    // Queued despite the decision, which the lease should already exclude — asserted so a future
    // change to the lease predicate cannot quietly start fetching unattested links.
    await db.update(candidateLinks).set({ importState: 'queued' }).where(eq(candidateLinks.id, linkId))

    const result = await runWebImportWorker(options())

    expect(fetchCalls).toEqual([])
    expect(result.imported).toBe(0)
  })
})

describe('a fetch failure is recorded, not swallowed', () => {
  it('records the envelope’s refusal code and leaves the link retryable', async () => {
    // `SafeFetchError(code, message)` — code first, and `private_network` is the real code. Passing
    // them the other way round typechecks, since both are strings, and stores the message as the
    // error code.
    fetchImpl = async () => { throw new SafeFetchError('private_network', 'blocked host') }
    const linkId = await seedLink()

    const result = await runWebImportWorker(options())

    expect(result.failed).toBe(1)
    const record = await readImport(linkId)
    expect(record.status).toBe('failed')
    expect(record.errorCode).toBe('private_network')
    // `failed`, not `not_importable`: a network problem may resolve, a policy refusal will not.
    expect((await readLink(linkId)).importState).toBe('failed')
  })

  it('treats a page with no visible text as a failure rather than empty evidence', async () => {
    fetchImpl = async (url) => ({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><script>only()</script></body></html>',
      finalUrl: url,
    })
    const linkId = await seedLink()

    const result = await runWebImportWorker(options())

    expect(result.failed).toBe(1)
    expect((await readImport(linkId)).errorCode).toBe('no_extractable_text')
  })
})

describe('only queued, permitted links are leased', () => {
  it.each([
    ['not_requested', 'not_requested'],
    ['already succeeded', 'succeeded'],
    ['already running', 'running'],
  ])('ignores a link that is %s', async (_label, importState) => {
    await seedLink({ importState })
    const result = await runWebImportWorker(options())
    expect(result.processedCount).toBe(0)
    expect(fetchCalls).toEqual([])
  })

  it('records the final url when a redirect moved the page', async () => {
    fetchImpl = async () => ({
      status: 200,
      contentType: 'text/html',
      body: PAGE,
      finalUrl: 'https://someone.dev/projects/2027',
    })
    const linkId = await seedLink()

    await runWebImportWorker(options())

    const record = await readImport(linkId)
    expect(record.finalUrl).toBe('https://someone.dev/projects/2027')
    // Both, because a redirect that changed the page is a fact a reviewer needs and it is
    // unrecoverable once only the final URL is stored.
    expect(record.evidenceMap).toMatchObject({ requestedUrl: 'https://someone.dev/projects' })
  })
})
