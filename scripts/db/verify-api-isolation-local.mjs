// Two-tenant isolation check that exercises REAL route handlers (not mocks)
// against a disposable local Postgres, connected through the exact
// non-owner runtime roles (builderhunt_app / builderhunt_worker / builderhunt_auth)
// so RLS is genuinely enforced end-to-end — the same failure mode a bug in
// `withTenantContext`/RLS policy would actually produce in production.
//
// Scope: saved-queries, organization-alerts, builder tracking/notes/claim,
// sprints (list/detail/results), builder enrichment/evidence, the entitlement
// read (`/api/plans/me`), builder export, organization team/members, admin
// content management (changelog/incidents/roadmap/users), dashboard stats/
// recent-builders/recommendations, subject-only `/api/me/**` routes
// (data-export, delete-account, verified builder claims, evidence-provenance,
// restrict-processing, org-tracked builders), the two grant-only public
// tables (builder_embeddings, discovery_state), account-export privacy,
// alerts-worker cross-organization isolation, the legal/run-worker
// pending-deletion sweep (real hard-delete, own/other-due-date matrix), the
// platform-admin abuse console (`/api/admin/abuse`, `/api/admin/abuse/clusters`
// — non-admin rejection plus confirming a manual action lands on the targeted
// user, not the admin caller), and `/api/me/sessions` cross-user isolation. Still
// not the full ~34-route inventory in src/routes/api/** — the alerts/
// discovery/embeddings/enrichment/sprints run-worker endpoints (all call a
// live external network search/embedding/enrichment provider) and a couple
// of read-only public routes (changelog/roadmap public GETs, status,
// incidents public feed) remain uncovered; every route in the full inventory
// does have a verified auth guard per scripts/check-route-coverage.mjs, so
// any remaining gap is test breadth, not missing guards. Routes that only
// front a live external network call (search, sprint preview) are exercised
// via the tenant-scoped logic they actually own (e.g. the tracked-annotation
// map) rather than the full HTTP handler, to keep this fast and deterministic.
//
// Required env (set by the caller before running):
//   DATABASE_URL             -> builderhunt_app role connection
//   DATABASE_AUTH_URL        -> builderhunt_auth role connection
//   DATABASE_WORKER_URL      -> builderhunt_worker role connection
//   DATABASE_PLATFORM_URL    -> builderhunt_platform role connection
//   OWNER_SEED_URL           -> postgres owner connection, for fixture setup only
//   APP_URL, VITE_APP_URL, BETTER_AUTH_SECRET
//
// Refuses to run unless every URL's database name matches
// builderhunt_security_test_* — never point this at a real database.

import postgres from 'postgres'
import { createHmac } from 'node:crypto'

