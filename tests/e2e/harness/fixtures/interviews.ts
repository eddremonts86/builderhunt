/**
 * One world per interview spec file (plan:
 * calendar-scheduling-interview-intelligence, Phase 12 "Add Playwright projects
 * and full E2E fixtures").
 *
 * The six interview specs need the same expensive bootstrap — a disposable
 * database with the five real roles, a Redis namespace, a Vite worker server
 * that inherited the feature flags at spawn, and an owner with an entitlement.
 * `scheduling-organizer.spec.ts` open-codes that sequence; copying it six more
 * times would mean six places to fix when the teardown order changes, and the
 * teardown order is the part that leaks connections when it is wrong.
 *
 * ## Flags are set before the server is spawned, never read from a dotenv
 *
 * `startWorkerServer` passes `process.env` to the child, so every flag has to be
 * assigned *before* the call. The specs pass them in explicitly for the same
 * reason `scheduling-organizer.spec.ts` does: a test that only exercises the
 * enabled path where a developer's `.env` happens to enable it is not a gate.
 *
 * ## The capability secret comes from the send response
 *
 * The secret is minted at send and only its SHA-256 hash is stored, so there is
 * no way to read one back out of the database — by design. In `E2E_MODE` the
 * email sender routes into the outbox and returns the whole link, which is the
 * only seam that exists, and the only one the candidate flow can use.
 */
import { config as loadEnv } from 'dotenv'
import type { APIRequestContext } from 'playwright/test'
import { request } from 'playwright/test'
import postgres, { type Sql } from 'postgres'

// Playwright does not give a worker process the dev server's env, and `e2eEnv()`
// needs the five database URLs. Loading here rather than in each spec keeps the
// import order from mattering: `e2eEnv()` reads `process.env` when it is called,
// which is inside `startInterviewHarness`, long after this line has run.
loadEnv({ path: '.env' })

import { acquireWorkerRedis, dropWorkerRedisNamespace } from '../cache'
import { ensureFixedTimeEnv, fixedClockFromEnv, type FixedClock } from '../clock'
import { acquireWorkerDatabase, dropWorkerDatabase } from '../database'
import { e2eEnv } from '../env'
import { uniqueId } from '../ids'
import { startWorkerServer, stopWorkerServer } from '../server'
import type { EntitlementTier } from '../roles'
import { createMemberPrincipal, createOwnerPrincipal, disposePrincipal, type FixtureContext, type Principal } from './principals'
import type { OrganizationFixture } from './organizations'

export interface InterviewHarness {
  workerIndex: number
  databaseName: string
  redisPrefix: string
  baseURL: string
  sql: Sql
  clock: FixedClock
  ctx: FixtureContext
  owner: Principal
  organization: OrganizationFixture
  /** Every principal created through `addPrincipal`, disposed in `stopInterviewHarness`. */
  extraPrincipals: Principal[]
  /** Every request context opened by `candidateContext`, disposed with the harness. */
  extraContexts: APIRequestContext[]
}

export interface StartInterviewHarnessOptions {
  /** Worker-unique tag mixed into fixture ids, e.g. `docs`. */
  scope: string
  /**
   * Flags assigned to `process.env` before the server is spawned. Always explicit:
   * the default for every interview flag is `false`, and a spec that needs one on
   * says so here rather than inheriting a laptop's `.env`.
   */
  flags?: Record<string, string>
  tier?: EntitlementTier
  seatLimit?: number
}

/**
 * Boots one worker's world. On any failure it tears down everything it managed to
 * create — the pool, the server, the database and the Redis namespace — because a
 * bootstrap that throws halfway is exactly how 197 idle connections accumulated
 * against a 200-connection limit once already.
 */
