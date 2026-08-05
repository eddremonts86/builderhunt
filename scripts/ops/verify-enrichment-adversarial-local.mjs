// Public Profile Enrichment — runtime adversarial matrix.
//
// plans/phase-1/42-stealth-scraping/task.md Phase 7, "Run runtime adversarial matrix": exercise
// each hostile/edge case against a running instance with enrichment enabled in a NON-production
// environment, and record the job id and log event for each. This script is that run, and its JSON
// output is the evidence that gets summarized into
// docs/operations/public-enrichment-source-register.md.
//
// Why a script and not more unit tests: the twelve cases are about the *system* — real Postgres,
// the real non-owner roles (so grants and RLS are actually enforced), the real route handlers, the
// real worker loop, real job rows, real retention SQL. tests/unit/lib/enrichment already covers
// each unit in isolation with mocks, and that is exactly the evidence the matrix is not allowed to
// consist of: a mocked repository cannot fail a GRANT.
//
// What is real here and what is not — stated up front, because the whole value of this file is that
// a reader can trust its output:
//
//   * REAL: the database, the roles, the schema, RLS, the route handlers, the worker, the source
//     policy register, the allowlist resolution, the resolver, the retention pass, the subject
//     restriction cascade, the kill switch (a genuinely separate process with the flag off).
//   * SIMULATED: the *transport*, for the fault cases only. `globalThis.fetch` is replaced with a
//     recorder that (a) logs every outbound HTTP request with its host, and (b) answers the
//     scripted status for the case under test. There is no way to make api.github.com return a
//     challenge, a 429 and a timeout on demand, so the alternative to scripting them is not
//     testing them.
//   * REAL NETWORK, once: case 01b performs an actual GET to api.github.com through the same
//     `safeFetch` envelope, so the success path is not only ever seen through a stub. Set
//     ADVERSARIAL_LIVE_GITHUB=false to skip it.
//
// The recorder is also the instrument for the register's hardest claim — "zero blocked-host
// requests appear in the contacted-host list". Every fetch in the process is recorded, and a
// request to a host no case scripted is a hard failure rather than a silent pass.
//
// Required env (same shape as scripts/db/verify-api-isolation-local.mjs, which is where the
// fixture and signed-session patterns come from):
//   DATABASE_URL           -> builderhunt_app role
//   DATABASE_AUTH_URL      -> builderhunt_auth role
//   DATABASE_WORKER_URL    -> builderhunt_worker role
//   DATABASE_PLATFORM_URL  -> builderhunt_platform role
//   OWNER_SEED_URL         -> owner connection, fixture setup only
//   BETTER_AUTH_SECRET, APP_URL, VITE_APP_URL
//
// Usage (the role URLs come from scripts/db/prepare-rls-fixture.mjs, exactly as `pnpm ci:local`
// wires them for test:api-isolation:local):
//   pnpm test:enrichment-matrix:local
//
// Refuses to run unless every URL's database name matches builderhunt_security_test_* — this
// creates jobs, deletes evidence and activates restrictions, none of which belongs in a database
// anyone cares about.

import postgres from 'postgres'
import { sql as rawSql } from 'drizzle-orm'
import { createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CHILD_MODE = process.argv.includes('--kill-switch-child')
const LIVE_GITHUB = process.env.ADVERSARIAL_LIVE_GITHUB !== 'false'
const SELF = fileURLToPath(import.meta.url)

const requiredEnv = ['DATABASE_URL', 'DATABASE_AUTH_URL', 'DATABASE_WORKER_URL', 'DATABASE_PLATFORM_URL', 'OWNER_SEED_URL']
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`${key} is required`)
  const databaseName = new URL(process.env[key]).pathname.slice(1)
  if (!/^builderhunt_security_test_[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Adversarial matrix refuses to run outside a named builderhunt_security_test database (${key})`)
  }
}

// `env.ts` parses process.env once at module load and freezes the result, so every one of these has
// to be set before the first dynamic import() below. The kill-switch case is a separate process for
// the same reason: there is no way to flip the flag inside this one, and pretending otherwise would
// test a variable rather than the switch.
process.env.ENRICHMENT_ENABLED = CHILD_MODE ? 'false' : 'true'
process.env.ENRICHMENT_ALLOWED_CONNECTORS = 'github'
process.env.ENRICHMENT_RAW_RETENTION_DAYS = '30'
process.env.ENRICHMENT_ACCEPTED_RETENTION_DAYS = '180'
process.env.ENRICHMENT_LEASE_SECONDS = '300'
process.env.ENRICHMENT_BATCH_SIZE = '10'
process.env.CRON_SECRET = 'adversarial-matrix-cron-secret-not-a-real-one'

const owner = postgres(process.env.OWNER_SEED_URL, { max: 1, prepare: false })

const IDS = {
  org: 'adv-org',
  user: 'adv-user',
  session: 'adv-session',
  sessionToken: 'adv-session-token',
  claimant: 'adv-claimant',
  claimantToken: 'adv-claimant-token',
}

/**
 * One tracked identity per case, so no case can be contaminated by another's job history,
 * attempt_count or evidence rows. `username` is what the github connector puts in the request path.
 */
const SUBJECTS = {
  scripted: { username: 'adv-scripted', sourceId: '910001' },
  live: { username: 'octocat', sourceId: '583231' },
  blocked: { username: 'adv-blocked', sourceId: '910002' },
  challenge: { username: 'adv-challenge', sourceId: '910003' },
  ratelimited: { username: 'adv-ratelimited', sourceId: '910004' },
  timeout: { username: 'adv-timeout', sourceId: '910005' },
  overlap: { username: 'adv-overlap', sourceId: '910006' },
  crash: { username: 'adv-crash', sourceId: '910007' },
  restricted: { username: 'adv-restricted', sourceId: '910008' },
  retention: { username: 'adv-retention', sourceId: '910009' },
  killswitch: { username: 'adv-killswitch', sourceId: '910010' },
}
const identityId = (key) => `adv-identity-${key}`
const trackedId = (key) => `adv-tracked-${key}`
// One operator account per case. `/api/builders/:id/evidence-refresh` rate-limits 10 requests per
// hour per `organization:user`, and the matrix makes more than that in a minute — sharing one account
// would turn later cases into 429s and prove nothing about them. Each case's operator is a real
// member of the same organization, which is also the honest shape: several recruiters, one tenant.
const userId = (key) => `adv-user-${key}`
const sessionToken = (key) => `adv-session-token-${key}`

// ── the recorder ─────────────────────────────────────────────────────────────────────────────────

const contacted = []
let currentCase = 'setup'
/** host or `host+pathname` -> behaviour, replaced per case. */
let plan = new Map()

const realFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = async (input, init = {}) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  const url = new URL(raw)
  const behaviour = plan.get(`${url.hostname}${url.pathname}`) ?? plan.get(url.hostname)
  contacted.push({
    case: currentCase,
    host: url.hostname,
    path: url.pathname,
    transport: behaviour?.kind === 'passthrough' ? 'real-network' : behaviour ? 'scripted' : 'unscripted',
  })
  if (!behaviour) {
    // Not a soft failure: an unscripted request means the matrix does not know where this process
    // sends traffic, which is the one thing it exists to establish.
    throw new Error(`unscripted egress to ${url.hostname}${url.pathname} during case ${currentCase}`)
  }
  if (behaviour.kind === 'passthrough') return realFetch(raw, init)
  if (behaviour.kind === 'hang') {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        reject(error)
      }, { once: true })
    })
  }
  return new Response(behaviour.body ?? '', {
    status: behaviour.status ?? 200,
    headers: { 'content-type': behaviour.contentType ?? 'application/json', ...(behaviour.headers ?? {}) },
  })
}

function githubUserBody(subject, overrides = {}) {
  return JSON.stringify({
    id: Number(subject.sourceId),
    login: subject.username,
    name: 'Adversarial Fixture',
    bio: 'Public profile fixture for the adversarial matrix.',
    company: '@fixture-corp',
    location: 'Copenhagen, Denmark',
    html_url: `https://github.com/${subject.username}`,
    ...overrides,
  })
}