const requiredEnv = ['DATABASE_URL', 'DATABASE_AUTH_URL', 'DATABASE_WORKER_URL', 'DATABASE_PLATFORM_URL', 'OWNER_SEED_URL']
for (const key of requiredEnv) {
  if (!process.env[key]) throw new Error(`${key} is required`)
}
for (const key of requiredEnv) {
  const databaseName = new URL(process.env[key]).pathname.slice(1)
  if (!/^builderhunt_security_test_[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error(`API isolation verifier refuses to run outside a named builderhunt_security_test database (${key})`)
  }
}

// `env.ts` parses `process.env` once at module load and freezes the result,
// so this must be set before anything (even transitively) imports it —
// i.e. before the first dynamic `import()` of a route handler below.
process.env.ENRICHMENT_ENABLED = 'true'

const owner = postgres(process.env.OWNER_SEED_URL, { max: 1, prepare: false })

const IDS = {
  orgA: 'iso-org-a',
  orgB: 'iso-org-b',
  userA: 'iso-user-a',
  userB: 'iso-user-b',
  queryA: 'iso-query-a',
  queryB: 'iso-query-b',
  alertA: 'iso-alert-a',
  alertB: 'iso-alert-b',
  identityA: 'iso-identity-a',
  identityB: 'iso-identity-b',
  trackedA: 'iso-tracked-a',
  trackedB: 'iso-tracked-b',
  legacyBuilderA: 'iso-legacy-builder-a',
  legacyBuilderB: 'iso-legacy-builder-b',
  sprintA: 'iso-sprint-a',
  sprintB: 'iso-sprint-b',
  sprintResultA: 'iso-sprint-result-a',
  enrichmentJobA: 'iso-enrichment-job-a',
  evidenceA: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa',
  recsQueryA: 'iso-recs-query-a',
}

async function seed() {
  await owner`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values
      (${IDS.userA}, 'Iso A', 'iso-a@test.invalid', true, now(), now()),
      (${IDS.userB}, 'Iso B', 'iso-b@test.invalid', true, now(), now())
  `
  await owner`
    insert into organizations (id, name, slug, metadata, created_at)
    values (${IDS.orgA}, 'Iso A', 'iso-org-a', '{}', now()), (${IDS.orgB}, 'Iso B', 'iso-org-b', '{}', now())
  `
  await owner`
    insert into organization_members (id, organization_id, user_id, role, created_at)
    values (${IDS.orgA + ':owner'}, ${IDS.orgA}, ${IDS.userA}, 'owner', now()),
           (${IDS.orgB + ':owner'}, ${IDS.orgB}, ${IDS.userB}, 'owner', now())
  `
  await owner`
    insert into auth_sessions (id, user_id, active_organization_id, token, expires_at, created_at, updated_at)
    values
      ('iso-session-a', ${IDS.userA}, ${IDS.orgA}, 'iso-session-token-a', now() + interval '1 day', now(), now()),
      ('iso-session-b', ${IDS.userB}, ${IDS.orgB}, 'iso-session-token-b', now() + interval '1 day', now(), now())
  `
  await owner`
    insert into saved_queries (id, organization_id, user_id, name, keywords, sources, created_at)
    values
      (${IDS.queryA}, ${IDS.orgA}, ${IDS.userA}, 'Query A', '["rust"]'::jsonb, '["github"]'::jsonb, now()),
      (${IDS.queryB}, ${IDS.orgB}, ${IDS.userB}, 'Query B', '["python"]'::jsonb, '["github"]'::jsonb, now())
  `
  await owner`
    insert into builder_identities (id, source, source_id, username, profile_url, created_at, updated_at)
    values
      (${IDS.identityA}, 'github', 'iso-a', 'iso-a', 'https://github.com/iso-a', now(), now()),
      (${IDS.identityB}, 'github', 'iso-b', 'iso-b', 'https://github.com/iso-b', now(), now())
  `
  await owner`
    insert into organization_builders (
      id, organization_id, builder_identity_id, creator_user_id, visibility, status, private_metadata, created_at, updated_at
    ) values
      (${IDS.trackedA}, ${IDS.orgA}, ${IDS.identityA}, ${IDS.userA}, 'private', 'tracked', '{}', now(), now()),
      (${IDS.trackedB}, ${IDS.orgB}, ${IDS.identityB}, ${IDS.userB}, 'private', 'tracked', '{}', now(), now())
  `
  // Legacy `builders` rows + `alerts` rows: the alerts worker (src/lib/alerts/worker.ts)
  // still reads the legacy per-user `builders` table, not `organization_builders`.
  await owner`
    insert into builders (
      id, organization_id, user_id, source, source_id, username, profile_url, last_seen, created_at, updated_at
    ) values
      (${IDS.legacyBuilderA}, ${IDS.orgA}, ${IDS.userA}, 'github', 'iso-legacy-a', 'iso-legacy-a', 'https://github.com/iso-legacy-a', now(), now(), now()),
      (${IDS.legacyBuilderB}, ${IDS.orgB}, ${IDS.userB}, 'github', 'iso-legacy-b', 'iso-legacy-b', 'https://github.com/iso-legacy-b', now(), now(), now())
  `
  // `builder_notes.builder_id` still FKs to the legacy `builders` table, not
  // `organization_builders` (the identity split never repointed it) — real
  // production rows satisfy this because `trackOrganizationBuilder` always
  // dual-writes both tables under the *same* id. Mirror that invariant here
  // so the tracked-builder id (used by /api/builders/$builderId/notes) is
  // legal, instead of masking a real FK requirement.
  await owner`
    insert into builders (
      id, organization_id, user_id, source, source_id, username, profile_url, last_seen, created_at, updated_at
    ) values
      (${IDS.trackedA}, ${IDS.orgA}, ${IDS.userA}, 'github', 'iso-a', 'iso-a', 'https://github.com/iso-a', now(), now(), now()),
      (${IDS.trackedB}, ${IDS.orgB}, ${IDS.userB}, 'github', 'iso-b', 'iso-b', 'https://github.com/iso-b', now(), now(), now())
  `
  await owner`
    insert into alerts (id, organization_id, user_id, name, keywords, enabled, trigger_conditions, delivery_channel, created_at)
    values
      (${IDS.alertA}, ${IDS.orgA}, ${IDS.userA}, 'Alert A', '[]'::jsonb, true,
       ${owner.json({ eventType: 'any_activity', builderId: IDS.legacyBuilderA })}, 'dashboard', now() - interval '1 hour'),
      (${IDS.alertB}, ${IDS.orgB}, ${IDS.userB}, 'Alert B', '[]'::jsonb, true,
       ${owner.json({ eventType: 'any_activity', builderId: IDS.legacyBuilderB })}, 'dashboard', now() - interval '1 hour')
  `
  await owner`
    insert into sourcing_sprints (id, organization_id, creator_user_id, name, criteria, variants, status, quota, cursor, created_at)
    values
      (${IDS.sprintA}, ${IDS.orgA}, ${IDS.userA}, 'Sprint A', '{}'::jsonb, '[]'::jsonb, 'active', 200, '{"variantIndex":0,"page":1}'::jsonb, now()),
      (${IDS.sprintB}, ${IDS.orgB}, ${IDS.userB}, 'Sprint B', '{}'::jsonb, '[]'::jsonb, 'active', 200, '{"variantIndex":0,"page":1}'::jsonb, now())
  `
  await owner`
    insert into sprint_results (id, organization_id, sprint_id, source, source_id, profile, matched_variant, score, created_at)
    values (${IDS.sprintResultA}, ${IDS.orgA}, ${IDS.sprintA}, 'github', 'iso-sprint-result-a', '{}'::jsonb, 'v1', 80, now())
  `
  // Enrichment/evidence FK to (organization_id, builder_identity_id) on
  // organization_builders — reuses trackedA/identityA seeded above.
  await owner`
    insert into enrichment_jobs (
      id, organization_id, builder_identity_id, requested_by_user_id, trigger, status,
      requested_connectors, submitted_urls, created_at, updated_at
    ) values (
      ${IDS.enrichmentJobA}, ${IDS.orgA}, ${IDS.identityA}, ${IDS.userA}, 'manual', 'succeeded',
      '[]'::jsonb, '[]'::jsonb, now(), now()
    )
  `
  await owner`
    insert into enrichment_evidence (
      id, organization_id, job_id, builder_identity_id, connector, acquisition_mode, source_url,
      content_hash, payload, confidence_bps, resolver_version, score_components, match_signals,
      contradictions, resolution, observed_at, expires_at, created_at
    ) values (
      ${IDS.evidenceA}, ${IDS.orgA}, ${IDS.enrichmentJobA}, ${IDS.identityA}, 'github', 'public_api',
      'https://github.com/iso-a', 'iso-evidence-hash-a', ${owner.json({})}, 9000, 1, ${owner.json({})},
      '[]'::jsonb, '[]'::jsonb, 'review', now(), now() + interval '30 days', now()
    )
  `
  // `recsQueryA` is NOT seeded here — checkRecommendationsScoping inserts it
  // itself, lazily, right before it runs. Seeding it up front would give org
  // A two saved_queries rows for the whole run, breaking checkSavedQueries'
  // "A sees only A's query" (length === 1) assertion, which runs earlier.
}

// better-auth signs the session_token cookie with HMAC-SHA256(secret, token)
// and rejects unsigned values outright (see better-call's getSignedCookie) —
// a plain token cookie silently resolves to "no session", not an error.
function signedSessionCookie(token) {
  const secret = process.env.BETTER_AUTH_SECRET
  const signature = createHmac('sha256', secret).update(token).digest('base64')
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`
}

function sessionRequest(token, url, init = {}) {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      cookie: signedSessionCookie(token),
      'x-request-id': crypto.randomUUID(),
    },
  })
}

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
}

async function checkSavedQueries() {
  const { Route } = await import('../../src/routes/api/queries/index.ts')
  const { GET, DELETE } = Route.options.server.handlers

  const listA = await (await GET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/queries') })).json()
  record('saved-queries: A sees only A\'s query', Array.isArray(listA) && listA.length === 1 && listA[0].id === IDS.queryA, JSON.stringify(listA.map((q) => q.id)))

  const listB = await (await GET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/queries') })).json()
  record('saved-queries: B sees only B\'s query', Array.isArray(listB) && listB.length === 1 && listB[0].id === IDS.queryB, JSON.stringify(listB.map((q) => q.id)))

  const deleteOther = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/queries', {
      method: 'DELETE',
      body: JSON.stringify({ id: IDS.queryB }),
    }),
  })
  record('saved-queries: A cannot delete B\'s query (other id)', deleteOther.status === 404, `status=${deleteOther.status}`)

  const deleteRandom = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/queries', {
      method: 'DELETE',
      body: JSON.stringify({ id: 'nonexistent-random-id' }),
    }),
  })
  record('saved-queries: A cannot delete a random id', deleteRandom.status === 404, `status=${deleteRandom.status}`)

  const deleteOwn = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/queries', {
      method: 'DELETE',
      body: JSON.stringify({ id: IDS.queryA }),
    }),
  })
  const deleteOwnBody = await deleteOwn.json()
  record('saved-queries: A can delete A\'s own query', deleteOwn.status === 200 && deleteOwnBody.success === true, JSON.stringify(deleteOwnBody))
}

async function checkAlerts() {
  const { Route } = await import('../../src/routes/api/alerts/index.ts')
  const { GET, DELETE } = Route.options.server.handlers

  // `PageResult`, not an array, since plans/phase-3/10 put the radar list on a keyset page. This probe
  // read `listA.map` and crashed the whole script — a guard that only knew the old spelling.
  const pageA = await (await GET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/alerts') })).json()
  const listA = pageA.rows ?? []
  record('alerts: A sees only A\'s alert', Array.isArray(listA) && listA.length === 1 && listA[0].id === IDS.alertA, JSON.stringify(listA.map((a) => a.id)))

  const deleteOther = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/alerts', {
      method: 'DELETE',
      body: JSON.stringify({ id: IDS.alertB }),
    }),
  })
  record('alerts: A cannot delete B\'s alert (other id)', deleteOther.status === 404, `status=${deleteOther.status}`)

  const deleteRandom = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/alerts', {
      method: 'DELETE',
      body: JSON.stringify({ id: 'nonexistent-random-id' }),
    }),
  })
  record('alerts: A cannot delete a random id', deleteRandom.status === 404, `status=${deleteRandom.status}`)
}

async function checkBuilderTracking() {
  const { Route } = await import('../../src/routes/api/builders/$builderId.ts')
  const { PATCH, DELETE } = Route.options.server.handlers

  const patchOther = await PATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x', {
      method: 'PATCH',
      body: JSON.stringify({ country: 'US' }),
    }),
    params: { builderId: IDS.trackedB },
  })
  record('builder tracking: A cannot patch B\'s tracked row (other id)', patchOther.status === 404, `status=${patchOther.status}`)

  const patchRandom = await PATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x', {
      method: 'PATCH',
      body: JSON.stringify({ country: 'US' }),
    }),
    params: { builderId: 'nonexistent-random-id' },
  })
  record('builder tracking: A cannot patch a random id', patchRandom.status === 404, `status=${patchRandom.status}`)

  const patchOwn = await PATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x', {
      method: 'PATCH',
      body: JSON.stringify({ country: 'US' }),
    }),
    params: { builderId: IDS.trackedA },
  })
  record('builder tracking: A can patch A\'s own tracked row', patchOwn.status === 200, `status=${patchOwn.status}`)

  const deleteOther = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x', { method: 'DELETE' }),
    params: { builderId: IDS.trackedB },
  })
  record('builder tracking: A cannot delete B\'s tracked row', deleteOther.status === 404, `status=${deleteOther.status}`)
}

async function checkBuilderNotes() {
  const { Route } = await import('../../src/routes/api/builders/$builderId/notes.ts')
  const { GET, POST } = Route.options.server.handlers

  const createOnOther = await POST({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/notes', {
      method: 'POST',
      body: JSON.stringify({ content: 'should not land in org B' }),
    }),
    params: { builderId: IDS.trackedB },
  })
  record('builder notes: A cannot create a note on B\'s tracked row', createOnOther.status === 404, `status=${createOnOther.status}`)

  const createOwn = await POST({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/notes', {
      method: 'POST',
      body: JSON.stringify({ content: 'A\'s own note' }),
    }),
    params: { builderId: IDS.trackedA },
  })
  record('builder notes: A can create a note on A\'s own tracked row', createOwn.status === 200, `status=${createOwn.status}`)

  const listOther = await (await GET({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/notes'),
    params: { builderId: IDS.trackedB },
  })).json()
  record('builder notes: A sees no notes on B\'s tracked row', Array.isArray(listOther) && listOther.length === 0, JSON.stringify(listOther))

  const listOwn = await (await GET({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/notes'),
    params: { builderId: IDS.trackedA },
  })).json()
  record('builder notes: A sees A\'s own note', Array.isArray(listOwn) && listOwn.length === 1 && listOwn[0].content === 'A\'s own note', JSON.stringify(listOwn))
}

// Both search routes only annotate global (public) search results with a
// per-org `tracked`/`trackedRowId` flag via getTrackedBuilderIds — they don't
// otherwise touch tenant-private tables. The results themselves come from
// live external APIs (GitHub, HN, etc.), so exercising the full HTTP routes
// here would be slow/flaky and net-dependent. This tests the actual scoping
// logic those routes share directly against the disposable DB instead.
async function checkSearchTrackedAnnotationScoping() {
  const { requireTenantPrincipal } = await import('../../src/shared/lib/auth/tenant-principal.ts')
  const { withTenantContext } = await import('../../src/shared/lib/db/tenant-context.ts')
  const { getTrackedBuilderIds, trackedKey } = await import('../../src/shared/lib/tracked-builders.ts')

  const principalA = await requireTenantPrincipal(sessionRequest('iso-session-token-a', 'https://iso.test/api/search/builders'))
  const trackedA = await withTenantContext(principalA, (tx) => getTrackedBuilderIds(tx, principalA.organizationId))
  record(
    'search annotation: org A\'s tracked-id map has A\'s identity but not B\'s',
    trackedA.has(trackedKey('github', 'iso-a')) && !trackedA.has(trackedKey('github', 'iso-b')),
    JSON.stringify(Array.from(trackedA.keys())),
  )

  const principalB = await requireTenantPrincipal(sessionRequest('iso-session-token-b', 'https://iso.test/api/search/builders'))
  const trackedB = await withTenantContext(principalB, (tx) => getTrackedBuilderIds(tx, principalB.organizationId))
  record(
    'search annotation: org B\'s tracked-id map has B\'s identity but not A\'s',
    trackedB.has(trackedKey('github', 'iso-b')) && !trackedB.has(trackedKey('github', 'iso-a')),
    JSON.stringify(Array.from(trackedB.keys())),
  )
}

// `builder_embeddings` and `discovery_state` are global non-tenant tables
// (no organization_id, no RLS) written/read exclusively through `publicDb`
// (== `env.DATABASE_URL` == the app role in production) from the
// semantic-search write-through pipeline and the proactive-discovery worker
// respectively. Both had zero grants for `builderhunt_app` in any migration
// until drizzle/0025_public_tables_app_grants.sql — every write from every
// search/track request, and the entire discovery worker, silently failed
// and was swallowed by a try/catch. This check exists purely to keep that
// fixed: not a tenant-isolation property (nothing here is org-scoped), just
// "the app role can actually read and write its own public tables."
async function checkPublicNonTenantTableGrants() {
  const { upsertBuilderEmbeddingStub, findPendingBuilderEmbeddings } = await import('../../src/shared/lib/repositories/public-builder-embeddings.ts')
  const stubSourceId = 'iso-embedding-smoke'
  await upsertBuilderEmbeddingStub({
    source: 'github',
    sourceId: stubSourceId,
    document: 'iso smoke-test document',
    contentHash: 'iso-smoke-hash',
    profile: { username: stubSourceId, source: 'github', sourceId: stubSourceId },
  })
  const pending = await findPendingBuilderEmbeddings(1000)
  record(
    'builder_embeddings: app role can insert and read back its own stub row',
    pending.some((row) => row.id && row.document === 'iso smoke-test document'),
    JSON.stringify(pending.find((row) => row.document === 'iso smoke-test document') ?? null),
  )

  const { getDiscoveryState } = await import('../../src/shared/lib/repositories/discovery-state.ts')
  const { publicDb } = await import('../../src/shared/lib/db/client.ts')
  const { discoveryState } = await import('../../src/shared/lib/db/schema.ts')
  const { eq } = await import('drizzle-orm')
  await publicDb.insert(discoveryState).values({ id: 'default', cursor: 0 }).onConflictDoNothing()
  await publicDb.update(discoveryState).set({ cursor: 7 }).where(eq(discoveryState.id, 'default'))
  const state = await getDiscoveryState()
  record('discovery_state: app role can insert, update, and read the singleton row', state?.cursor === 7, JSON.stringify(state))
}

async function checkSprints() {
  const { Route: ListRoute } = await import('../../src/routes/api/sprints/index.ts')
  const { GET: listGET } = ListRoute.options.server.handlers

  // Also a `PageResult` since plans/phase-3/10.
  const sprintPageA = await (await listGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/sprints') })).json()
  const listA = sprintPageA.rows ?? []
  record('sprints: A sees only A\'s sprint', Array.isArray(listA) && listA.length === 1 && listA[0].id === IDS.sprintA, JSON.stringify(listA.map((s) => s.id)))

  const { Route: DetailRoute } = await import('../../src/routes/api/sprints/$sprintId.ts')
  const { GET, PATCH, DELETE } = DetailRoute.options.server.handlers

  const getOther = await GET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/sprints/x'), params: { sprintId: IDS.sprintB } })
  record('sprints: A cannot GET B\'s sprint (other id)', getOther.status === 404, `status=${getOther.status}`)

  const getRandom = await GET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/sprints/x'), params: { sprintId: 'nonexistent-random-id' } })
  record('sprints: A cannot GET a random sprint id', getRandom.status === 404, `status=${getRandom.status}`)

  const getOwn = await GET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/sprints/x'), params: { sprintId: IDS.sprintA } })
  record('sprints: A can GET A\'s own sprint', getOwn.status === 200, `status=${getOwn.status}`)

  const patchOther = await PATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/sprints/x', { method: 'PATCH', body: JSON.stringify({ name: 'hijacked' }) }),
    params: { sprintId: IDS.sprintB },
  })
  record('sprints: A cannot PATCH B\'s sprint (other id)', patchOther.status === 404, `status=${patchOther.status}`)

  const deleteOther = await DELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/sprints/x', { method: 'DELETE' }),
    params: { sprintId: IDS.sprintB },
  })
  record('sprints: A cannot DELETE B\'s sprint (other id)', deleteOther.status === 404, `status=${deleteOther.status}`)

  const { Route: ResultsRoute } = await import('../../src/routes/api/sprints/$sprintId/results.ts')
  const { GET: resultsGET } = ResultsRoute.options.server.handlers

  const resultsOther = await resultsGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/sprints/x/results'), params: { sprintId: IDS.sprintB } })
  record('sprints: A cannot read B\'s sprint results (other id)', resultsOther.status === 404, `status=${resultsOther.status}`)

  const resultsOwn = await (await resultsGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/sprints/x/results'), params: { sprintId: IDS.sprintA } })).json()
  // `rows`, not `items`: plans/phase-3/07 replaced the hand-rolled envelope with `PageResult`.
  record('sprints: A sees A\'s own sprint result', Array.isArray(resultsOwn.rows) && resultsOwn.rows.length === 1, JSON.stringify(resultsOwn))
}

async function checkEnrichmentAndEvidence() {
  const { Route: EnrichmentRoute } = await import('../../src/routes/api/builders/$builderId/enrichment.ts')
  const { GET: enrichmentGET } = EnrichmentRoute.options.server.handlers

  const getOther = await enrichmentGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/enrichment'), params: { builderId: IDS.identityB } })
  record('enrichment: A cannot fetch enrichment for B\'s tracked identity (other id)', getOther.status === 404, `status=${getOther.status}`)

  const getRandom = await enrichmentGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/enrichment'), params: { builderId: 'nonexistent-random-id' } })
  record('enrichment: A cannot fetch enrichment for a random identity', getRandom.status === 404, `status=${getRandom.status}`)

  const getOwn = await enrichmentGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/enrichment'), params: { builderId: IDS.identityA } })
  const getOwnBody = await getOwn.json()
  record('enrichment: A can fetch A\'s own tracked identity (insufficient signal, no AI call)', getOwn.status === 200 && getOwnBody.insufficient === true, JSON.stringify(getOwnBody))

  const { Route: EvidenceListRoute } = await import('../../src/routes/api/builders/$builderId/evidence/index.ts')
  const { GET: evidenceListGET } = EvidenceListRoute.options.server.handlers

  const evidenceOther = await (await evidenceListGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/builders/x/evidence'), params: { builderId: IDS.identityA } })).json()
  record('evidence: B\'s org has no evidence rows for A\'s identity', Array.isArray(evidenceOther.evidence) && evidenceOther.evidence.length === 0, JSON.stringify(evidenceOther))

  const evidenceOwn = await (await evidenceListGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/evidence'), params: { builderId: IDS.identityA } })).json()
  record('evidence: A sees A\'s own evidence', Array.isArray(evidenceOwn.evidence) && evidenceOwn.evidence.length === 1 && evidenceOwn.evidence[0].id === IDS.evidenceA, JSON.stringify(evidenceOwn))

  const { Route: EvidenceReviewRoute } = await import('../../src/routes/api/builders/$builderId/evidence/$evidenceId.ts')
  const { PATCH: evidencePATCH } = EvidenceReviewRoute.options.server.handlers

  const reviewByB = await evidencePATCH({
    request: sessionRequest('iso-session-token-b', 'https://iso.test/api/builders/x/evidence/x', { method: 'PATCH', body: JSON.stringify({ resolution: 'accepted' }) }),
    params: { builderId: IDS.identityA, evidenceId: IDS.evidenceA },
  })
  record('evidence: B (org B owner) cannot review A\'s evidence (other org)', reviewByB.status === 404, `status=${reviewByB.status}`)

  const reviewByA = await evidencePATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/evidence/x', { method: 'PATCH', body: JSON.stringify({ resolution: 'accepted' }) }),
    params: { builderId: IDS.identityA, evidenceId: IDS.evidenceA },
  })
  record('evidence: A (org A owner) can review A\'s own evidence', reviewByA.status === 200, `status=${reviewByA.status}`)

  const { Route: RefreshRoute } = await import('../../src/routes/api/builders/$builderId/evidence-refresh.ts')
  const { POST: refreshPOST } = RefreshRoute.options.server.handlers

  const refreshOther = await refreshPOST({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/evidence-refresh', {
      method: 'POST',
      body: JSON.stringify({ connectors: ['github'], submittedUrls: [] }),
    }),
    params: { builderId: IDS.identityB },
  })
  record('evidence-refresh: A cannot enqueue a job for B\'s tracked identity (other id)', refreshOther.status === 404, `status=${refreshOther.status}`)
}

/**
 * The claim flow, as it exists after `8befb8a` ("source-bound claimable-profile verification").
 *
 * That commit removed the email step deliberately: an app-session email matching text the user typed
 * proves nothing about controlling the *external* GitHub account being claimed. Starting a claim now
 * mints a public challenge string, and the proof step is `POST /api/builders/:id/claim/verify`, which
 * checks the challenge is actually live in that account's bio.
 *
 * This block asserted the old contract (a `devLink` carrying a token, redeemed through
 * `GET /api/builders/claim/verify?token=`) and had been failing since 2026-07-26 — invisibly, because
 * the workflow itself was rejected before any job ran. Nothing was wrong with the product: new claims
 * store `verificationSecretHash: null`, so that legacy GET can no longer match anything, by design.
 *
 * What is under test here is isolation, not the claim mechanics (those have their own tests). So the
 * proof step's one unavoidable network call — a real request to api.github.com for an account that
 * does not exist — is stubbed, and the assertions stay focused on subject boundaries: A can claim A's
 * identity, B cannot redeem A's pending claim, A can complete their own.
 */
async function checkBuilderClaim() {
  const { Route: ClaimRoute } = await import('../../src/routes/api/builders/$builderId/claim.ts')
  const { POST } = ClaimRoute.options.server.handlers

  const claimResp = await POST({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/x/claim', {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    params: { builderId: IDS.identityA },
  })
  const claimBody = await claimResp.json()
  record(
    'claim: A can start a claim on A\'s own identity and gets a challenge to publish',
    claimResp.status === 200 && claimBody.ok === true && typeof claimBody.challenge === 'string' && claimBody.challenge.length > 0,
    JSON.stringify(claimBody),
  )

  const { Route: SourceVerifyRoute } = await import('../../src/routes/api/builders/$builderId/claim/verify.ts')
  const { POST: verifyPOST } = SourceVerifyRoute.options.server.handlers

  // B holds no pending claim on A's identity, so there is nothing for B to complete. This is the
  // isolation property the old "B cannot verify A's token" check was really about.
  const verifyByB = await verifyPOST({
    request: sessionRequest('iso-session-token-b', `https://iso.test/api/builders/${IDS.identityA}/claim/verify`, { method: 'POST' }),
    params: { builderId: IDS.identityA },
  })
  const verifyByBBody = await verifyByB.json()
  record(
    'claim: B cannot complete A\'s pending claim (no pending claim of B\'s own)',
    verifyByB.status === 404 && verifyByBBody.error === 'no_pending_claim',
    `status=${verifyByB.status} body=${JSON.stringify(verifyByBBody)}`,
  )

  // Stand in for the claimant having published the challenge in their bio. Scoped to the one
  // api.github.com user lookup the adapter makes; everything else falls through to the real fetch,
  // and it is restored immediately afterwards so no later check runs against a patched global.
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input)
    if (url.startsWith('https://api.github.com/users/')) {
      return new Response(JSON.stringify({ bio: `hello ${claimBody.challenge}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return realFetch(input, init)
  }
  try {
    const verifyByA = await verifyPOST({
      request: sessionRequest('iso-session-token-a', `https://iso.test/api/builders/${IDS.identityA}/claim/verify`, { method: 'POST' }),
      params: { builderId: IDS.identityA },
    })
    const verifyByABody = await verifyByA.json()
    record(
      'claim: A can complete A\'s own claim once the challenge is live on the source account',
      verifyByA.status === 200 && verifyByABody.ok === true && verifyByABody.builderId === IDS.identityA,
      `status=${verifyByA.status} body=${JSON.stringify(verifyByABody)}`,
    )
  } finally {
    globalThis.fetch = realFetch
  }
}