export async function startInterviewHarness(options: StartInterviewHarnessOptions): Promise<InterviewHarness> {
  ensureFixedTimeEnv()
  for (const [key, value] of Object.entries(options.flags ?? {})) {
    process.env[key] = value
  }

  const env = e2eEnv()
  if (env.E2E_MODE !== 'true') throw new Error('E2E_MODE must be true — run through the Playwright config')

  const workerIndex = Number(process.env.TEST_PARALLEL_INDEX ?? '0')
  const database = await acquireWorkerDatabase(workerIndex)
  const cache = await acquireWorkerRedis(workerIndex)

  let sql: Sql | undefined
  try {
    const server = await startWorkerServer(workerIndex, database, cache)
    sql = postgres(database.databaseUrl, { max: 3, prepare: false })
    const ctx: FixtureContext = { baseURL: server.baseURL, sql, scope: `w${workerIndex}${options.scope}` }
    const clock = fixedClockFromEnv()

    const { principal: owner, organization } = await createOwnerPrincipal(ctx, {
      tier: options.tier ?? 'team',
      seatLimit: options.seatLimit ?? 5,
      clock,
    })

    // One warm request: the first hit compiles the route tree, and a 30-second
    // assertion timeout on a cold Vite dev server fails for that reason alone.
    await fetch(`${server.baseURL}/`).then((r) => r.text()).catch(() => undefined)

    return {
      workerIndex,
      databaseName: database.databaseName,
      redisPrefix: cache.prefix,
      baseURL: server.baseURL,
      sql,
      clock,
      ctx,
      owner,
      organization,
      extraPrincipals: [],
      extraContexts: [],
    }
  } catch (error) {
    await sql?.end({ timeout: 5 }).catch(() => undefined)
    await stopWorkerServer(workerIndex).catch(() => undefined)
    await dropWorkerDatabase(workerIndex, database.databaseName).catch(() => undefined)
    await dropWorkerRedisNamespace(cache.prefix).catch(() => undefined)
    throw error
  }
}

/**
 * Tears the world down in the order that leaves nothing behind.
 *
 * The `pg_terminate_backend` sweep before `DROP DATABASE` is not defensive
 * decoration: the app process keeps a pool open, and a drop with a live backend
 * fails, which leaks a `builderhunt_security_test_e2e_*` database per run.
 */
export async function stopInterviewHarness(harness: InterviewHarness | undefined): Promise<void> {
  if (!harness) return
  for (const context of harness.extraContexts) await context.dispose().catch(() => undefined)
  for (const principal of [...harness.extraPrincipals, harness.owner]) {
    await disposePrincipal(principal).catch(() => undefined)
  }
  await harness.sql.end({ timeout: 5 }).catch(() => undefined)
  await stopWorkerServer(harness.workerIndex)

  const admin = postgres(e2eEnv().DATABASE_MIGRATION_URL, { max: 1, prepare: false })
  try {
    await admin`
      select pg_terminate_backend(pid) from pg_stat_activity
      where datname = ${harness.databaseName} and pid <> pg_backend_pid()
    `
  } finally {
    await admin.end({ timeout: 5 }).catch(() => undefined)
  }
  await dropWorkerDatabase(harness.workerIndex, harness.databaseName)
  await dropWorkerRedisNamespace(harness.redisPrefix)
}

/** A colleague in the same organization, disposed with the harness. */
export async function addMember(
  harness: InterviewHarness,
  role: 'admin' | 'member',
): Promise<Principal> {
  const principal = await createMemberPrincipal(harness.ctx, harness.organization.organizationId, role)
  harness.extraPrincipals.push(principal)
  return principal
}

/** A second organization with its own owner — the other side of every tenant A/B assertion. */
export async function addSecondOrganization(harness: InterviewHarness): Promise<{
  principal: Principal
  organization: OrganizationFixture
}> {
  const scoped: FixtureContext = { ...harness.ctx, scope: `${harness.ctx.scope}b` }
  const created = await createOwnerPrincipal(scoped, {
    tier: 'team',
    seatLimit: 5,
    clock: harness.clock,
  })
  harness.extraPrincipals.push(created.principal)
  return created
}