function startCase(name, entries) {
  currentCase = name
  plan = new Map(Object.entries(entries ?? {}))
}

const hostsContactedIn = (name) => contacted.filter((entry) => entry.case === name).map((entry) => `${entry.host}${entry.path}`)

// ── results ──────────────────────────────────────────────────────────────────────────────────────

const results = []
const evidenceLog = []

function record(name, pass, detail) {
  results.push({ name, pass, detail })
}

/** One row of the matrix, as it will appear in the source register. */
function closeCase({ id, title, expected, observed, jobIds = [], logEvents = [], pass }) {
  evidenceLog.push({
    id,
    title,
    expected,
    observed,
    jobIds,
    logEvents,
    hostsContacted: [...new Set(hostsContactedIn(id))],
    pass,
  })
  record(`${id} ${title}`, pass, observed)
}

// ── captured log events ──────────────────────────────────────────────────────────────────────────
//
// The structured logger (src/shared/lib/log.ts) mints no per-entry id — it writes one JSON object
// per line with `ts` + `event`. So "log event id" is recorded here as `event@ts`, which identifies
// the line uniquely in a log stream, and the absence of a real id is reported as a finding rather
// than papered over with an invented one.

const logLines = []
for (const stream of ['log', 'warn', 'error']) {
  const original = console[stream].bind(console)
  console[stream] = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('{')) {
      try {
        const entry = JSON.parse(args[0])
        if (entry.event) logLines.push({ case: currentCase, event: entry.event, ts: entry.ts, level: entry.level })
      } catch { /* not a structured line; ignore */ }
    }
    original(...args)
  }
}

const logEventsIn = (name, prefix) => logLines
  .filter((entry) => entry.case === name && (!prefix || entry.event.startsWith(prefix)))
  .map((entry) => `${entry.event}@${entry.ts}`)

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

function signedSessionCookie(token) {
  const signature = createHmac('sha256', process.env.BETTER_AUTH_SECRET).update(token).digest('base64')
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
}

function sessionRequest(token, url, init = {}) {
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: signedSessionCookie(token), 'x-request-id': crypto.randomUUID() },
  })
}