/**
 * The entitlement read.
 *
 * This function used to cover three more routes — `/api/me/plan-changes`, `/api/plans/request-upgrade` and the
 * `plan_changes`/`plan_requests` rows behind them. All of it went away with the legacy per-user plan surface
 * (2026-08-03): the request queue could not be fed while billing was enabled, `plan_changes` had no writer at
 * all, and every table involved held zero rows. Dropping those probes is not a loss of coverage, because the
 * thing they covered no longer exists — the audited grant path they were adjacent to is exercised in
 * `checkAdminContentManagement` below, against the organization that is actually entitled.
 */
async function checkPlansMe() {
  const { Route: PlanMeRoute } = await import('../../src/routes/api/plans/me.ts')
  const { GET: planMeGET } = PlanMeRoute.options.server.handlers

  const planA = await (await planMeGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/plans/me') })).json()
  record('plans/me: A\'s seatsUsed reflects only org A\'s membership', planA.plan?.seatsUsed === 1, JSON.stringify(planA.plan))
}

async function checkExportBuilders() {
  const { Route } = await import('../../src/routes/api/export/builders.ts')
  const { GET } = Route.options.server.handlers

  const csvA = await (await GET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/export/builders') })).text()
  record('export: A\'s CSV contains A\'s tracked builder', csvA.includes('iso-a'), csvA.slice(0, 200))
  record('export: A\'s CSV never contains B\'s tracked builder', !csvA.includes('iso-b'), csvA.slice(0, 200))
}

async function checkOrganizationTeamAndMembers() {
  const { Route: TeamRoute } = await import('../../src/routes/api/organizations/team.ts')
  const { GET: teamGET } = TeamRoute.options.server.handlers

  const snapshotA = await (await teamGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/organizations/team') })).json()
  const memberIdsA = (snapshotA.members ?? []).map((m) => m.userId)
  record('team: org A snapshot lists only A\'s member, not B\'s', memberIdsA.includes(IDS.userA) && !memberIdsA.includes(IDS.userB), JSON.stringify(memberIdsA))

  const { Route: MembersRoute } = await import('../../src/routes/api/organizations/members/$memberId.ts')
  const { PATCH: memberPATCH, DELETE: memberDELETE } = MembersRoute.options.server.handlers

  const patchCrossOrg = await memberPATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/organizations/members/x', { method: 'PATCH', body: JSON.stringify({ role: 'admin' }) }),
    params: { memberId: IDS.userB },
  })
  record('members: A (org A owner) cannot change role of B (not a member of org A)', patchCrossOrg.status === 404, `status=${patchCrossOrg.status}`)

  const deleteCrossOrg = await memberDELETE({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/organizations/members/x', { method: 'DELETE' }),
    params: { memberId: IDS.userB },
  })
  record('members: A (org A owner) cannot remove B (not a member of org A)', deleteCrossOrg.status === 404, `status=${deleteCrossOrg.status}`)
}

// Admin routes are platform-scoped (requirePlatformAdminPrincipal), not
// tenant-scoped — there is no organization boundary to test here. What's
// worth verifying with real route handlers instead: (1) a non-admin session
// genuinely gets rejected at runtime, not just per the static auth-guard
// scan in scripts/check-route-coverage.mjs, and (2) editing/deleting one
// content row never touches another (CRUD scoping, not tenant isolation).
async function checkAdminContentManagement() {
  process.env.ADMIN_USER_IDS = IDS.userA

  const { Route: ChangelogListRoute } = await import('../../src/routes/api/admin/changelog/index.ts')
  const { GET: changelogGET, POST: changelogPOST } = ChangelogListRoute.options.server.handlers
  const { Route: ChangelogItemRoute } = await import('../../src/routes/api/admin/changelog/$id.ts')
  const { PATCH: changelogPATCH, DELETE: changelogDELETE } = ChangelogItemRoute.options.server.handlers

  const nonAdminList = await changelogGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/admin/changelog') })
  record('admin changelog: non-admin session (B) is rejected at runtime', nonAdminList.status === 403, `status=${nonAdminList.status}`)

  const createOne = await (await changelogPOST({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/changelog', {
      method: 'POST', body: JSON.stringify({ title: 'Iso One', content: 'one', slug: 'iso-one', tags: [] }),
    }),
  })).json()
  const createTwo = await (await changelogPOST({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/changelog', {
      method: 'POST', body: JSON.stringify({ title: 'Iso Two', content: 'two', slug: 'iso-two', tags: [] }),
    }),
  })).json()

  await changelogPATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/changelog/x', { method: 'PATCH', body: JSON.stringify({ title: 'Iso One Updated' }) }),
    params: { id: createOne.id },
  })
  const afterPatch = await (await changelogGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/changelog') })).json()
  const patchedOne = afterPatch.find((row) => row.id === createOne.id)
  const untouchedTwo = afterPatch.find((row) => row.id === createTwo.id)
  record(
    'admin changelog: PATCH updates only the target row, not the other',
    patchedOne?.title === 'Iso One Updated' && untouchedTwo?.title === 'Iso Two',
    JSON.stringify({ patchedOne, untouchedTwo }),
  )

  await changelogDELETE({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/changelog/x', { method: 'DELETE' }), params: { id: createOne.id } })
  const afterDelete = await (await changelogGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/changelog') })).json()
  record(
    'admin changelog: DELETE removes only the target row, not the other',
    !afterDelete.some((row) => row.id === createOne.id) && afterDelete.some((row) => row.id === createTwo.id),
    JSON.stringify(afterDelete.map((row) => row.id)),
  )

  const { Route: IncidentsListRoute } = await import('../../src/routes/api/admin/incidents/index.ts')
  const { GET: incidentsGET, POST: incidentsPOST } = IncidentsListRoute.options.server.handlers
  const { Route: IncidentItemRoute } = await import('../../src/routes/api/admin/incidents/$id.ts')
  const { PATCH: incidentPATCH } = IncidentItemRoute.options.server.handlers

  const incidentOne = await (await incidentsPOST({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/incidents', { method: 'POST', body: JSON.stringify({ title: 'Incident One' }) }) })).json()
  const incidentTwo = await (await incidentsPOST({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/incidents', { method: 'POST', body: JSON.stringify({ title: 'Incident Two' }) }) })).json()
  await incidentPATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/incidents/x', { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) }),
    params: { id: incidentOne.id },
  })
  const incidentsAfter = await (await incidentsGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/incidents') })).json()
  const resolvedOne = incidentsAfter.find((row) => row.id === incidentOne.id)
  const untouchedIncidentTwo = incidentsAfter.find((row) => row.id === incidentTwo.id)
  record(
    'admin incidents: PATCH updates only the target row, not the other',
    resolvedOne?.status === 'resolved' && untouchedIncidentTwo?.status !== 'resolved',
    JSON.stringify({ resolvedOne, untouchedIncidentTwo }),
  )

  const { Route: RoadmapListRoute } = await import('../../src/routes/api/admin/roadmap/index.ts')
  const { GET: roadmapGET, POST: roadmapPOST } = RoadmapListRoute.options.server.handlers
  const { Route: RoadmapItemRoute } = await import('../../src/routes/api/admin/roadmap/$id.ts')
  const { PATCH: roadmapPATCH, DELETE: roadmapDELETE } = RoadmapItemRoute.options.server.handlers

  const roadmapOne = await (await roadmapPOST({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/roadmap', { method: 'POST', body: JSON.stringify({ title: 'Roadmap One' }) }) })).json()
  const roadmapTwo = await (await roadmapPOST({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/roadmap', { method: 'POST', body: JSON.stringify({ title: 'Roadmap Two' }) }) })).json()
  await roadmapPATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/roadmap/x', { method: 'PATCH', body: JSON.stringify({ status: 'shipped' }) }),
    params: { id: roadmapOne.id },
  })
  await roadmapDELETE({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/roadmap/x', { method: 'DELETE' }), params: { id: roadmapTwo.id } })
  const roadmapAfter = await (await roadmapGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/roadmap') })).json()
  const shippedOne = roadmapAfter.find((row) => row.id === roadmapOne.id)
  record(
    'admin roadmap: PATCH and DELETE each affect only their own target row',
    shippedOne?.status === 'shipped' && !roadmapAfter.some((row) => row.id === roadmapTwo.id),
    JSON.stringify(roadmapAfter.map((row) => ({ id: row.id, status: row.status }))),
  )

  const { Route: UsersListRoute } = await import('../../src/routes/api/admin/users/index.ts')
  const { GET: usersGET } = UsersListRoute.options.server.handlers
  const { Route: UserItemRoute } = await import('../../src/routes/api/admin/users/$userId.ts')
  const { PATCH: userPATCH } = UserItemRoute.options.server.handlers

  /**
   * The operator grant, through the real handler as the real role.
   *
   * Rewritten 2026-08-04, and the rewrite is the point. This used to assert `user.plan === 'pro'` from a
   * per-**user** `plans` row. Entitlement is per organization, so the grant now resolves the organization the
   * user owns and writes there — which means this probe finally asserts something enforcement actually reads,
   * and it does so through `builderhunt_platform`. That matters: the first version of the new grant wrote
   * `organization_entitlements` directly and answered 42501 for this exact role, and no unit test could see it.
   */
  const grantResponse = await userPATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/users/x', {
      method: 'PATCH',
      body: JSON.stringify({ plan: 'pro', reason: 'iso isolation probe' }),
    }),
    params: { userId: IDS.userA },
  })
  const grantBody = await grantResponse.json()
  record(
    'admin users: the grant succeeds as builderhunt_platform (not 42501 through a direct table write)',
    grantResponse.status === 200 && grantBody.to === 'pro',
    JSON.stringify({ status: grantResponse.status, body: grantBody }),
  )

  const usersAfter = await (await usersGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/users') })).json()
  // `rows`, not `users`: the admin grid is a platform-scoped keyset page since plans/phase-3/10.
  const billingA = (usersAfter.rows ?? []).find((u) => u.userId === IDS.userA)?.billing
  const billingB = (usersAfter.rows ?? []).find((u) => u.userId === IDS.userB)?.billing
  record(
    'admin users: the grant lands on A\'s organization only, never B\'s',
    billingA?.entitlementTier === 'pro' && billingB?.entitlementTier !== 'pro',
    JSON.stringify({ billingA, billingB }),
  )
  record(
    'admin users: a manually granted tier is reported as an exception, not as Stripe-backed',
    billingA?.provenance === 'manual_exception' && billingA?.hasActiveSubscription === false,
    JSON.stringify(billingA),
  )

  /*
   * `admin plan-requests: approving B's request sets B's plan, not A's` was here and is gone with the route
   * (2026-08-03). The queue could not be fed — every self-service request was refused while billing was
   * enabled — so the probe was exercising an approval flow that no user could ever reach.
   */
}

async function checkDashboardStatsAndRecent() {
  const { Route: StatsRoute } = await import('../../src/routes/api/dashboard/stats.ts')
  const { GET: statsGET } = StatsRoute.options.server.handlers

  const statsA = await (await statsGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/dashboard/stats') })).json()
  record('dashboard stats: A gets an org-scoped stats object, not an error', statsA && typeof statsA === 'object' && !('error' in statsA), JSON.stringify(statsA))

  const { Route: RecentRoute } = await import('../../src/routes/api/builders/recent/index.ts')
  const { GET: recentGET } = RecentRoute.options.server.handlers

  const recentA = await (await recentGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/recent') })).json()
  record('recent builders: A sees only A\'s tracked builder, not B\'s', Array.isArray(recentA) && recentA.length === 1 && recentA[0].identityId === IDS.identityA, JSON.stringify(recentA))

  const { Route: TrackRoute } = await import('../../src/routes/api/builders/track.ts')
  const { POST: trackPOST } = TrackRoute.options.server.handlers

  const trackNew = await trackPOST({
    request: sessionRequest('iso-session-token-b', 'https://iso.test/api/builders/track', {
      method: 'POST',
      body: JSON.stringify({
        source: 'github',
        sourceId: 'iso-new-tracked',
        username: 'iso-new-tracked',
        profileUrl: 'https://github.com/iso-new-tracked',
      }),
    }),
  })
  const trackNewBody = await trackNew.json()
  record('track: B can track a new builder into B\'s own org', trackNew.status === 200 && trackNewBody.tracked === true, JSON.stringify(trackNewBody))

  const recentAAfter = await (await recentGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/builders/recent') })).json()
  record('recent builders: A still sees only A\'s builder after B tracks a new one', Array.isArray(recentAAfter) && recentAAfter.length === 1 && recentAAfter[0].identityId === IDS.identityA, JSON.stringify(recentAAfter))
}

// Inserts its own keyword-less saved query right before running (not in the
// global seed()) — org A's original `queryA` has real keywords and is
// deleted by checkSavedQueries earlier, so by this point org A has zero
// saved queries; adding one here, lazily, keeps basedOnSearches
// deterministic without giving checkSavedQueries' earlier "sees only A's
// query" (length === 1) assertion a second row to trip over. Keyword-less
// so the route never reaches the live external search pipeline. org B is
// not called here for the same reason — `queryB` (seeded in seed(), never
// deleted) has real keywords and would trigger a live network search.
async function checkRecommendationsScoping() {
  await owner`
    insert into saved_queries (id, organization_id, user_id, name, keywords, sources, created_at)
    values (${IDS.recsQueryA}, ${IDS.orgA}, ${IDS.userA}, 'Recs A (no keywords)', '[]'::jsonb, '[]'::jsonb, now())
  `

  const { Route } = await import('../../src/routes/api/recommendations/index.ts')
  const { GET } = Route.options.server.handlers

  const recsA = await (await GET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/recommendations') })).json()
  record('recommendations: A\'s basedOnSearches reflects only A\'s own saved queries', recsA.meta?.basedOnSearches === 1, JSON.stringify(recsA.meta))
}

// Subject-only `/api/me/**` routes — scoped by session.user.id, not by
// organization. Run last, after checkBuilderClaim (A already has a verified
// claim on identityA by this point) and checkOrganizationTeamAndMembers/etc,
// since delete-account's mutation is the most invasive of anything in this
// file and should not affect earlier assertions.
async function checkMeSubjectRoutes() {
  const { Route: DataExportListRoute } = await import('../../src/routes/api/me/data-export/index.ts')
  const { GET: exportListGET, POST: exportPOST } = DataExportListRoute.options.server.handlers
  const { Route: DataExportItemRoute } = await import('../../src/routes/api/me/data-export/$id.ts')
  const { GET: exportItemGET } = DataExportItemRoute.options.server.handlers

  const exportCreate = await (await exportPOST({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/data-export', { method: 'POST' }) })).json()
  record('me/data-export: A can request an export', exportCreate.ok === true && typeof exportCreate.id === 'string', JSON.stringify(exportCreate))

  const listA = await (await exportListGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/data-export') })).json()
  const listB = await (await exportListGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/me/data-export') })).json()
  record('me/data-export: A\'s list has A\'s request, B\'s list is empty', listA.some((r) => r.id === exportCreate.id) && listB.length === 0, JSON.stringify({ listA, listB }))

  const ownGet = await exportItemGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/data-export/x'), params: { id: exportCreate.id } })
  record('me/data-export: A can read A\'s own export by id', ownGet.status === 200, `status=${ownGet.status}`)

  const crossGet = await exportItemGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/me/data-export/x'), params: { id: exportCreate.id } })
  record('me/data-export: B cannot read A\'s export by id (other user)', crossGet.status === 404, `status=${crossGet.status}`)

  const { Route: DeleteAccountRoute } = await import('../../src/routes/api/me/delete-account/index.ts')
  const { GET: deleteAccountGET, POST: deleteAccountPOST, DELETE: deleteAccountDELETE } = DeleteAccountRoute.options.server.handlers

  const beforeB = await (await deleteAccountGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/me/delete-account') })).json()
  record('me/delete-account: B has no pending deletion before A requests one', beforeB.request === null, JSON.stringify(beforeB))

  const requestA = await (await deleteAccountPOST({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/delete-account', { method: 'POST' }) })).json()
  record('me/delete-account: A can request deletion of A\'s own account', requestA.ok === true, JSON.stringify(requestA))

  const afterB = await (await deleteAccountGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/me/delete-account') })).json()
  record('me/delete-account: A\'s deletion request never appears for B', afterB.request === null, JSON.stringify(afterB))

  const cancelA = await (await deleteAccountDELETE({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/delete-account', { method: 'DELETE' }) })).json()
  record('me/delete-account: A can cancel A\'s own deletion request', cancelA.ok === true, JSON.stringify(cancelA))

  // A already has a verified claim on identityA from checkBuilderClaim.
  const { Route: MeBuilderListRoute } = await import('../../src/routes/api/me/builder/index.ts')
  const { GET: meBuilderGET } = MeBuilderListRoute.options.server.handlers
  const meBuilderA = await (await meBuilderGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/builder') })).json()
  const meBuilderB = await (await meBuilderGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/me/builder') })).json()
  record(
    'me/builder: A\'s verified-claim list has identityA, B\'s is empty',
    meBuilderA.some((row) => row.id === IDS.identityA) && meBuilderB.length === 0,
    JSON.stringify({ meBuilderA, meBuilderB }),
  )

  const { Route: MeBuilderItemRoute } = await import('../../src/routes/api/me/builder/$builderId.ts')
  const { PATCH: meBuilderPATCH } = MeBuilderItemRoute.options.server.handlers
  const patchOwnClaim = await meBuilderPATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/builder/x', { method: 'PATCH', body: JSON.stringify({ bio: 'iso claimed bio' }) }),
    params: { builderId: IDS.identityA },
  })
  record('me/builder: A can update A\'s own verified claim', patchOwnClaim.status === 200, `status=${patchOwnClaim.status}`)

  const patchOtherIdentity = await meBuilderPATCH({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/builder/x', { method: 'PATCH', body: JSON.stringify({ bio: 'should not land' }) }),
    params: { builderId: IDS.identityB },
  })
  record('me/builder: A cannot update identityB (never claimed by A)', patchOtherIdentity.status === 403, `status=${patchOtherIdentity.status}`)

  const { Route: EvidenceProvenanceRoute } = await import('../../src/routes/api/me/builder/$builderId/evidence-provenance.ts')
  const { GET: provenanceGET } = EvidenceProvenanceRoute.options.server.handlers
  const provenanceOwn = await provenanceGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/builder/x/evidence-provenance'), params: { builderId: IDS.identityA } })
  record('evidence-provenance: A (verified claimant) can read A\'s own provenance', provenanceOwn.status === 200, `status=${provenanceOwn.status}`)

  const provenanceOther = await provenanceGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/me/builder/x/evidence-provenance'), params: { builderId: IDS.identityA } })
  record('evidence-provenance: B (not a claimant of identityA) is rejected', provenanceOther.status === 403, `status=${provenanceOther.status}`)

  const { Route: RestrictProcessingRoute } = await import('../../src/routes/api/me/builder/$builderId/restrict-processing.ts')
  const { POST: restrictPOST } = RestrictProcessingRoute.options.server.handlers
  const restrictOther = await restrictPOST({
    request: sessionRequest('iso-session-token-b', 'https://iso.test/api/me/builder/x/restrict-processing', { method: 'POST' }),
    params: { builderId: IDS.identityA },
  })
  record('restrict-processing: B (not a claimant of identityA) is rejected', restrictOther.status === 403, `status=${restrictOther.status}`)

  const { Route: MeBuildersRoute } = await import('../../src/routes/api/me/builders/index.ts')
  const { GET: meBuildersGET } = MeBuildersRoute.options.server.handlers
  const meBuildersA = await (await meBuildersGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/builders') })).json()
  record(
    'me/builders: A\'s org-tracked list has A\'s tracked identity, not B\'s',
    meBuildersA.some((row) => row.identityId === IDS.identityA) && !meBuildersA.some((row) => row.identityId === IDS.identityB),
    JSON.stringify(meBuildersA.map((row) => row.identityId)),
  )
}

// The only admin/*/run-worker endpoint with no live external network call
// (alerts/discovery/embeddings/enrichment/sprints run-workers all call
// searchBuilders or a real embedding/enrichment provider). Must run LAST —
// this hard-deletes user A's entire account, which every earlier check in
// this file depends on existing. `checkMeSubjectRoutes` already created (and
// cancelled) a deletion_requests row for A, so this UPDATEs that row back to
// due rather than INSERTing — `deletion_requests.user_id` is unique.
async function checkLegalRunWorker() {
  await owner`
    update deletion_requests
    set status = 'pending', grace_period_ends_at = now() - interval '1 day'
    where user_id = ${IDS.userA}
  `
  await owner`
    insert into deletion_requests (id, user_id, status, grace_period_ends_at)
    values ('iso-deletion-b', ${IDS.userB}, 'pending', now() + interval '10 days')
  `

  const { processPendingDeletions } = await import('../../src/shared/lib/legal.ts')
  const result = await processPendingDeletions()
  record('legal run-worker: processes exactly A\'s due request, not B\'s not-yet-due one', result.processed === 1 && result.errors === 0, JSON.stringify(result))

  const [remainingA] = await owner`select id from auth_users where id = ${IDS.userA}`
  const [remainingB] = await owner`select id from auth_users where id = ${IDS.userB}`
  record('legal run-worker: A\'s account is hard-deleted, B\'s is untouched', !remainingA && !!remainingB, JSON.stringify({ remainingA, remainingB }))

  const [depB] = await owner`select status from deletion_requests where user_id = ${IDS.userB}`
  record('legal run-worker: B\'s not-due deletion request is left pending, unprocessed', depB?.status === 'pending', JSON.stringify(depB))
}

async function checkAccountExportPrivacy() {
  const { buildExportPayload } = await import('../../src/shared/lib/legal.ts')
  const payloadA = await buildExportPayload(IDS.userA)
  const payloadB = await buildExportPayload(IDS.userB)
  const serializedA = JSON.stringify(payloadA)
  const serializedB = JSON.stringify(payloadB)

  record(
    'privacy: A\'s export never mentions B\'s user/org/builder ids',
    !serializedA.includes(IDS.userB) && !serializedA.includes(IDS.orgB) && !serializedA.includes(IDS.legacyBuilderB),
    'checked userB/orgB/legacyBuilderB absence',
  )
  record(
    'privacy: B\'s export never mentions A\'s user/org/builder ids',
    !serializedB.includes(IDS.userA) && !serializedB.includes(IDS.orgA) && !serializedB.includes(IDS.legacyBuilderA),
    'checked userA/orgA/legacyBuilderA absence',
  )
  record(
    'privacy: A\'s export does contain A\'s own tracked builder',
    serializedA.includes(IDS.legacyBuilderA),
    'checked legacyBuilderA presence',
  )
}

async function checkWorkerIsolation() {
  const { runAlertsWorker } = await import('../../src/lib/alerts/worker.ts')
  const result = await runAlertsWorker()

  const triggers = await owner`
    select organization_id, alert_id, builder_id from alert_triggers
    where organization_id in (${IDS.orgA}, ${IDS.orgB})
  `
  const forA = triggers.filter((t) => t.organization_id === IDS.orgA)
  const forB = triggers.filter((t) => t.organization_id === IDS.orgB)

  record('worker: org A got its own trigger, not org B\'s', forA.length >= 1 && forA.every((t) => t.builder_id === IDS.legacyBuilderA), JSON.stringify(forA))
  record('worker: org B got its own trigger, not org A\'s', forB.length >= 1 && forB.every((t) => t.builder_id === IDS.legacyBuilderB), JSON.stringify(forB))
  record('worker: no cross-organization trigger rows', triggers.every((t) => t.organization_id === IDS.orgA || t.organization_id === IDS.orgB), JSON.stringify(triggers))
  record('worker: run completed without throwing for either tenant', Array.isArray(result.errors), `errors=${JSON.stringify(result.errors)}`)
}

// abuse-and-usage-integrity Phase 4B task 1, "Verify built credit-ledger invariants under the real
// runtime role (G3/G5/G9/G10)". Unlike reservations.test.ts/credits.test.ts (which only ever run
// against the disposable-DB OWNER connection — docs/operations/database-roles.md explicitly warns
// "never test RLS as the owner and treat that as evidence"), this exercises the real restricted
// builderhunt_worker role, with RLS/grants actually enforced. builderhunt_app has ZERO INSERT/UPDATE
// grant on any of the four credit-ledger tables (drizzle/0028_billing_rls_grants.sql) — only the
// worker role can ever mutate this state — so "as builderhunt_app" in the task's own wording is read
// as "as the real restricted runtime role that actually owns this write path," i.e. builderhunt_worker.
// No route exists yet calling reserveCredits/settleReservation/grantCredits (feature-authorization.ts
// is written but not wired to any endpoint), so unlike every other check in this file there is no
// route handler to import — this calls the library functions directly through withWorkerOrganization,
// the same real drizzle transaction + RLS context every actual writer of this state will use.
async function checkCreditLedgerInvariantsUnderWorkerRole() {
  // Two dedicated orgs, not one — the reservation-race balance assertion (below) needs an
  // unambiguous, single-grant pool; sharing an org with the monthly-window-grant race would let a
  // SECOND grant land in the same pool between the two checks and inflate the available balance,
  // which is exactly what happened the first time this was written against a real Postgres (two
  // 60-unit reservations both "succeeded" against what looked like a 100-unit balance — not a
  // product bug: an earlier 50-unit window grant in the same org had legitimately raised the real
  // pool to 150, and the allocator correctly spent exactly 120 of it, leaving 30 — the assertion
  // was wrong, not the allocator).
  const orgId = 'iso-credit-org-a'
  const reserveOrgId = 'iso-credit-org-reserve'
  await owner`
    insert into organizations (id, name, slug, metadata, created_at)
    values
      (${orgId}, 'Credit Ledger Org', 'iso-credit-org-a', '{}', now()),
      (${reserveOrgId}, 'Credit Ledger Reserve Org', 'iso-credit-org-reserve', '{}', now())
    on conflict (id) do nothing
  `

  const { withWorkerOrganization } = await import('../../src/shared/lib/repositories/billing-worker.ts')
  const { grantCredits } = await import('../../src/shared/lib/billing/credits.ts')
  const { reserveCredits, settleReservation } = await import('../../src/shared/lib/billing/reservations.ts')

  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)

  // --- G9: negative grant units rejected before any row is written ---
  let negativeGrantRejected = false
  try {
    await withWorkerOrganization(orgId, (tx) => grantCredits(tx, {
      grantId: crypto.randomUUID(), ledgerEntryId: crypto.randomUUID(), organizationId: orgId,
      source: 'operator_trial', units: -5, expiresAt: farFuture, idempotencyKey: crypto.randomUUID(),
    }))
  } catch (error) {
    negativeGrantRejected = error?.code === 'invalid_units'
  }
  record('credit ledger (worker role, G9): negative grant units rejected', negativeGrantRejected, String(negativeGrantRejected))

  // Seed a real 100-unit grant, as the worker role, to reserve against below.
  const seededGrant = await withWorkerOrganization(orgId, (tx) => grantCredits(tx, {
    grantId: crypto.randomUUID(), ledgerEntryId: crypto.randomUUID(), organizationId: orgId,
    source: 'operator_trial', units: 100, expiresAt: farFuture, idempotencyKey: crypto.randomUUID(),
  }))
  record(
    'credit ledger (worker role): seed grant created with 100 remaining units',
    seededGrant.grant.remainingUnits === 100,
    JSON.stringify(seededGrant.grant),
  )

  // --- G5: monthly-window grant uniqueness holds under REAL concurrency (existing coverage is
  // sequential-only — credits.test.ts:79-91) ---
  const windowKey = `iso-worker-sub-x:window-1`
  const windowRace = await Promise.allSettled([
    withWorkerOrganization(orgId, (tx) => grantCredits(tx, {
      grantId: crypto.randomUUID(), ledgerEntryId: crypto.randomUUID(), organizationId: orgId,
      source: 'subscription_annual_window', monthlyWindowKey: windowKey, units: 50,
      expiresAt: farFuture, idempotencyKey: crypto.randomUUID(),
    })),
    withWorkerOrganization(orgId, (tx) => grantCredits(tx, {
      grantId: crypto.randomUUID(), ledgerEntryId: crypto.randomUUID(), organizationId: orgId,
      source: 'subscription_annual_window', monthlyWindowKey: windowKey, units: 50,
      expiresAt: farFuture, idempotencyKey: crypto.randomUUID(),
    })),
  ])
  const windowOutcomes = windowRace.map((r) => r.status)
  record(
    'credit ledger (worker role, G5): concurrent same-window grants — exactly one persists',
    windowOutcomes.filter((s) => s === 'fulfilled').length === 1,
    JSON.stringify(windowOutcomes),
  )
  const windowRows = await owner`select id from billing_credit_grants where monthly_window_key = ${windowKey}`
  record('credit ledger (worker role, G5): only one grant row exists for the contested window', windowRows.length === 1, JSON.stringify(windowRows.map((r) => r.id)))

  // Dedicated grant, dedicated org — nothing else can ever be allocated from this pool.
  await withWorkerOrganization(reserveOrgId, (tx) => grantCredits(tx, {
    grantId: crypto.randomUUID(), ledgerEntryId: crypto.randomUUID(), organizationId: reserveOrgId,
    source: 'operator_trial', units: 100, expiresAt: farFuture, idempotencyKey: crypto.randomUUID(),
  }))

  // --- G3/G9: concurrent reserveCredits against a shared real balance never overspends ---
  const reserveRace = await Promise.allSettled([
    withWorkerOrganization(reserveOrgId, (tx) => reserveCredits(tx, {
      reservationId: crypto.randomUUID(), organizationId: reserveOrgId, operation: 'iso_check',
      rateCardVersion: 1, idempotencyKey: crypto.randomUUID(), maximumUnits: 60, maxDurationSeconds: 300,
    })),
    withWorkerOrganization(reserveOrgId, (tx) => reserveCredits(tx, {
      reservationId: crypto.randomUUID(), organizationId: reserveOrgId, operation: 'iso_check',
      rateCardVersion: 1, idempotencyKey: crypto.randomUUID(), maximumUnits: 60, maxDurationSeconds: 300,
    })),
  ])
  const reserveOutcomes = reserveRace.map((r) => r.status)
  record(
    'credit ledger (worker role, G3/G9): concurrent 60+60 reservations against a 100-unit balance — exactly one succeeds',
    reserveOutcomes.filter((s) => s === 'fulfilled').length === 1,
    JSON.stringify(reserveOutcomes),
  )
  const balanceRows = await owner`select coalesce(sum(remaining_units), 0)::int as total from billing_credit_grants where organization_id = ${reserveOrgId}`
  record(
    'credit ledger (worker role, G3/G9): remaining balance never went negative or was double-spent (100 - 60 = 40)',
    balanceRows[0]?.total === 40,
    JSON.stringify(balanceRows[0]),
  )

  const successfulReservation = reserveRace.find((r) => r.status === 'fulfilled')?.value?.reservation

  // --- G3: settleReservation refuses actualUnits beyond what was reserved (over-settlement) ---
  let overSettlementRejected = false
  if (successfulReservation) {
    try {
      await withWorkerOrganization(reserveOrgId, (tx) => settleReservation(tx, {
        organizationId: reserveOrgId, reservationId: successfulReservation.id,
        actualUnits: successfulReservation.maximumUnits + 1,
        idempotencyKey: crypto.randomUUID(), settlementGraceSeconds: 60,
      }))
    } catch (error) {
      overSettlementRejected = error?.code === 'over_settlement'
    }
  }
  record(
    'credit ledger (worker role, G3): settleReservation refuses actualUnits > maximumUnits',
    overSettlementRejected,
    String(overSettlementRejected),
  )

  // --- G10: a replayed settlement idempotency key returns the cached result, never double-consumes ---
  let replayConsistent = false
  if (successfulReservation) {
    const settleKey = crypto.randomUUID()
    const settleInput = {
      organizationId: reserveOrgId, reservationId: successfulReservation.id,
      actualUnits: Math.floor(successfulReservation.maximumUnits / 2),
      idempotencyKey: settleKey, settlementGraceSeconds: 60,
    }
    const first = await withWorkerOrganization(reserveOrgId, (tx) => settleReservation(tx, settleInput))
    const second = await withWorkerOrganization(reserveOrgId, (tx) => settleReservation(tx, settleInput))
    replayConsistent = second.replayed === true && second.reservation.settledUnits === first.reservation.settledUnits
  }
  record(
    'credit ledger (worker role, G10): replayed settlement idempotency key returns the cached result (no double-consume)',
    replayConsistent,
    String(replayConsistent),
  )
}

// abuse-and-usage-integrity Phase 6 task 3, "Wire abuse checks into the release-gate audit set" —
// table-level RLS for the 5 abuse tables is already fully covered by verify-rls-local.mjs; the real
// gap this closes is route-handler-level isolation for the two abuse-console routes and the
// sessions-panel route, which were never exercised here. `/api/admin/abuse` mutations act on
// ANOTHER user's account_risk row by design (a platform admin acting on a flagged user, not on
// themselves) — that is not a same-tenant/cross-tenant leak, it is the feature; the assertions
// below instead confirm non-admins are rejected and that the mutation actually lands on the
// targeted user, not silently on the caller.
async function checkAbuseConsoleAndSessionsRoutes() {
  process.env.ADMIN_USER_IDS = IDS.userA

  const { Route: AbuseFeedRoute } = await import('../../src/routes/api/admin/abuse/index.ts')
  const { GET: abuseFeedGET, POST: abuseFeedPOST } = AbuseFeedRoute.options.server.handlers
  const { Route: AbuseClustersRoute } = await import('../../src/routes/api/admin/abuse/clusters.ts')
  const { GET: abuseClustersGET } = AbuseClustersRoute.options.server.handlers

  const nonAdminFeed = await abuseFeedGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/admin/abuse') })
  record('admin abuse feed: non-admin session (B) is rejected at runtime', nonAdminFeed.status === 403, `status=${nonAdminFeed.status}`)

  const nonAdminClusters = await abuseClustersGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/admin/abuse/clusters') })
  record('admin abuse clusters: non-admin session (B) is rejected at runtime', nonAdminClusters.status === 403, `status=${nonAdminClusters.status}`)

  const nonAdminAction = await abuseFeedPOST({
    request: sessionRequest('iso-session-token-b', 'https://iso.test/api/admin/abuse', { method: 'POST', body: JSON.stringify({ userId: IDS.userA, action: 'block' }) }),
  })
  record('admin abuse action: non-admin session (B) is rejected at runtime', nonAdminAction.status === 403, `status=${nonAdminAction.status}`)

  const adminFeed = await (await abuseFeedGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/abuse') })).json()
  record('admin abuse feed: admin session (A) can read the feed', Array.isArray(adminFeed.signals) && typeof adminFeed.stageByUserId === 'object', JSON.stringify(adminFeed).slice(0, 200))

  const adminClusters = await (await abuseClustersGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/abuse/clusters') })).json()
  record('admin abuse clusters: admin session (A) can read clusters', Array.isArray(adminClusters.clusters), JSON.stringify(adminClusters).slice(0, 200))

  // Admin A acts on B's account (the intended cross-user shape of this feature, not a leak).
  const actionOnB = await (await abuseFeedPOST({
    request: sessionRequest('iso-session-token-a', 'https://iso.test/api/admin/abuse', { method: 'POST', body: JSON.stringify({ userId: IDS.userB, action: 'warn', reason: 'iso test' }) }),
  })).json()
  record('admin abuse action: admin A can act on user B\'s account, and it lands on B, not A', actionOnB.userId === IDS.userB && actionOnB.stage === 'warned', JSON.stringify(actionOnB))

  const [riskRowB] = await owner`select user_id, stage from account_risk where user_id = ${IDS.userB}`
  const [riskRowA] = await owner`select user_id, stage from account_risk where user_id = ${IDS.userA}`
  record('admin abuse action: only B\'s account_risk row changed, A\'s is untouched (no self-application)', riskRowB?.stage === 'warned' && !riskRowA, JSON.stringify({ riskRowA, riskRowB }))

  const { Route: MeSessionsRoute } = await import('../../src/routes/api/me/sessions/index.ts')
  const { GET: meSessionsGET } = MeSessionsRoute.options.server.handlers
  const sessionsA = await (await meSessionsGET({ request: sessionRequest('iso-session-token-a', 'https://iso.test/api/me/sessions') })).json()
  const sessionsB = await (await meSessionsGET({ request: sessionRequest('iso-session-token-b', 'https://iso.test/api/me/sessions') })).json()
  record(
    'me/sessions: A\'s session list never includes B\'s session id, and vice versa',
    Array.isArray(sessionsA) && Array.isArray(sessionsB)
      && !sessionsA.some((s) => s.id === 'iso-session-b') && !sessionsB.some((s) => s.id === 'iso-session-a'),
    JSON.stringify({ sessionsA: sessionsA.map?.((s) => s.id), sessionsB: sessionsB.map?.((s) => s.id) }),
  )
}

async function main() {
  await seed()
  await checkSavedQueries()
  await checkAlerts()
  await checkBuilderTracking()
  await checkBuilderNotes()
  await checkSearchTrackedAnnotationScoping()
  await checkPublicNonTenantTableGrants()
  await checkSprints()
  await checkEnrichmentAndEvidence()
  await checkBuilderClaim()
  await checkPlansMe()
  await checkExportBuilders()
  await checkOrganizationTeamAndMembers()
  await checkDashboardStatsAndRecent()
  await checkRecommendationsScoping()
  await checkAccountExportPrivacy()
  await checkWorkerIsolation()
  await checkCreditLedgerInvariantsUnderWorkerRole()
  await checkAbuseConsoleAndSessionsRoutes()
  // Run last: checkAdminContentManagement grants an entitlement (legitimately recording admin A's id against
  // the organization it moved on) and checkMeSubjectRoutes requests/cancels a real account deletion — both
  // would otherwise trip checkAccountExportPrivacy's blunt
  // never-mentions-the-other-user's-id assertion, which was written
  // assuming no such legitimate cross-reference exists yet.
  await checkAdminContentManagement()
  await checkMeSubjectRoutes()
  await checkLegalRunWorker()

  const failed = results.filter((r) => !r.pass)
  console.log(JSON.stringify({ total: results.length, passed: results.length - failed.length, failed: failed.length, results }, null, 2))
  if (failed.length > 0) process.exitCode = 1
}

try {
  await main()
} finally {
  await owner.end({ timeout: 5 })
}

// Extending coverage beyond the original 4 routes pulled in route handlers
// that transitively open their own long-lived pooled clients (platformDb,
// authDb, workerDb — e.g. via better-auth's own session lookup, or
// requestPlatformPlanUpgrade) that this script never explicitly closes.
// Node's event loop won't drain on its own with those sockets still open,
// so force a prompt exit now that every check + `owner.end()` above has
// resolved, rather than leaving the process to hang indefinitely.
process.exit(process.exitCode ?? 0)