export interface TrackedBuilder {
  /** `builder_identities.id` — how the public profile route addresses it. */
  identityId: string
  /** `organization_builders.id` — the `trackedId` the scheduling panel needs. */
  trackedBuilderId: string
  displayName: string
}

/**
 * A tracked builder for `organizationBuilderId`.
 *
 * Three rows, because the product still has two builder tables: `builders` is the
 * legacy row the profile route's SSR head reads, `organization_builders` is the
 * canonical tracking row. Writing only one produces a profile that renders without
 * a scheduling panel, which reads as a UI bug rather than a missing fixture.
 */
export async function trackBuilder(harness: InterviewHarness, label = 'builder'): Promise<TrackedBuilder> {
  const identityId = uniqueId(`${label}-identity`)
  const trackedBuilderId = uniqueId(`${label}-tracked`)
  const username = `${label}-${uniqueId('u').slice(-8)}`
  const displayName = `E2E ${label} builder`

  await harness.sql`
    insert into builder_identities (id, source, source_id, username, display_name, profile_url, created_at, updated_at)
    values (${identityId}, 'github', ${username}, ${username}, ${displayName},
            ${`https://e2e.test/github/${username}`}, now(), now())
  `
  await harness.sql`
    insert into organization_builders (id, organization_id, builder_identity_id, creator_user_id)
    values (${trackedBuilderId}, ${harness.organization.organizationId}, ${identityId}, ${harness.owner.userId!})
  `
  await harness.sql`
    insert into builders (id, organization_id, user_id, source, source_id, username, display_name, profile_url, created_at, updated_at)
    values (${trackedBuilderId}, ${harness.organization.organizationId}, ${harness.owner.userId!}, 'github',
            ${username}, ${username}, ${displayName}, ${`https://e2e.test/github/${username}`}, now(), now())
  `
  return { identityId, trackedBuilderId, displayName }
}

export interface InvitationOverrides {
  candidateEmail?: string
  roleTitle?: string
  roleContext?: string
  durationMinutes?: number
  timezone?: string
  modality?: 'remote_call' | 'in_person'
  meetingUrl?: string | null
  organizationBuilderId?: string
}

export interface CreatedInvitation {
  invitationId: string
  roleTitle: string
  candidateEmail: string
}

/** Creates an invitation through the real API, as the harness owner. */
export async function createInvitation(
  harness: InterviewHarness,
  overrides: InvitationOverrides = {},
  api: APIRequestContext = harness.owner.api!,
): Promise<CreatedInvitation> {
  const roleTitle = overrides.roleTitle ?? `E2E role ${uniqueId('r').slice(-6)}`
  const candidateEmail = overrides.candidateEmail ?? `cand-${uniqueId('c').slice(-8)}@test.invalid`
  const response = await api.post('/api/scheduling/invitations', {
    data: {
      candidateEmail,
      roleTitle,
      roleContext: overrides.roleContext ?? 'Backend platform work, mostly Postgres and tenancy.',
      durationMinutes: overrides.durationMinutes ?? 30,
      timezone: overrides.timezone ?? 'Europe/Copenhagen',
      modality: overrides.modality ?? 'remote_call',
      ...(overrides.meetingUrl === null ? {} : { meetingUrl: overrides.meetingUrl ?? 'https://meet.test.invalid/e2e' }),
      ...(overrides.organizationBuilderId ? { organizationBuilderId: overrides.organizationBuilderId } : {}),
    },
  })
  if (response.status() >= 400) {
    throw new Error(`invitation create failed (${response.status()}): ${await response.text()}`)
  }
  const body = await response.json() as { invitationId?: string; invitation?: { invitationId?: string } }
  const invitationId = body.invitationId ?? body.invitation?.invitationId
  if (!invitationId) throw new Error(`invitation create returned no id: ${JSON.stringify(body)}`)
  return { invitationId, roleTitle, candidateEmail }
}

/** The current optimistic version, from the organizer's own list endpoint. */
export async function readInvitationVersion(
  invitationId: string,
  api: APIRequestContext,
): Promise<number> {
  const response = await api.get('/api/scheduling/invitations')
  if (response.status() !== 200) {
    throw new Error(`invitation list failed (${response.status()}) — is SCHEDULING_ENABLED set for this run?`)
  }
  const { invitations } = await response.json() as { invitations: Array<{ invitationId: string; version: number }> }
  const found = invitations.find((invitation) => invitation.invitationId === invitationId)
  if (!found) throw new Error(`invitation ${invitationId} is not in the organizer's list`)
  return found.version
}