function cronRequest(url, init = {}) {
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${process.env.CRON_SECRET}`, 'x-request-id': crypto.randomUUID() },
  })
}

async function member(id, token, name, role) {
  await owner`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values (${id}, ${name}, ${`${id}@test.invalid`}, true, now(), now())
  `
  await owner`
    insert into organization_members (id, organization_id, user_id, role, created_at)
    values (${`${IDS.org}:${id}`}, ${IDS.org}, ${id}, ${role}, now())
  `
  await owner`
    insert into auth_sessions (id, user_id, active_organization_id, token, expires_at, created_at, updated_at)
    values (${`session-${id}`}, ${id}, ${IDS.org}, ${token}, now() + interval '1 day', now(), now())
  `
}

async function seed() {
  await owner`insert into organizations (id, name, slug, metadata, created_at) values (${IDS.org}, 'Adv Org', 'adv-org', '{}', now())`
  await member(IDS.user, IDS.sessionToken, 'Adversarial Owner', 'owner')
  // The data subject: a developer who claimed and verified their own profile. Separate from every
  // operator account because the rights this account exercises (provenance export, restriction) are
  // the subject's, not the tenant's.
  await member(IDS.claimant, IDS.claimantToken, 'Adversarial Claimant', 'member')

  for (const key of Object.keys(SUBJECTS)) {
    await member(userId(key), sessionToken(key), `Operator ${key}`, 'member')
  }

  for (const [key, subject] of Object.entries(SUBJECTS)) {
    await owner`
      insert into builder_identities (id, source, source_id, username, display_name, profile_url, country, created_at, updated_at)
      values (
        ${identityId(key)}, 'github', ${subject.sourceId}, ${subject.username}, 'Adversarial Fixture',
        ${`https://github.com/${subject.username}`}, 'Copenhagen, Denmark', now(), now()
      )
    `
    await owner`
      insert into organization_builders (
        id, organization_id, builder_identity_id, creator_user_id, visibility, status, private_metadata, created_at, updated_at
      ) values (
        ${trackedId(key)}, ${IDS.org}, ${identityId(key)}, ${IDS.user}, 'private', 'tracked', '{}', now(), now()
      )
    `
  }

  // The restriction and provenance endpoints are verified-claimant only (spec §5.5): without these
  // rows those cases would prove the 403 guard instead of the cascade and the export.
  for (const key of ['restricted', 'scripted']) {
    await owner`
      insert into builder_claims (
        id, builder_identity_id, subject_user_id, evidence_source, evidence_reference, status, verified_at, metadata, created_at
      ) values (
        ${`adv-claim-${key}`}, ${identityId(key)}, ${IDS.claimant}, 'github', ${`adv-${key}`}, 'verified', now(), '{}', now()
      )
    `
  }

  // Gives the worker's `withJobRun` a schedule row to advance, the same as production.
  await owner`
    insert into operational_schedules (job_key, cron_expression, timezone, scope, enabled, created_at, updated_at)
    values ('enrichment.refresh', '*/30 * * * *', 'UTC', 'platform', true, now(), now())
    on conflict (job_key) do nothing
  `
}

// ── shared drivers ───────────────────────────────────────────────────────────────────────────────

let routes
async function loadRoutes() {
  const [refresh, evidenceList, provenance, restrict, runWorker, worker, network, robots, policies, tenantContext, principal, repo] = await Promise.all([
    import('../../src/routes/api/builders/$builderId/evidence-refresh.ts'),
    import('../../src/routes/api/builders/$builderId/evidence/index.ts'),
    import('../../src/routes/api/me/builder/$builderId/evidence-provenance.ts'),
    import('../../src/routes/api/me/builder/$builderId/restrict-processing.ts'),
    import('../../src/routes/api/admin/enrichment/run-worker.ts'),
    import('../../src/lib/enrichment/worker.ts'),
    import('../../src/lib/enrichment/network.ts'),
    import('../../src/lib/enrichment/robots.ts'),
    import('../../src/lib/enrichment/policies.ts'),
    import('../../src/shared/lib/db/tenant-context.ts'),
    import('../../src/shared/lib/auth/tenant-principal.ts'),
    import('../../src/shared/lib/repositories/enrichment.ts'),
  ])
  routes = {
    refreshPOST: refresh.Route.options.server.handlers.POST,
    evidenceGET: evidenceList.Route.options.server.handlers.GET,
    provenanceGET: provenance.Route.options.server.handlers.GET,
    restrictPOST: restrict.Route.options.server.handlers.POST,
    runWorkerPOST: runWorker.Route.options.server.handlers.POST,
    runEnrichmentWorker: worker.runEnrichmentWorker,
    safeFetch: network.safeFetch,
    SafeFetchError: network.SafeFetchError,
    isPathAllowedByRobots: robots.isPathAllowedByRobots,
    getSourcePolicy: policies.getSourcePolicy,
    withTenantContext: tenantContext.withTenantContext,
    requireTenantPrincipal: principal.requireTenantPrincipal,
    listEnrichmentEvidence: repo.listEnrichmentEvidence,
  }
}

/** POSTs the real enqueue route as the org owner and returns { status, body }. */
async function enqueue(key, requestBody = { connectors: ['github'], submittedUrls: [] }) {
  const response = await routes.refreshPOST({
    request: sessionRequest(sessionToken(key), 'https://adv.test/api/builders/x/evidence-refresh', { method: 'POST', body: JSON.stringify(requestBody) }),
    params: { builderId: identityId(key) },
  })
  const body = await response.json()
  // 409 (restricted) and 503 (kill switch) are documented case outcomes; anything else that is not a
  // successful enqueue is a setup fault, and saying so here beats a downstream `undefined jobId`.
  if (![200, 202, 409, 503].includes(response.status)) {
    console.error(`[matrix] enqueue for ${key} answered ${response.status}: ${JSON.stringify(body)}`)
  }
  return { status: response.status, body }
}

/** Runs the worker through the cron-authenticated admin route, so job_runs records it as production would. */
async function runWorkerViaRoute() {
  const response = await routes.runWorkerPOST({ request: cronRequest('https://adv.test/api/admin/enrichment/run-worker', { method: 'POST' }) })
  return { status: response.status, body: await response.json() }
}

const jobRow = async (jobId) => !jobId ? undefined : (await owner`
  select id, status, attempt_count, last_error_code, available_at, lease_token, lease_expires_at, finished_at
  from enrichment_jobs where id = ${jobId}
`)[0]

const evidenceRows = async (key) => owner`
  select id, connector, acquisition_mode, source_url, source_record_id, resolution, confidence_bps, match_signals, expires_at, observed_at
  from enrichment_evidence where builder_identity_id = ${identityId(key)} order by observed_at
`

const lastJobRunId = async () => (await owner`
  select id, state, processed_count, failed_count from job_runs where job_key = 'enrichment.refresh' order by started_at desc limit 1
`)[0]

// ── the twelve cases ─────────────────────────────────────────────────────────────────────────────

async function case01ScriptedSuccess() {
  const id = '01a'
  startCase(id, { 'api.github.com': { kind: 'json', body: githubUserBody(SUBJECTS.scripted) } })

  const enqueued = await enqueue('scripted')
  const run = await runWorkerViaRoute()
  const job = await jobRow(enqueued.body.jobId)
  const evidence = await evidenceRows('scripted')
  const jobRun = await lastJobRunId()

  const only = [...new Set(hostsContactedIn(id).map((entry) => entry.split('/')[0]))]
  closeCase({
    id,
    title: 'allowlisted host succeeds (scripted transport)',
    expected: '202 enqueue; job succeeded; one accepted evidence row at 10000 bps (the stable source id matches); api.github.com the only host contacted',
    observed: JSON.stringify({
      enqueueStatus: enqueued.status,
      runStatus: run.status,
      workerCounters: { claimed: run.body.claimed, succeeded: run.body.succeeded, evidenceReview: run.body.evidenceReview, evidenceAccepted: run.body.evidenceAccepted },
      jobStatus: job?.status,
      evidence: evidence.map((row) => ({ connector: row.connector, mode: row.acquisition_mode, resolution: row.resolution, confidenceBps: row.confidence_bps, signals: row.match_signals })),
      jobRun: jobRun && { id: jobRun.id, state: jobRun.state, processed: jobRun.processed_count },
      hosts: only,
    }),
    jobIds: [enqueued.body.jobId, ...(jobRun ? [`job_runs:${jobRun.id}`] : [])],
    logEvents: logEventsIn(id, 'enrichment'),
    pass: enqueued.status === 202 && run.status === 200 && job?.status === 'succeeded'
      && evidence.length === 1 && evidence[0].connector === 'github'
      && only.length === 1 && only[0] === 'api.github.com',
  })

  // Retention follows the resolution, so an accepted row must carry the 180-day window rather than the
  // 30-day raw one. Checked here because the accept path only started producing accepted rows once the
  // worker began passing `candidateSourceRecordId`, and an accepted row on a 30-day expiry would be a
  // silent retention bug rather than a visible one.
  const acceptedDays = evidence[0] ? Math.round((new Date(evidence[0].expires_at) - Date.now()) / 86_400_000) : null
  record(
    '01a accepted evidence carries the 180-day accepted-retention window, not the 30-day raw one',
    evidence[0]?.resolution === 'accepted' && acceptedDays > 170 && acceptedDays <= 180,
    JSON.stringify({ resolution: evidence[0]?.resolution, expiresInDays: acceptedDays }),
  )

  // Regression, and the reason this row exists: until 2026-08-05 the worker called
  // resolveEnrichmentCandidate without `candidateSourceRecordId`, so the 10 000-bps stable-id signal
  // that exists precisely to auto-accept an exact match never fired — the candidate's
  // `source_record_id` equalled the target's `source_id` and the row still resolved to `review` at
  // 7 500. Nothing was ever auto-accepted. This matrix found that; the assertion below is what keeps
  // it found.
  const row = evidence[0]
  record(
    '01a regression: an exact stable-source-id match scores exact_stable_source_id and auto-accepts',
    Boolean(row) && row.source_record_id === SUBJECTS.scripted.sourceId
      && row.match_signals.includes('exact_stable_source_id') && row.confidence_bps === 10000 && row.resolution === 'accepted',
    JSON.stringify({ sourceRecordId: row?.source_record_id, targetSourceId: SUBJECTS.scripted.sourceId, signals: row?.match_signals, confidenceBps: row?.confidence_bps, resolution: row?.resolution }),
  )
}

async function case01LiveSuccess() {
  const id = '01b'
  if (!LIVE_GITHUB) {
    closeCase({ id, title: 'allowlisted host succeeds (real network)', expected: 'skipped', observed: 'skipped: ADVERSARIAL_LIVE_GITHUB=false', pass: true })
    return
  }
  startCase(id, { 'api.github.com': { kind: 'passthrough' } })

  const enqueued = await enqueue('live')
  await runWorkerViaRoute()
  const job = await jobRow(enqueued.body.jobId)
  const evidence = await evidenceRows('live')

  // What a live case can prove is that the *transport* worked: the request left the process, the
  // response passed the safeFetch envelope (HTTPS, allowlisted host, content type, size cap) and
  // parsed into a persisted evidence row. What it deliberately does not pin is the resolver's verdict,
  // because that depends on what GitHub serves today. The fixture's `sourceId` is octocat's real
  // GitHub id, so as of 2026-08-05 the stable-id signal fires against the live API and the row is
  // `accepted` at 10 000 bps — real evidence that the strongest signal works end to end against a real
  // upstream. If GitHub ever renumbered that account the row would drop to `review` or `rejected`, and
  // this case should still pass: it is a transport check. Case 01a owns the accept path with values
  // that are known because they are scripted.
  const noNetworkFailure = job?.last_error_code !== 'rate_limited' && job?.last_error_code !== 'upstream_unavailable'
  closeCase({
    id,
    title: 'allowlisted host succeeds (real network, real safeFetch envelope)',
    expected: 'a genuine HTTPS GET to api.github.com returns a public profile, one evidence row is persisted, and the job reaches a terminal state with no transport error',
    observed: JSON.stringify({
      enqueueStatus: enqueued.status,
      jobStatus: job?.status,
      lastErrorCode: job?.last_error_code,
      evidence: evidence.map((row) => ({ connector: row.connector, mode: row.acquisition_mode, resolution: row.resolution, confidenceBps: row.confidence_bps, signals: row.match_signals })),
      resolverNote: 'the resolution is whatever the live profile scores against the fixture; this case pins the transport, not the verdict',
      transport: contacted.filter((entry) => entry.case === id).map((entry) => entry.transport),
    }),
    jobIds: [enqueued.body.jobId],
    logEvents: logEventsIn(id, 'enrichment'),
    pass: enqueued.status === 202 && ['succeeded', 'failed'].includes(job?.status) && noNetworkFailure
      && evidence.length === 1 && evidence[0].connector === 'github'
      && contacted.some((entry) => entry.case === id && entry.transport === 'real-network'),
  })
}

async function case02BlockedHost() {
  const id = '02'
  startCase(id, { 'api.github.com': { kind: 'json', body: githubUserBody(SUBJECTS.blocked) } })

  // A LinkedIn profile the operator pastes in by hand: recordable as attributed evidence, never
  // fetchable (spec §5.3). Requesting the blocked connector explicitly at the same time is the
  // other half — the route must drop it rather than honour it.
  const enqueued = await enqueue('blocked', {
    connectors: ['github', 'linkedin', 'user-submitted'],
    submittedUrls: ['https://www.linkedin.com/in/adv-blocked'],
  })
  const run = await runWorkerViaRoute()
  const job = await jobRow(enqueued.body.jobId)
  const evidence = await evidenceRows('blocked')

  // And the policy layer directly: a blocked connector's own policy has an empty allowedHosts list,
  // so this asserts the refusal happens before any socket is opened.
  let directOutcome = 'no-error'
  const before = contacted.length
  try {
    await routes.safeFetch('https://www.linkedin.com/in/adv-blocked', { allowedHosts: routes.getSourcePolicy('linkedin').allowedHosts })
  } catch (error) {
    directOutcome = error instanceof routes.SafeFetchError ? error.code : `unexpected:${error?.name}`
  }
  const openedSocket = contacted.length > before

  const blockedHostContacted = contacted.some((entry) => /linkedin|twitter|x\.com|facebook|instagram/.test(entry.host))
  closeCase({
    id,
    title: 'blocked host is recorded but never contacted',
    expected: 'linkedin dropped from acceptedConnectors; the pasted URL stored as user_submitted evidence and resolved to `review` so the tenant can actually see it; safeFetch refuses host_not_allowed with no request; zero blocked-host requests',
    observed: JSON.stringify({
      acceptedConnectors: enqueued.body.acceptedConnectors,
      blockedConnectors: enqueued.body.blockedConnectors,
      jobStatus: job?.status,
      evidence: evidence.map((row) => ({ connector: row.connector, mode: row.acquisition_mode, url: row.source_url.replace(/[^/]+$/, '<redacted>'), resolution: row.resolution })),
      directSafeFetch: directOutcome,
      openedSocket,
      workerCounters: { succeeded: run.body.succeeded, evidenceReview: run.body.evidenceReview },
    }),
    jobIds: [enqueued.body.jobId],
    logEvents: logEventsIn(id, 'enrichment'),
    pass: Array.isArray(enqueued.body.blockedConnectors) && enqueued.body.blockedConnectors.includes('linkedin')
      && !enqueued.body.acceptedConnectors.includes('linkedin')
      && evidence.some((row) => row.acquisition_mode === 'user_submitted' && row.source_url.includes('linkedin.com') && row.resolution === 'review')
      && directOutcome === 'host_not_allowed' && !openedSocket && !blockedHostContacted,
  })

  // Regression: the pasted link used to resolve `rejected`, and the tenant read only returns
  // accepted/review — so it was written, invisible, and deleted after seven days. Asserted through the
  // real route the UI calls, not the table, because "visible" is a property of the read path.
  const visibleToTenant = await (await routes.evidenceGET({
    request: sessionRequest(sessionToken('blocked'), 'https://adv.test/api/builders/x/evidence'),
    params: { builderId: identityId('blocked') },
  })).json()
  record(
    '02 regression: an operator-pasted URL is visible through the tenant evidence read, at zero confidence',
    Array.isArray(visibleToTenant.evidence)
      && visibleToTenant.evidence.some((row) => row.acquisitionMode === 'user_submitted' && row.confidenceBps === 0 && row.resolution === 'review'),
    JSON.stringify(visibleToTenant.evidence?.map((row) => ({ mode: row.acquisitionMode, resolution: row.resolution, confidenceBps: row.confidenceBps }))),
  )
}

async function case03RobotsDenial() {
  const id = '03'
  // Three real, resolvable hosts, because the robots cache is keyed by host with a 1h TTL and one
  // host cannot answer three ways in one run. None is actually contacted — the transport is scripted.
  startCase(id, {
    'api.github.com/robots.txt': { kind: 'json', contentType: 'text/plain', body: 'User-agent: *\nDisallow: /users/\nAllow: /users/public\n' },
    'github.com/robots.txt': { kind: 'json', status: 404, contentType: 'text/plain', body: 'not found' },
    'raw.githubusercontent.com/robots.txt': { kind: 'json', status: 503, contentType: 'text/plain', body: 'upstream down' },
  })

  const disallowed = await routes.isPathAllowedByRobots('https://api.github.com', '/users/adv-blocked')
  const allowedByLongerRule = await routes.isPathAllowedByRobots('https://api.github.com', '/users/public')
  const absent = await routes.isPathAllowedByRobots('https://github.com', '/anything')
  const unavailable = await routes.isPathAllowedByRobots('https://raw.githubusercontent.com', '/anything')

  closeCase({
    id,
    title: 'robots.txt denial is honoured, and its three outcomes stay distinct',
    expected: "Disallow -> 'disallowed'; longest-match Allow -> 'allowed'; 4xx -> 'no_robots_file' (RFC 9309); 5xx -> 'unavailable'",
    observed: JSON.stringify({ disallowed, allowedByLongerRule, absent, unavailable }),
    logEvents: logEventsIn(id),
    pass: disallowed === 'disallowed' && allowedByLongerRule === 'allowed' && absent === 'no_robots_file' && unavailable === 'unavailable',
  })

  // The honest scope note, asserted rather than claimed: no *enabled* connector is in
  // authorized_crawl mode, so at this configuration robots is a library guarantee waiting for its
  // first caller, not an active runtime path.
  const modes = ['github', 'user-submitted'].map((connector) => routes.getSourcePolicy(connector).acquisitionMode)
  record(
    '03 scope: no enabled connector crawls HTML, so robots gates nothing at this configuration',
    modes.every((mode) => mode !== 'authorized_crawl'),
    JSON.stringify({ enabledConnectorModes: modes }),
  )
}

async function case04Challenge() {
  const id = '04'
  startCase(id, { 'api.github.com': { kind: 'json', status: 403, body: JSON.stringify({ message: 'Request blocked. Please solve the challenge.' }) } })

  const enqueued = await enqueue('challenge')
  await runWorkerViaRoute()
  const job = await jobRow(enqueued.body.jobId)
  const evidence = await evidenceRows('challenge')

  closeCase({
    id,
    title: 'challenge / auth wall stops the connector instead of retrying into it',
    expected: 'job failed with all_connectors_failed, zero evidence rows, no retry scheduled',
    observed: JSON.stringify({ jobStatus: job?.status, lastErrorCode: job?.last_error_code, attempts: job?.attempt_count, evidenceRows: evidence.length }),
    jobIds: [enqueued.body.jobId],
    logEvents: logEventsIn(id, 'enrichment'),
    pass: job?.status === 'failed' && job?.last_error_code === 'all_connectors_failed' && evidence.length === 0,
  })
}

async function case05RateLimited() {
  const id = '05'
  startCase(id, { 'api.github.com': { kind: 'json', status: 429, headers: { 'retry-after': '120' }, body: JSON.stringify({ message: 'API rate limit exceeded' }) } })

  const enqueued = await enqueue('ratelimited')
  await runWorkerViaRoute()
  const job = await jobRow(enqueued.body.jobId)
  const secondsOut = job ? (new Date(job.available_at).getTime() - Date.now()) / 1000 : null

  closeCase({
    id,
    title: '429 requeues with the upstream Retry-After, and keeps the lease released',
    expected: "status back to 'queued', last_error_code rate_limited, available_at ~120s out, lease cleared",
    observed: JSON.stringify({ jobStatus: job?.status, lastErrorCode: job?.last_error_code, attempts: job?.attempt_count, retryInSeconds: secondsOut && Math.round(secondsOut), leaseToken: job?.lease_token }),
    jobIds: [enqueued.body.jobId],
    logEvents: logEventsIn(id, 'enrichment'),
    pass: job?.status === 'queued' && job?.last_error_code === 'rate_limited' && job?.attempt_count === 1
      && job?.lease_token === null && secondsOut > 60 && secondsOut < 200,
  })
}

async function case06Timeout() {
  const id = '06'
  startCase(id, { 'api.github.com': { kind: 'hang' } })

  const enqueued = await enqueue('timeout')
  const startedAt = Date.now()
  await runWorkerViaRoute()
  const elapsedMs = Date.now() - startedAt
  const job = await jobRow(enqueued.body.jobId)

  closeCase({
    id,
    title: 'a hung upstream is cut off by the 10s request timeout and retried as upstream_unavailable',
    expected: "the request is aborted at ~10s; job back to 'queued' with last_error_code upstream_unavailable",
    observed: JSON.stringify({ jobStatus: job?.status, lastErrorCode: job?.last_error_code, attempts: job?.attempt_count, abortedAfterMs: elapsedMs }),
    jobIds: [enqueued.body.jobId],
    logEvents: logEventsIn(id, 'enrichment'),
    pass: job?.status === 'queued' && job?.last_error_code === 'upstream_unavailable' && elapsedMs > 9_000 && elapsedMs < 20_000,
  })
}

async function case07OverlappingJobs() {
  const id = '07'
  startCase(id, { 'api.github.com': { kind: 'json', body: githubUserBody(SUBJECTS.overlap) } })

  const first = await enqueue('overlap')
  const second = await enqueue('overlap')
  const rows = await owner`select id, status from enrichment_jobs where builder_identity_id = ${identityId('overlap')}`

  closeCase({
    id,
    title: 'two overlapping refresh requests for one builder collapse into one job',
    expected: 'first 202 created; second 200 returning the same jobId; exactly one job row',
    observed: JSON.stringify({ first: { status: first.status, jobId: first.body.jobId }, second: { status: second.status, jobId: second.body.jobId }, jobRows: rows.length }),
    jobIds: [first.body.jobId],
    logEvents: logEventsIn(id, 'enrichment'),
    pass: first.status === 202 && second.status === 200 && first.body.jobId === second.body.jobId && rows.length === 1,
  })
}

async function case08CrashAndReclaim() {
  const id = '08'
  startCase(id, { 'api.github.com': { kind: 'json', body: githubUserBody(SUBJECTS.crash) } })

  const enqueued = await enqueue('crash')
  const { claimDueEnrichmentJobs } = await import('../../src/shared/lib/repositories/enrichment-worker.ts')

  // The crash: a worker claims the job, takes its lease, and dies before finishing. Nothing else
  // runs — the row is simply left `running` with a live lease, which is the state a SIGKILL leaves.
  const claimed = await claimDueEnrichmentJobs(10, 300)
  const afterCrash = await jobRow(enqueued.body.jobId)

  // Only the clock is simulated: a lease that would expire in 300s is aged past its deadline
  // instead of waiting five minutes. The reclaim path itself is the real one.
  await owner`update enrichment_jobs set lease_expires_at = now() - interval '1 minute' where id = ${enqueued.body.jobId}`

  const run = await runWorkerViaRoute()
  const afterReclaim = await jobRow(enqueued.body.jobId)
  const evidence = await evidenceRows('crash')

  closeCase({
    id,
    title: 'a crashed worker\'s job is reclaimed after its lease expires, not stranded',
    expected: "left 'running' with a lease; reclaimed to 'queued' by the next run; then processed to completion",
    observed: JSON.stringify({
      claimedIds: claimed.map((job) => job.id),
      afterCrash: { status: afterCrash?.status, hasLease: Boolean(afterCrash?.lease_token) },
      leasesReclaimed: run.body.leasesReclaimed,
      afterReclaim: { status: afterReclaim?.status, attempts: afterReclaim?.attempt_count },
      evidenceRows: evidence.length,
    }),
    jobIds: [enqueued.body.jobId],
    logEvents: logEventsIn(id, 'enrichment'),
    pass: afterCrash?.status === 'running' && Boolean(afterCrash?.lease_token)
      && run.body.leasesReclaimed >= 1 && afterReclaim?.status === 'succeeded' && afterReclaim?.attempt_count === 2,
  })
}

async function case09RestrictionMidFlight() {
  const id = '09'
  startCase(id, { 'api.github.com': { kind: 'json', body: githubUserBody(SUBJECTS.restricted) } })

  // Give the subject something to lose first: a completed job with a live evidence row.
  const firstJob = await enqueue('restricted')
  await runWorkerViaRoute()
  const evidenceBefore = await evidenceRows('restricted')

  // A second job is queued and waiting when the restriction lands — the "arriving mid-job" shape.
  const queuedJob = await enqueue('restricted')

  const restrictResponse = await routes.restrictPOST({
    request: sessionRequest(IDS.claimantToken, 'https://adv.test/api/me/builder/x/restrict-processing', { method: 'POST' }),
    params: { builderId: identityId('restricted') },
  })
  const restrictBody = await restrictResponse.json()

  const cancelled = await jobRow(queuedJob.body.jobId)
  const evidenceAfter = await evidenceRows('restricted')

  // And the worker-side guard, which is the one that matters if a job is enqueued after the fact:
  // a fresh job must be cancelled without a single request going out.
  const hostsBefore = contacted.length
  await owner`
    insert into enrichment_jobs (id, organization_id, builder_identity_id, requested_by_user_id, trigger, status, requested_connectors, submitted_urls, created_at, updated_at)
    values ('adv-job-post-restriction', ${IDS.org}, ${identityId('restricted')}, ${IDS.user}, 'scheduled', 'queued', '["github"]'::jsonb, '[]'::jsonb, now(), now())
  `
  const run = await runWorkerViaRoute()
  const postRestriction = await jobRow('adv-job-post-restriction')
  const requestsDuringGuardedRun = contacted.length - hostsBefore

  const refreshWhileRestricted = await enqueue('restricted')

  closeCase({
    id,
    title: 'subject restriction cancels queued work, purges evidence, and blocks new work at the worker',
    expected: 'queued job cancelled; evidence purged across organizations; a job enqueued afterwards is cancelled with processing_restricted and contacts nothing; the refresh route answers 409',
    observed: JSON.stringify({
      evidenceBefore: evidenceBefore.length,
      restrictStatus: restrictResponse.status,
      cascade: { jobsCancelled: restrictBody.jobsCancelled, evidencePurged: restrictBody.evidencePurged },
      queuedJobStatus: cancelled?.status,
      evidenceAfter: evidenceAfter.length,
      postRestrictionJob: { status: postRestriction?.status, code: postRestriction?.last_error_code },
      requestsDuringGuardedRun,
      refreshStatus: refreshWhileRestricted.status,
      refreshBody: refreshWhileRestricted.body.error,
      workerCounters: { failed: run.body.failed, cancelled: run.body.cancelled },
      jobRunState: (await lastJobRunId())?.state,
    }),
    jobIds: [firstJob.body.jobId, queuedJob.body.jobId, 'adv-job-post-restriction'],
    logEvents: logEventsIn(id, 'enrichment'),
    pass: evidenceBefore.length === 1 && restrictResponse.status === 200
      && restrictBody.jobsCancelled >= 1 && restrictBody.evidencePurged === 1
      && cancelled?.status === 'cancelled' && evidenceAfter.length === 0
      && postRestriction?.status === 'cancelled' && postRestriction?.last_error_code === 'processing_restricted'
      && requestsDuringGuardedRun === 0
      && refreshWhileRestricted.status === 409 && refreshWhileRestricted.body.error === 'processing_restricted'
      // Regression: a privacy cancellation used to increment `failed`, which the run-worker route maps
      // to `job_runs.state = 'failed'` — so the most correct thing this worker does closed the run as a
      // failure and would trip any alert on failed runs.
      && run.body.cancelled === 1 && run.body.failed === 0,
  })
}

async function case10RetentionExpiry() {
  const id = '10'
  startCase(id, {})

  await owner`
    insert into enrichment_jobs (id, organization_id, builder_identity_id, requested_by_user_id, trigger, status, requested_connectors, submitted_urls, created_at, updated_at, finished_at)
    values ('adv-job-retention', ${IDS.org}, ${identityId('retention')}, ${IDS.user}, 'scheduled', 'succeeded', '["github"]'::jsonb, '[]'::jsonb, now() - interval '200 days', now(), now() - interval '200 days')
  `
  // One row per retention rule in runEnrichmentRetentionPass, plus one that must survive.
  const seedEvidence = async (suffix, resolution, observedAgo, expiresAt) => owner`
    insert into enrichment_evidence (
      id, organization_id, job_id, builder_identity_id, connector, acquisition_mode, source_url,
      content_hash, payload, confidence_bps, resolver_version, score_components, match_signals,
      contradictions, resolution, observed_at, expires_at, created_at
    ) values (
      gen_random_uuid(), ${IDS.org}, 'adv-job-retention', ${identityId('retention')}, 'github', 'official_api',
      ${`https://github.com/adv-retention-${suffix}`}, ${`adv-retention-hash-${suffix}`}, '{}'::jsonb, 7500, 1, '{}'::jsonb,
      '[]'::jsonb, '[]'::jsonb, ${resolution}, now() - ${observedAgo}::interval, now() + ${expiresAt}::interval, now()
    )
  `
  await seedEvidence('raw-expired', 'review', '40 days', '-1 day')
  await seedEvidence('rejected-expired', 'rejected', '10 days', '-1 day')
  await seedEvidence('accepted-expired', 'accepted', '200 days', '-1 day')
  await seedEvidence('accepted-live', 'accepted', '1 day', '179 days')

  const before = await evidenceRows('retention')
  const run = await runWorkerViaRoute()
  const after = await evidenceRows('retention')
  const oldJob = await jobRow('adv-job-retention')

  // The retention pass also has to leave nothing readable through the tenant API.
  const visible = await (await routes.evidenceGET({
    request: sessionRequest(sessionToken('retention'), 'https://adv.test/api/builders/x/evidence'),
    params: { builderId: identityId('retention') },
  })).json()

  // Second pass, after the one surviving row expires: the job it belongs to becomes deletable and
  // goes. This is the half that proves the retention fix converges rather than parking rows forever.
  await owner`update enrichment_evidence set expires_at = now() - interval '1 day' where builder_identity_id = ${identityId('retention')}`
  const secondRun = await runWorkerViaRoute()
  const afterSecond = await evidenceRows('retention')
  const oldJobAfterSecond = await jobRow('adv-job-retention')

  closeCase({
    id,
    title: 'retention expiry deletes expired evidence, and retires a job only once nothing references it',
    expected: 'pass 1: three expired rows deleted, the live accepted row kept, and the 200-day-old job KEPT because that row still points at it (deleting it would raise 23503 on enrichment_evidence_organization_job_fk). pass 2, after the last row expires: row deleted and the job retired',
    observed: JSON.stringify({
      before: before.length,
      pass1: { evidenceDeleted: run.body.retentionEvidenceDeleted, jobsDeleted: run.body.retentionJobsDeleted, remaining: after.map((row) => row.resolution), jobPresent: Boolean(oldJob), visibleThroughApi: visible.evidence?.length },
      pass2: { evidenceDeleted: secondRun.body.retentionEvidenceDeleted, jobsDeleted: secondRun.body.retentionJobsDeleted, remaining: afterSecond.length, jobPresent: Boolean(oldJobAfterSecond) },
      workerRunStates: { pass1: run.status, pass2: secondRun.status },
    }),
    jobIds: ['adv-job-retention'],
    logEvents: logEventsIn(id, 'enrichment_retention_run'),
    pass: before.length === 4
      && run.status === 200 && run.body.retentionEvidenceDeleted === 3 && run.body.retentionJobsDeleted === 0
      && after.length === 1 && after[0].resolution === 'accepted' && Boolean(oldJob) && visible.evidence?.length === 1
      && secondRun.status === 200 && secondRun.body.retentionEvidenceDeleted === 1
      && secondRun.body.retentionJobsDeleted === 1 && afterSecond.length === 0 && !oldJobAfterSecond,
  })
}

async function case11ExportAndDelete() {
  const id = '11'
  startCase(id, { 'api.github.com': { kind: 'json', body: githubUserBody(SUBJECTS.scripted) } })

  // Subject-side export: the verified claimant's provenance read, which is the only export path the
  // data subject has. It must be a minimized projection — field *names*, never values.
  const provenance = await routes.provenanceGET({
    request: sessionRequest(IDS.claimantToken, 'https://adv.test/api/me/builder/x/evidence-provenance'),
    params: { builderId: identityId('scripted') },
  })
  const provenanceBody = await provenance.json()

  // Organization-side read of the same data, through the app role, in tenant context — the live read
  // the tenant actually has.
  const principal = await routes.requireTenantPrincipal(sessionRequest(IDS.sessionToken, 'https://adv.test/api/builders/x/evidence'))
  const exported = await routes.withTenantContext(principal, (tx) => routes.listEnrichmentEvidence(tx, IDS.org, identityId('scripted')))

  // Organization-side *delete* through the app role: `builderhunt_app` holds SELECT+UPDATE on
  // enrichment_evidence and SELECT+INSERT on enrichment_jobs (drizzle/0017), so the role cannot
  // delete either table. Asserted directly against the grant rather than through a repository
  // helper: the two helpers that used to wrap this (`deleteOrganizationEnrichmentData`,
  // `listEnrichmentEvidenceForExport`) had no caller and were refused 42501 when this matrix first
  // called them, and were removed 2026-08-05 by decision. The grant is the thing worth pinning —
  // whatever code sits on top of it, an app-role delete must keep failing.
  let deleteOutcome = 'succeeded'
  try {
    await routes.withTenantContext(principal, (tx) => tx.execute(rawSql`delete from enrichment_evidence where organization_id = ${IDS.org}`))
  } catch (error) {
    // Drizzle wraps driver errors in DrizzleQueryError, so the SQLSTATE lives on `.cause`. Reading
    // `.code` alone reports the wrapper's message and loses the one fact worth recording.
    deleteOutcome = `refused:${error?.cause?.code ?? error?.code ?? error?.message}`
  }
  const survivingAfterAppDelete = (await owner`select count(*)::int as count from enrichment_evidence where organization_id = ${IDS.org}`)[0].count

  // The delete path that does work, and the one production actually depends on: the organization row
  // going away takes its enrichment data with it (ON DELETE CASCADE, schema.ts:1320).
  await owner`
    insert into organizations (id, name, slug, metadata, created_at) values ('adv-org-doomed', 'Doomed', 'adv-org-doomed', '{}', now())
  `
  await owner`
    insert into organization_builders (id, organization_id, builder_identity_id, creator_user_id, visibility, status, private_metadata, created_at, updated_at)
    values ('adv-tracked-doomed', 'adv-org-doomed', ${identityId('scripted')}, ${IDS.user}, 'private', 'tracked', '{}', now(), now())
  `
  await owner`
    insert into enrichment_jobs (id, organization_id, builder_identity_id, requested_by_user_id, trigger, status, requested_connectors, submitted_urls, created_at, updated_at)
    values ('adv-job-doomed', 'adv-org-doomed', ${identityId('scripted')}, ${IDS.user}, 'manual', 'succeeded', '["github"]'::jsonb, '[]'::jsonb, now(), now())
  `
  await owner`
    insert into enrichment_evidence (
      id, organization_id, job_id, builder_identity_id, connector, acquisition_mode, source_url,
      content_hash, payload, confidence_bps, resolver_version, score_components, match_signals,
      contradictions, resolution, observed_at, expires_at, created_at
    ) values (
      gen_random_uuid(), 'adv-org-doomed', 'adv-job-doomed', ${identityId('scripted')}, 'github', 'official_api',
      'https://github.com/adv-scripted', 'adv-doomed-hash', '{}'::jsonb, 7500, 1, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
      'review', now(), now() + interval '30 days', now()
    )
  `
  await owner`delete from organizations where id = 'adv-org-doomed'`
  const afterCascade = (await owner`
    select
      (select count(*)::int from enrichment_evidence where organization_id = 'adv-org-doomed') as evidence,
      (select count(*)::int from enrichment_jobs where organization_id = 'adv-org-doomed') as jobs
  `)[0]

  // Untracking one builder, through the real tenant repository. Same FK family as finding 1: both
  // `enrichment_evidence_organization_builder_fk` and `enrichment_jobs_organization_builder_fk`
  // (drizzle/0016) are ON DELETE NO ACTION, and this path deletes the `organization_builders` row the
  // pair points at. Organization *deletion* is safe because the cascade fires on both child tables in
  // the same statement; untracking a single builder deletes only the parent, which is exactly the shape
  // that broke the retention sweep. Checked here rather than assumed.
  const { deleteOrganizationBuilder } = await import('../../src/shared/lib/repositories/organization-builders.ts')
  let untrackOutcome
  try {
    const removed = await routes.withTenantContext(principal, (tx) => deleteOrganizationBuilder(tx, IDS.org, trackedId('scripted')))
    untrackOutcome = `returned:${removed}`
  } catch (error) {
    untrackOutcome = `threw:${error?.cause?.code ?? error?.code ?? error?.message}`
  }
  const evidenceAfterUntrack = (await owner`
    select count(*)::int as count from enrichment_evidence
    where organization_id = ${IDS.org} and builder_identity_id = ${identityId('scripted')}
  `)[0].count

  const leaksValues = JSON.stringify(provenanceBody).includes('Public profile fixture')
  closeCase({
    id,
    title: 'export and delete requests',
    expected: 'subject provenance exports field names only; the tenant read works through the app role; an app-role delete is refused 42501 by the grant; deleting the organization cascades the data away',
    observed: JSON.stringify({
      provenanceStatus: provenance.status,
      provenanceEntries: Array.isArray(provenanceBody.provenance) ? provenanceBody.provenance.length : provenanceBody,
      provenanceLeaksPayloadValues: leaksValues,
      organizationExportRows: exported.length,
      organizationDelete: deleteOutcome,
      rowsSurvivingAppDelete: survivingAfterAppDelete,
      afterOrganizationCascade: afterCascade,
      untrackBuilderWithEvidence: untrackOutcome,
      evidenceAfterUntrack,
    }),
    logEvents: logEventsIn(id),
    pass: provenance.status === 200 && !leaksValues && exported.length >= 1
      && deleteOutcome.startsWith('refused:42501')
      && afterCascade.evidence === 0 && afterCascade.jobs === 0,
  })

  record(
    '11 untracking a builder that has enrichment evidence does not blow up on the composite FK',
    untrackOutcome === 'returned:true',
    JSON.stringify({ untrackOutcome, evidenceAfterUntrack }),
  )
}

async function case12KillSwitch() {
  const id = '12'
  startCase(id, {})

  // A job left queued for the child to find, so "the worker did nothing" is a measurement rather
  // than an absence of input.
  await owner`
    insert into enrichment_jobs (id, organization_id, builder_identity_id, requested_by_user_id, trigger, status, requested_connectors, submitted_urls, created_at, updated_at)
    values ('adv-job-killswitch', ${IDS.org}, ${identityId('killswitch')}, ${IDS.user}, 'scheduled', 'queued', '["github"]'::jsonb, '[]'::jsonb, now(), now())
  `

  const child = await new Promise((resolve) => {
    const proc = spawn('pnpm', ['exec', 'tsx', SELF, '--kill-switch-child'], {
      env: { ...process.env, ENRICHMENT_ENABLED: 'false', ADVERSARIAL_LIVE_GITHUB: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (chunk) => { out += chunk })
    proc.stderr.on('data', (chunk) => { err += chunk })
    proc.on('close', (code) => {
      const line = out.split('\n').find((entry) => entry.startsWith('ADV_CHILD_RESULT '))
      resolve({ code, parsed: line ? JSON.parse(line.slice('ADV_CHILD_RESULT '.length)) : null, err: err.slice(-800) })
    })
  })

  const job = await jobRow('adv-job-killswitch')
  const parsed = child.parsed

  closeCase({
    id,
    title: 'kill switch: a process with ENRICHMENT_ENABLED=false does nothing at all',
    expected: 'worker returns disabled with every counter at zero; the enqueue route answers 503; the queued job is untouched; no request leaves the process',
    observed: JSON.stringify({ childExit: child.code, child: parsed, queuedJobStillQueued: job?.status, stderrTail: parsed ? undefined : child.err }),
    jobIds: ['adv-job-killswitch'],
    logEvents: logEventsIn(id),
    pass: Boolean(parsed) && parsed.workerDisabled === true && parsed.claimed === 0
      && parsed.refreshStatus === 503 && parsed.refreshError === 'enrichment_disabled'
      && parsed.requestsMade === 0 && job?.status === 'queued',
  })
}

// ── child entry point (case 12) ──────────────────────────────────────────────────────────────────

async function runKillSwitchChild() {
  await loadRoutes()
  startCase('12-child', {})
  const before = contacted.length
  const outcome = await routes.runEnrichmentWorker()
  const refresh = await enqueue('killswitch')
  console.log(`ADV_CHILD_RESULT ${JSON.stringify({
    workerDisabled: outcome.disabled,
    claimed: outcome.claimed,
    processed: outcome.processed,
    refreshStatus: refresh.status,
    refreshError: refresh.body.error,
    requestsMade: contacted.length - before,
  })}`)
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  if (CHILD_MODE) {
    await runKillSwitchChild()
    return
  }

  await seed()
  await loadRoutes()

  await case01ScriptedSuccess()
  await case01LiveSuccess()
  await case02BlockedHost()
  await case03RobotsDenial()
  await case04Challenge()
  await case05RateLimited()
  await case06Timeout()
  await case07OverlappingJobs()
  await case08CrashAndReclaim()
  await case09RestrictionMidFlight()
  await case10RetentionExpiry()
  await case11ExportAndDelete()
  await case12KillSwitch()

  // The register's cross-cutting claim, over every request the process made from first import to last.
  const blockedHostPattern = /linkedin\.|(^|\.)x\.com$|twitter\.|facebook\.|instagram\./
  const blockedContacts = contacted.filter((entry) => blockedHostPattern.test(entry.host))
  record('cross-cutting: zero requests to a blocked host, across all twelve cases', blockedContacts.length === 0, JSON.stringify(blockedContacts))

  const unscripted = contacted.filter((entry) => entry.transport === 'unscripted')
  record('cross-cutting: no request left the process to a host no case declared', unscripted.length === 0, JSON.stringify(unscripted))

  const failed = results.filter((result) => !result.pass)
  const report = {
    ranAt: new Date().toISOString(),
    liveGithub: LIVE_GITHUB,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    hostsContacted: [...new Set(contacted.map((entry) => entry.host))],
    requestsByTransport: contacted.reduce((acc, entry) => ({ ...acc, [entry.transport]: (acc[entry.transport] ?? 0) + 1 }), {}),
    matrix: evidenceLog,
    results,
  }

  // The report goes to a file rather than stdout because the process under test *is* the thing
  // writing to stdout: `log.info` emits one JSON object per line, so a report printed there arrives
  // interleaved with the very log lines it cites and no parser can read it back.
  const out = process.env.MATRIX_OUT
  if (out) {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  }
  console.log(`\n[matrix] ${report.passed}/${report.total} checks passed; hosts contacted: ${report.hostsContacted.join(', ') || 'none'}`)
  for (const result of failed) console.log(`[matrix] FAILED  ${result.name}\n          ${result.detail}`)
  if (out) console.log(`[matrix] full evidence written to ${out}`)
  if (failed.length > 0) process.exitCode = 1
}

try {
  await main()
} finally {
  await owner.end({ timeout: 5 })
}

// Route handlers open their own pooled connections (authDb, workerDb, platformDb) that this script
// never owns and cannot close; the event loop will not drain with those sockets open. Same exit
// discipline as verify-api-isolation-local.mjs.
process.exit(process.exitCode ?? 0)