export interface SentInvitation {
  /** The whole `/schedule/:id#secret` URL, exactly as the candidate receives it. */
  link: string
  /** The fragment, which is the only copy that will ever exist. */
  secret: string
}

/**
 * Sends an invitation and returns the link.
 *
 * Fails loudly when `devLink` is absent rather than returning an empty secret: a
 * spec that continues from here would report "the candidate portal refused the
 * secret", which is true and useless.
 */
export async function sendInvitation(
  harness: InterviewHarness,
  invitationId: string,
  api: APIRequestContext = harness.owner.api!,
): Promise<SentInvitation> {
  // The send is an optimistic state change, so it needs the version it saw — read it
  // from the list rather than assuming `1`, because a spec may have sent once already.
  const version = await readInvitationVersion(invitationId, api)
  const response = await api.post(`/api/scheduling/invitations/${invitationId}/send`, {
    data: { version, idempotencyKey: `send-${invitationId}-v${version}` },
  })
  if (response.status() >= 400) {
    throw new Error(`invitation send failed (${response.status()}): ${await response.text()}`)
  }
  const body = await response.json() as { devLink?: string | null }
  const link = body.devLink
  if (!link) {
    throw new Error(
      'send returned no devLink — the E2E email outbox seam is what makes the candidate flow testable; ' +
      'without it the secret does not exist anywhere',
    )
  }
  const secret = link.split('#')[1] ?? ''
  if (secret.length < 32) throw new Error(`send returned a link without a usable secret: ${link.split('#')[0]}#…`)
  return { link, secret }
}

/**
 * A candidate's request context, holding the invitation-scoped cookie.
 *
 * The exchange is the only endpoint that accepts the secret in a body, and this
 * mirrors exactly what the portal page does: POST the fragment once, then prove
 * every later request with the `HttpOnly` cookie. Contexts are tracked on the
 * harness so a spec cannot leak one.
 */
/** Distinct forwarded-for per candidate, so one spec's candidates do not share a rate-limit bucket. */
let candidateIpCounter = 0

export async function candidateContext(
  harness: InterviewHarness,
  invitationId: string,
  secret: string,
  options: { clientIp?: string } = {},
): Promise<APIRequestContext> {
  candidateIpCounter += 1
  /**
   * Each candidate gets its own `x-forwarded-for`.
   *
   * `getRateLimitId` keys the public budgets on the forwarded address, and every request context in
   * a spec file otherwise arrives from 127.0.0.1 — so a file that drives the whole candidate journey
   * a handful of times exhausts the 20-writes-per-minute budget and later tests fail with `429` for
   * a reason that has nothing to do with what they assert. Two real candidates are two addresses;
   * this makes the fixture match. A spec that *wants* to trip the limiter passes a fixed `clientIp`.
   */
  const clientIp = options.clientIp ?? `10.42.${Math.floor(candidateIpCounter / 250) % 250}.${candidateIpCounter % 250}`
  const context = await request.newContext({
    baseURL: harness.baseURL,
    /**
     * `Origin`, because the capability cookie is the only credential the public flow has.
     *
     * `isTrustedMutationOrigin` lets a cookie-less mutation through — that is how the exchange
     * below works at all — and refuses any cookie-bearing mutation with no matching origin. A
     * browser always sends one; an `APIRequestContext` does not, so without this every candidate
     * write answers `403 forbidden` and the spec would be measuring its own missing header.
     */
    extraHTTPHeaders: { origin: harness.baseURL, 'x-forwarded-for': clientIp },
  })
  harness.extraContexts.push(context)
  const response = await context.post(`/api/public/scheduling/${invitationId}/session`, {
    data: { secret },
  })
  if (response.status() >= 400) {
    throw new Error(`capability exchange failed (${response.status()}): ${await response.text()}`)
  }
  return context
}

/** An anonymous context with no capability cookie — the enumeration baseline. */
export async function anonymousContext(harness: InterviewHarness): Promise<APIRequestContext> {
  candidateIpCounter += 1
  const context = await request.newContext({
    baseURL: harness.baseURL,
    extraHTTPHeaders: { 'x-forwarded-for': `10.43.0.${candidateIpCounter % 250}` },
  })
  harness.extraContexts.push(context)
  return context
}

/**
 * An active paid subscription, which is what the interview features actually check.
 *
 * `checkEntitlement` reads `billing_subscriptions` and requires `stripe_status` of `active` or
 * `trialing` — not `organization_entitlements`, which is what `createOwnerPrincipal`'s `tier` seeds.
 * So a `tier: 'team'` fixture without this row is refused with `403 not_entitled` on every AI
 * feature, which is how the first run of the live-session spec failed: the tier looked right in one
 * table and the gate was reading the other.
 *
 * Stripe is never called. The rows are what a completed checkout leaves behind, and forging a webhook
 * to produce them would be testing the webhook.
 */
export async function seedActiveSubscription(
  harness: InterviewHarness,
  options: { tier?: 'pro' | 'pro_max' | 'team'; interval?: 'monthly' | 'annual' } = {},
): Promise<void> {
  const tier = options.tier ?? 'team'
  const interval = options.interval ?? 'monthly'
  const customerId = uniqueId('bcust')
  await harness.sql`
    insert into billing_customers (id, organization_id, livemode, stripe_customer_id)
    values (${customerId}, ${harness.organization.organizationId}, false, ${`cus_${customerId}`})
    on conflict (id) do nothing
  `
  await harness.sql`
    insert into billing_subscriptions
      (id, organization_id, customer_id, livemode, catalog_key, tier, interval, catalog_version,
       stripe_subscription_id, stripe_status, current_period_start, current_period_end)
    values (${uniqueId('bsub')}, ${harness.organization.organizationId}, ${customerId}, false,
            ${`${tier}_${interval}`}, ${tier}, ${interval}, 1,
            ${`sub_${uniqueId('s')}`}, 'active', now() - interval '1 day', now() + interval '30 days')
  `
}

/**
 * Tops up credits with a direct grant row.
 *
 * `grantCredits` is the product path and it requires a Stripe payment reference, so
 * a test that wanted credits would otherwise have to forge a webhook. The grant is
 * `operator_trial`, which is a real source the check constraint accepts, and the
 * reservation machinery reads it exactly as it reads a purchased pack — the only
 * thing skipped is the ledger entry, which nothing under test asserts on.
 */
export async function grantInterviewCredits(harness: InterviewHarness, units: number): Promise<string> {
  const grantId = uniqueId('grant')
  await harness.sql`
    insert into billing_credit_grants
      (id, organization_id, source, original_units, remaining_units, state, active_at, expires_at)
    values (${grantId}, ${harness.organization.organizationId}, 'operator_trial', ${units}, ${units},
            'active', now(), now() + interval '90 days')
  `
  return grantId
}

/** Remaining units across every active grant — what a reservation actually draws from. */
export async function readCreditBalance(harness: InterviewHarness): Promise<number> {
  const [row] = await harness.sql<{ remaining: number }[]>`
    select coalesce(sum(remaining_units), 0)::int as remaining
    from billing_credit_grants
    where organization_id = ${harness.organization.organizationId}
      and state = 'active' and expires_at > now()
  `
  return row?.remaining ?? 0
}
