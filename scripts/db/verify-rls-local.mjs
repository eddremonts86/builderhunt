import postgres from 'postgres'
import { createHash } from 'node:crypto'

const appUrl = process.env.RLS_TEST_APP_URL
const authUrl = process.env.RLS_TEST_AUTH_URL
const capabilityUrl = process.env.RLS_TEST_CAPABILITY_URL
const workerUrl = process.env.RLS_TEST_WORKER_URL
const platformUrl = process.env.RLS_TEST_PLATFORM_URL
if (!appUrl || !authUrl || !workerUrl || !platformUrl) throw new Error('All exact-role test URLs are required')
for (const value of [appUrl, authUrl, workerUrl, platformUrl]) {
  const databaseName = new URL(value).pathname.slice(1)
  if (!/^builderhunt_security_test_[A-Za-z0-9_]+$/.test(databaseName)) {
    throw new Error('RLS verifier refuses to run outside a named builderhunt_security_test database')
  }
}

const app = postgres(appUrl, { max: 2 })
const auth = postgres(authUrl, { max: 1 })
const worker = postgres(workerUrl, { max: 1 })
const capability = capabilityUrl ? postgres(capabilityUrl, { max: 1 }) : null
const platform = postgres(platformUrl, { max: 1 })

try {
  const missing = await app`select id from organization_builders order by id`
  if (missing.length !== 0) throw new Error('Missing context exposed tenant rows')

  const scoped = (organizationId) => app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`
    return transaction`select id from organization_builders order by id`
  })
  const [tenantA, tenantB] = await Promise.all([scoped('org-a'), scoped('org-b')])
  assertIds(tenantA, ['tracked-a'], 'org-a isolation')
  assertIds(tenantB, ['tracked-b'], 'org-b isolation')

  let crossTenantInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into organization_builders (
          id, organization_id, builder_identity_id, creator_user_id,
          visibility, status, private_metadata, created_at, updated_at
        ) values (
          'tracked-cross', 'org-b', 'identity-b', 'user-b',
          'private', 'tracked', '{}', now(), now()
        )
      `
    })
  } catch (error) {
    crossTenantInsertDenied = error?.code === '42501'
  }
  if (!crossTenantInsertDenied) throw new Error('Cross-tenant insert was not denied')

  const afterCommit = await app`select id from organization_builders`
  if (afterCommit.length !== 0) throw new Error('Pooled tenant context leaked after commit')

  const claimMissing = await app`select id from builder_claims`
  if (claimMissing.length !== 0) throw new Error('Missing user context exposed builder claims')
  const subjectClaims = await app.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', 'user-a', true)`
    return transaction`select id from builder_claims order by id`
  })
  assertIds(subjectClaims, ['claim-a'], 'claim subject isolation')
  let crossSubjectClaimDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', 'user-a', true)`
      await transaction`
        insert into builder_claims (
          id, builder_identity_id, subject_user_id, evidence_source, evidence_reference, status, created_at
        ) values ('claim-cross', 'identity-b', 'user-b', 'email', 'x@test.invalid', 'pending', now())
      `
    })
  } catch (error) {
    crossSubjectClaimDenied = error?.code === '42501'
  }
  if (!crossSubjectClaimDenied) throw new Error('Cross-subject claim insert was not denied')

  const billingMissing = await app`select id from billing_customers`
  if (billingMissing.length !== 0) throw new Error('Missing context exposed billing customers')
  const scopedBilling = (organizationId) => app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`
    return transaction`select id from billing_customers order by id`
  })
  const [billingTenantA, billingTenantB] = await Promise.all([scopedBilling('org-a'), scopedBilling('org-b')])
  assertIds(billingTenantA, ['billing-cust-a'], 'billing customer org-a isolation')
  assertIds(billingTenantB, ['billing-cust-b'], 'billing customer org-b isolation')

  // billing_customers is financial state — the app role gets SELECT only, never INSERT/UPDATE,
  // even inside its own tenant (spec.md: "Browser roles cannot mutate financial state directly").
  let appBillingInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into billing_customers (id, organization_id, livemode, stripe_customer_id, created_at, updated_at)
        values ('billing-cust-hack', 'org-a', false, 'cus_hack', now(), now())
      `
    })
  } catch (error) {
    appBillingInsertDenied = error?.code === '42501'
  }
  if (!appBillingInsertDenied) throw new Error('App role inserted financial-state billing row')

  let appBillingUpdateDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`update billing_customers set stripe_customer_id = 'hacked' where id = 'billing-cust-a'`
    })
  } catch (error) {
    appBillingUpdateDenied = error?.code === '42501'
  }
  if (!appBillingUpdateDenied) throw new Error('App role updated financial-state billing row')

  // billing_checkout_attempts is the one owner-initiated table the app role CAN write —
  // but only within its own tenant, never a spoofed organization_id.
  let checkoutSpoofDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into billing_checkout_attempts (
          id, organization_id, actor_user_id, livemode, action, catalog_key, idempotency_key,
          consent_versions, status, expires_at, created_at, updated_at
        ) values (
          'attempt-cross', 'org-b', 'user-a', false, 'subscription', 'pro_monthly', 'idem-cross',
          '{"terms":"v1","privacy":"v1"}', 'open', now() + interval '1 hour', now(), now()
        )
      `
    })
  } catch (error) {
    checkoutSpoofDenied = error?.code === '42501'
  }
  if (!checkoutSpoofDenied) throw new Error('App role created a checkout attempt under a spoofed organization')

  const billingWorkerMissing = await worker`select id from billing_customers`
  if (billingWorkerMissing.length !== 0) throw new Error('Worker missing context exposed billing customers')
  const workerBillingA = await worker.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`select id from billing_customers order by id`
  })
  assertIds(workerBillingA, ['billing-cust-a'], 'worker billing org-a isolation')
  let workerBillingCrossTenantDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-b', true)`
      await transaction`update billing_customers set stripe_customer_id = 'cross-tenant-hack' where id = 'billing-cust-a'`
    })
    const [unchanged] = await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      return transaction`select stripe_customer_id from billing_customers where id = 'billing-cust-a'`
    })
    workerBillingCrossTenantDenied = unchanged?.stripe_customer_id === 'cus_test_a'
  } catch {
    workerBillingCrossTenantDenied = true
  }
  if (!workerBillingCrossTenantDenied) throw new Error('Worker cross-tenant billing update was not denied')

  let platformBillingDenied = false
  try {
    await platform`select id from billing_customers`
  } catch (error) {
    platformBillingDenied = error?.code === '42501'
  }
  if (!platformBillingDenied) throw new Error('Platform role accessed tenant billing customer data')

  // user_devices — account-subject (app.user_id). App role is scoped read/write for its own
  // user_id (request-path device-cookie upsert); worker role got an unscoped, SELECT-only grant in
  // 0045 for cross-user linked-account clustering (there's no single user_id to scope a clustering
  // read by) — never INSERT/UPDATE, those stay exclusively with app.
  const devicesMissing = await app`select id from user_devices`
  if (devicesMissing.length !== 0) throw new Error('Missing user context exposed user_devices')
  const scopedDevices = (userId) => app.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', ${userId}, true)`
    return transaction`select id from user_devices order by id`
  })
  const [devicesA, devicesB] = await Promise.all([scopedDevices('user-a'), scopedDevices('user-b')])
  assertIds(devicesA, ['device-a'], 'user_devices user-a isolation')
  assertIds(devicesB, ['device-b'], 'user_devices user-b isolation')

  let crossSubjectDeviceInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', 'user-a', true)`
      await transaction`
        insert into user_devices (id, user_id, device_hash, ua_family, trust_state)
        values ('device-cross', 'user-b', 'hash-cross', 'chrome', 'new')
      `
    })
  } catch (error) {
    crossSubjectDeviceInsertDenied = error?.code === '42501'
  }
  if (!crossSubjectDeviceInsertDenied) throw new Error('Cross-subject user_devices insert was not denied')

  const workerDevicesAll = await worker`select id from user_devices order by id`
  assertIds(workerDevicesAll, ['device-a', 'device-b'], 'user_devices worker cross-user read')

  let workerDeviceInsertDenied = false
  try {
    await worker`
      insert into user_devices (id, user_id, device_hash, ua_family, trust_state)
      values ('device-worker-insert', 'user-a', 'hash-worker', 'chrome', 'new')
    `
  } catch (error) {
    workerDeviceInsertDenied = error?.code === '42501'
  }
  if (!workerDeviceInsertDenied) throw new Error('Worker role was able to insert into user_devices')

  // account_risk — account-subject, but app has NO grant at all: risk stage/score is written
  // exclusively by trusted worker/platform paths, never the browser-facing role.
  let appAccountRiskDenied = false
  try {
    await app`select user_id from account_risk`
  } catch (error) {
    appAccountRiskDenied = error?.code === '42501'
  }
  if (!appAccountRiskDenied) throw new Error('App role accessed account_risk')

  const riskMissing = await worker`select user_id from account_risk`
  if (riskMissing.length !== 0) throw new Error('Missing user context exposed account_risk')
  const scopedRisk = (userId) => worker.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', ${userId}, true)`
    return transaction`select user_id from account_risk order by user_id`
  })
  const [riskA, riskB] = await Promise.all([scopedRisk('user-a'), scopedRisk('user-b')])
  if (riskA.length !== 1 || riskA[0].user_id !== 'user-a') throw new Error('account_risk worker user-a isolation failed')
  if (riskB.length !== 1 || riskB[0].user_id !== 'user-b') throw new Error('account_risk worker user-b isolation failed')

  let workerCrossSubjectRiskDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', 'user-a', true)`
      await transaction`update account_risk set stage = 'blocked' where user_id = 'user-b'`
    })
    const [unchanged] = await worker.begin(async (transaction) => {
      await transaction`select set_config('app.user_id', 'user-b', true)`
      return transaction`select stage from account_risk where user_id = 'user-b'`
    })
    workerCrossSubjectRiskDenied = unchanged?.stage === 'observe'
  } catch {
    workerCrossSubjectRiskDenied = true
  }
  if (!workerCrossSubjectRiskDenied) throw new Error('Worker cross-subject account_risk update was not denied')

  const platformRiskMissing = await platform`select user_id from account_risk`
  if (platformRiskMissing.length !== 0) throw new Error('Platform role read account_risk rows with missing context')
  const platformRiskA = await platform.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', 'user-a', true)`
    return transaction`select user_id from account_risk order by user_id`
  })
  if (platformRiskA.length !== 1 || platformRiskA[0].user_id !== 'user-a') {
    throw new Error('Platform account_risk user-a scoped read failed')
  }

  // seat_usage_daily — tenant-private (app.organization_id), same shape as other tenant tables.
  const seatUsageMissing = await app`select id from seat_usage_daily`
  if (seatUsageMissing.length !== 0) throw new Error('Missing context exposed seat_usage_daily')
  const scopedSeatUsage = (organizationId) => app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`
    return transaction`select id from seat_usage_daily order by id`
  })
  const [seatUsageA, seatUsageB] = await Promise.all([scopedSeatUsage('org-a'), scopedSeatUsage('org-b')])
  assertIds(seatUsageA, ['usage-a'], 'seat_usage_daily org-a isolation')
  assertIds(seatUsageB, ['usage-b'], 'seat_usage_daily org-b isolation')

  let crossTenantSeatUsageInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into seat_usage_daily (id, organization_id, user_id, day, action, count, credit_units)
        values ('usage-cross', 'org-b', 'user-a', '2026-01-01', 'searches', 1, 0)
      `
    })
  } catch (error) {
    crossTenantSeatUsageInsertDenied = error?.code === '42501'
  }
  if (!crossTenantSeatUsageInsertDenied) throw new Error('Cross-tenant seat_usage_daily insert was not denied')

  // session_signals / abuse_signals — system-operational, no RLS; app gets no grant at all.
  let appSessionSignalsDenied = false
  try {
    await app`select id from session_signals`
  } catch (error) {
    appSessionSignalsDenied = error?.code === '42501'
  }
  if (!appSessionSignalsDenied) throw new Error('App role accessed session_signals')

  let appAbuseSignalsDenied = false
  try {
    await app`select id from abuse_signals`
  } catch (error) {
    appAbuseSignalsDenied = error?.code === '42501'
  }
  if (!appAbuseSignalsDenied) throw new Error('App role accessed abuse_signals')

  await worker`
    insert into abuse_signals (id, type, severity, user_id, organization_id)
    values ('signal-worker', 'seat_overuse', 'low', 'user-a', 'org-a')
  `
  const workerAbuseSignals = await worker`select id from abuse_signals order by id`
  if (workerAbuseSignals.length !== 1 || workerAbuseSignals[0].id !== 'signal-worker') {
    throw new Error('Worker abuse_signals read/write failed')
  }
  const platformAbuseSignals = await platform`select id from abuse_signals order by id`
  if (platformAbuseSignals.length !== 1 || platformAbuseSignals[0].id !== 'signal-worker') {
    throw new Error('Platform abuse_signals read failed')
  }

  const organizations = await auth`select id from organizations order by id`
  const organizationIds = organizations.map((row) => row.id)
  if (!organizationIds.includes('org-a') || !organizationIds.includes('org-b')) {
    throw new Error('Auth broker organization lifecycle failed')
  }
  let authProductAccessDenied = false
  try {
    await auth`select id from organization_builders`
  } catch (error) {
    authProductAccessDenied = error?.code === '42501'
  }
  if (!authProductAccessDenied) throw new Error('Auth broker accessed product tenant data')

  const workerMissing = await worker`select id from alerts`
  if (workerMissing.length !== 0) throw new Error('Worker missing context exposed alerts')
  const workerAlerts = await worker.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`select id from alerts order by id`
  })
  assertIds(workerAlerts, ['alert-a'], 'worker org-a isolation')
  let workerCrossTenantDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into alert_triggers (
          id, organization_id, alert_id, user_id, event_type, payload, matched_at
        ) values ('trigger-cross', 'org-b', 'alert-b', 'user-b', 'any_activity', '{}', now())
      `
    })
  } catch (error) {
    workerCrossTenantDenied = error?.code === '42501'
  }
  if (!workerCrossTenantDenied) throw new Error('Worker cross-tenant trigger insert was not denied')
  let workerAuthColumnsDenied = false
  try {
    await worker`select name from auth_users limit 1`
  } catch (error) {
    workerAuthColumnsDenied = error?.code === '42501'
  }
  if (!workerAuthColumnsDenied) throw new Error('Worker accessed unapproved auth user columns')

  const platformUsers = await platform`select id from auth_users order by id`
  if (!platformUsers.some((row) => row.id === 'user-a')) throw new Error('Platform account directory access failed')
  let platformProductDenied = false
  try {
    await platform`select id from saved_queries`
  } catch (error) {
    platformProductDenied = error?.code === '42501'
  }
  if (!platformProductDenied) throw new Error('Platform role accessed tenant product tables')

  const bootstrapUserId = 'user-bootstrap'
  const bootstrapHash = createHash('sha256')
    .update(`builderhunt:personal-organization:v1:${bootstrapUserId}`)
    .digest('hex')
    .slice(0, 24)
  const bootstrapOrganizationId = `org_personal_${bootstrapHash}`
  await auth`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values (${bootstrapUserId}, 'Bootstrap', 'bootstrap@test.invalid', true, now(), now())
    on conflict (id) do nothing
  `
  await auth`
    select bootstrap_personal_organization(
      ${bootstrapUserId},
      ${bootstrapOrganizationId},
      ${`personal-${bootstrapHash}`},
      ${`${bootstrapOrganizationId}:owner`}
    )
  `
  const bootstrapEntitlement = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${bootstrapOrganizationId}, true)`
    return transaction`select tier, status, seat_limit from organization_entitlements`
  })
  if (bootstrapEntitlement.length !== 1 || bootstrapEntitlement[0].tier !== 'free') {
    throw new Error('Atomic personal organization bootstrap failed')
  }

  // calendar-scheduling-interview-intelligence: private-user RLS. The org filter alone is not
  // enough here — an event is visible only to its owner or an access-granted participant, so an
  // ordinary member and even an org ADMIN who is not on the event must see nothing.
  const calendarOwner = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-a', true)`
    return transaction`select id from calendar_events order by id`
  })
  assertIds(calendarOwner, ['bbbbbbbb-0000-4000-8000-00000000000a'], 'calendar owner read')

  const calendarParticipant = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-c', true)`
    return transaction`select id from calendar_events order by id`
  })
  assertIds(calendarParticipant, ['bbbbbbbb-0000-4000-8000-00000000000a'], 'calendar participant read')

  // The participant may read but never mutate the owner's event.
  const participantUpdate = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-c', true)`
    const rows = await transaction`update calendar_events set title = 'hijacked' where id = 'bbbbbbbb-0000-4000-8000-00000000000a' returning id`
    return rows.length
  })
  if (participantUpdate !== 0) throw new Error('participant was able to update the owner event')

  const calendarAdmin = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-d', true)`
    await transaction`select set_config('app.organization_role', 'admin', true)`
    const events = await transaction`select id from calendar_events`
    const candidates = await transaction`select id from candidate_submissions`
    return { events: events.length, candidates: candidates.length }
  })
  if (calendarAdmin.events !== 0 || calendarAdmin.candidates !== 0) {
    throw new Error(`org admin without participation saw private calendar data: ${JSON.stringify(calendarAdmin)}`)
  }

  // A participant gets the event but never the candidate data hanging off the invitation.
  const participantCandidates = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-c', true)`
    const rows = await transaction`select id from candidate_submissions`
    return rows.length
  })
  if (participantCandidates !== 0) throw new Error('participant saw candidate submissions')

  // The accountless candidate. A capability secret is issued for ONE invitation,
  // so the row-level predicate must admit that invitation's data and nothing
  // else — not the rest of the organization's. Both candidates below live in
  // org-a: with only one seeded, an organization-scoped policy and an
  // invitation-scoped one would look identical.
  if (capability) {
    const INVITATION_A = 'dddddddd-0000-4000-8000-00000000000a'
    const INVITATION_B = 'dddddddd-0000-4000-8000-00000000000b'

    const asCandidateA = async (fn) => capability.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`select set_config('app.invitation_id', ${INVITATION_A}, true)`
      await transaction`select set_config('app.capability_owner_user_id', 'user-a', true)`
      return fn(transaction)
    })

    const ownInvitation = await asCandidateA((tx) => tx`select id from scheduling_invitations`)
    if (ownInvitation.length !== 1 || ownInvitation[0].id !== INVITATION_A) {
      throw new Error(`capability saw ${ownInvitation.length} invitations, expected only its own`)
    }

    const ownSubmission = await asCandidateA((tx) => tx`select id, invitation_id from candidate_submissions`)
    if (ownSubmission.length !== 1 || ownSubmission[0].invitation_id !== INVITATION_A) {
      throw new Error(`capability saw another candidate's submission: ${JSON.stringify(ownSubmission)}`)
    }

    // Two documents exist in org-a, one per candidate. Before 0089 this policy was
    // organization-scoped, so candidate A saw both; the count is the measurement that the narrowing
    // to `app.invitation_id` actually took effect.
    const ownDocuments = await asCandidateA((tx) => tx`select id, submission_id from candidate_documents`)
    if (ownDocuments.length !== 1) {
      throw new Error(`capability read ${ownDocuments.length} documents, expected its own single one`)
    }
    if (ownDocuments[0].submission_id !== 'eeeeeeee-0000-4000-8000-00000000000a') {
      throw new Error(`capability read the wrong candidate's document: ${JSON.stringify(ownDocuments)}`)
    }

    // Links, same shape. 0086 narrowed this policy too and nothing measured it until now.
    const ownLinks = await asCandidateA((tx) => tx`select id, submission_id from candidate_links`)
    if (ownLinks.length !== 1 || ownLinks[0].submission_id !== 'eeeeeeee-0000-4000-8000-00000000000a') {
      throw new Error(`capability read the wrong candidate's links: ${JSON.stringify(ownLinks)}`)
    }

    // Explicitly ask for the other candidate's rows by id. A policy that merely
    // filters a bare SELECT could still admit a targeted one.
    const targeted = await asCandidateA(async (tx) => {
      const invitations = await tx`select id from scheduling_invitations where id = ${INVITATION_B}`
      const submissions = await tx`select id from candidate_submissions where invitation_id = ${INVITATION_B}`
      // Asked for by primary key, which is the request a filtering bug would still answer.
      const documents = await tx`select id from candidate_documents where id = 'ffffffff-0000-4000-8000-00000000000c'`
      const links = await tx`select id from candidate_links where id = 'cccccccc-0000-4000-8000-00000000000b'`
      return invitations.length + submissions.length + documents.length + links.length
    })
    if (targeted !== 0) throw new Error(`capability reached the other candidate by id (${targeted} rows)`)

    // An unpinned connection must see nothing at all: `col = NULL` is NULL, so
    // forgetting to pin the invitation fails closed rather than opening up.
    const unpinned = await capability.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      const rows = await transaction`select id from candidate_submissions`
      return rows.length
    })
    if (unpinned !== 0) throw new Error(`capability without a pinned invitation saw ${unpinned} submissions`)

    /*
     * The candidate's WRITE, with RETURNING — the case none of these checks covered.
     *
     * Everything above is a read. `bookSlot` writes the interview event and reads it straight back
     * with `RETURNING`, and PostgreSQL evaluates the **SELECT** policies against the new row for the
     * returned columns. 0086 had scoped the capability SELECT to invitations whose `booked_event_id`
     * equals the row's id — a back-pointer written *after* the insert — so every booking failed with
     * `42501 new row violates row-level security policy` and the candidate got `400 invalid_input`.
     *
     * Nothing caught it: the booking-service tests run as the migration superuser (RLS bypassed),
     * the local `DATABASE_URL` is `postgres` (also a superuser), and the E2E harness pointed
     * `DATABASE_CAPABILITY_URL` at the developer's real database. The one role that would have
     * failed was the one role no test connected as for a write. 0096 fixes the policy; this asserts
     * it, in the shape the product actually uses.
     */
    const bookedEventId = await asCandidateA(async (tx) => {
      const [calendar] = await tx`select id from user_calendars where organization_id = 'org-a' limit 1`
      if (!calendar) throw new Error('the RLS fixture has no calendar for org-a to book into')
      const [row] = await tx`
        insert into calendar_events
          (organization_id, calendar_id, owner_user_id, type, status, title, starts_at, ends_at,
           timezone, all_day, busy, source_type, source_id)
        values ('org-a', ${calendar.id}, 'user-a', 'interview', 'confirmed', 'RLS booked interview',
                now() + interval '3 days', now() + interval '3 days 30 minutes',
                'Europe/Copenhagen', false, true, 'scheduling_invitation', ${INVITATION_A})
        returning id
      `
      return row?.id ?? null
    })
    if (!bookedEventId) throw new Error('capability could not insert its own interview event with RETURNING')

    // And the neighbouring candidate must not see it. The fix widened the SELECT predicate, so this
    // is the assertion that the widening did not become "any event in the organization".
    const neighbourSees = await capability.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`select set_config('app.invitation_id', ${INVITATION_B}, true)`
      await transaction`select set_config('app.capability_owner_user_id', 'user-a', true)`
      const rows = await transaction`select id from calendar_events where id = ${bookedEventId}`
      return rows.length
    })
    if (neighbourSees !== 0) {
      throw new Error(`another candidate's capability read the booked event (${neighbourSees} rows)`)
    }

    /*
     * `scheduling_busy_ranges` (drizzle/0097) must report that time as taken.
     *
     * The candidate's own row read cannot do this job — by design, since 0086 — and slot generation
     * depended on it, so the busy list came back empty and two candidates of the same organizer each
     * booked the same minute with a 200. The function returns two timestamps and refuses any owner
     * the caller's context does not pin.
     */
    const busyForNeighbour = await capability.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`select set_config('app.invitation_id', ${INVITATION_B}, true)`
      await transaction`select set_config('app.capability_owner_user_id', 'user-a', true)`
      return transaction`
        select starts_at from scheduling_busy_ranges('user-a', now(), now() + interval '10 days')
      `
    })
    if (busyForNeighbour.length === 0) {
      throw new Error('scheduling_busy_ranges reported no conflicts, so a taken slot would be offered as free')
    }

    // The owner cannot be chosen by the caller: asking about a different organizer returns nothing
    // rather than their calendar.
    const busyForStranger = await capability.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`select set_config('app.invitation_id', ${INVITATION_A}, true)`
      await transaction`select set_config('app.capability_owner_user_id', 'user-a', true)`
      return transaction`
        select starts_at from scheduling_busy_ranges('user-b', now() - interval '365 days', now() + interval '365 days')
      `
    })
    if (busyForStranger.length !== 0) {
      throw new Error(`scheduling_busy_ranges answered for an owner the caller does not hold (${busyForStranger.length} rows)`)
    }
  }

  // candidate_documents / document_extractions (Phase 6): ownership is proven by walking back to
  // the invitation's owner, so the interesting cases are the three principals who are *inside* the
  // organization and must still see nothing — a participant, an org admin, and a colleague — plus
  // tenant B, which must not even reach the join.
  // `user-a` owns both org-a invitations, so both candidates' documents are legitimately theirs —
  // that is the difference between the owner policy and the capability one, which is now scoped to a
  // single invitation. Asserted by id rather than by count, so this states which rows are expected
  // instead of tracking whatever the fixture happens to insert.
  const documentsOwner = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-a', true)`
    const docs = await transaction`select id from candidate_documents order by id`
    const extractions = await transaction`select id from document_extractions`
    return { docs: docs.map((row) => row.id), extractions: extractions.length }
  })
  const expectedOwnerDocs = [
    'ffffffff-0000-4000-8000-00000000000a',
    'ffffffff-0000-4000-8000-00000000000c',
  ]
  if (documentsOwner.docs.join(',') !== expectedOwnerDocs.join(',') || documentsOwner.extractions !== 1) {
    throw new Error(`invitation owner could not read their own documents: ${JSON.stringify(documentsOwner)}`)
  }

  for (const [label, userId] of [['participant', 'user-c'], ['org admin', 'user-d']]) {
    const seen = await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`select set_config('app.user_id', ${userId}, true)`
      await transaction`select set_config('app.organization_role', 'admin', true)`
      const docs = await transaction`select id from candidate_documents`
      const extractions = await transaction`select id from document_extractions`
      return docs.length + extractions.length
    })
    if (seen !== 0) throw new Error(`${label} saw candidate documents they do not own (${seen} rows)`)
  }

  const documentsTenantB = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-b', true)`
    await transaction`select set_config('app.user_id', 'user-b', true)`
    const docs = await transaction`select id from candidate_documents`
    const extractions = await transaction`select id from document_extractions`
    return docs.length + extractions.length
  })
  if (documentsTenantB !== 0) throw new Error(`tenant B read tenant A's candidate documents (${documentsTenantB} rows)`)

  // The scanner and the retention sweeper run as the worker and must see the row they are asked to
  // act on — a policy that hides it would leave infected files unscanned and expired ones undeleted.
  const documentsWorker = await worker.begin(async (transaction) => {
    const rows = await transaction`select id from candidate_documents`
    return rows.length
  })
  // The worker is cross-tenant by design and sees every document there is — two in org-a now.
  if (documentsWorker !== 2) throw new Error(`worker could not read candidate documents (${documentsWorker} rows)`)

  // interview_briefs (Phase 8): the narrowest policy in the schema. A brief is an assessment of a named
  // person, so it is readable by the organizer who owns it and by a colleague *explicitly granted* access
  // to that interview — and by nobody else, including an organization admin.
  const readBriefs = async (userId, organizationId = 'org-a') => app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`
    await transaction`select set_config('app.user_id', ${userId}, true)`
    await transaction`select set_config('app.organization_role', 'admin', true)`
    const rows = await transaction`select id from interview_briefs`
    return rows.length
  })

  if (await readBriefs('user-a') !== 1) throw new Error('brief owner could not read their own brief')
  // `user-c` is a participant with access_granted = true.
  if (await readBriefs('user-c') !== 1) throw new Error('granted participant could not read the brief')
  // `user-d` is an org ADMIN *and* a participant with access_granted = false. Both paths must fail: an
  // admin manages seats and billing without reading a colleague's evaluation of a candidate, and being
  // listed on an event is not the same act as being granted its preparation material.
  if (await readBriefs('user-d') !== 0) throw new Error('an admin / non-granted participant read a brief they do not own')
  if (await readBriefs('user-b', 'org-b') !== 0) throw new Error("tenant B read tenant A's brief")

  // Asked for by primary key, which is the request a filtering bug would still answer.
  const targetedBrief = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-d', true)`
    const rows = await transaction`select id from interview_briefs where id = 'aaaaaaaa-1111-4000-8000-00000000000a'`
    return rows.length
  })
  if (targetedBrief !== 0) throw new Error('a non-granted user reached a brief by id')

  // The worker sweeps expired briefs and must see them.
  const briefsWorker = await worker.begin(async (transaction) => {
    const rows = await transaction`select id from interview_briefs`
    return rows.length
  })
  if (briefsWorker !== 1) throw new Error(`worker could not read interview briefs (${briefsWorker} rows)`)

  // interview_sessions / transcript_segments (Phase 9): the same owner-or-granted-participant shape as
  // interview_briefs, because they hold what a named candidate actually said. Segments inherit their rule
  // through the session, so this also proves that inheritance works rather than trusting the join.
  const readLive = async (userId, organizationId = 'org-a') => app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`
    await transaction`select set_config('app.user_id', ${userId}, true)`
    await transaction`select set_config('app.organization_role', 'admin', true)`
    const sessions = await transaction`select id from interview_sessions`
    const segments = await transaction`select id from transcript_segments`
    return { sessions: sessions.length, segments: segments.length }
  })

  const liveOwner = await readLive('user-a')
  if (liveOwner.sessions !== 1 || liveOwner.segments !== 1) {
    throw new Error(`session owner could not read their own session/transcript: ${JSON.stringify(liveOwner)}`)
  }
  // `user-c` is a participant with access_granted = true: reads both, writes neither.
  const liveParticipant = await readLive('user-c')
  if (liveParticipant.sessions !== 1 || liveParticipant.segments !== 1) {
    throw new Error(`granted participant could not read the session/transcript: ${JSON.stringify(liveParticipant)}`)
  }
  // `user-d` is an org admin AND a participant with access_granted = false. Both paths must fail.
  const liveAdmin = await readLive('user-d')
  if (liveAdmin.sessions !== 0 || liveAdmin.segments !== 0) {
    throw new Error(`an admin / non-granted participant read a transcript: ${JSON.stringify(liveAdmin)}`)
  }
  const liveTenantB = await readLive('user-b', 'org-b')
  if (liveTenantB.sessions !== 0 || liveTenantB.segments !== 0) {
    throw new Error(`tenant B read tenant A's transcript: ${JSON.stringify(liveTenantB)}`)
  }

  // A granted participant may read a segment but must not write one: segments arrive from the organizer's
  // capture client, and a second writer would break the sequence contract.
  // Caught *outside* `begin`, not inside it. A rejected statement aborts the transaction, so a
  // try/catch within the block swallows the error and then the commit fails anyway — the refusal is
  // real, but the test reports it as an unhandled failure rather than as the pass it is.
  let participantWrite = 'refused'
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`select set_config('app.user_id', 'user-c', true)`
      await transaction`
        insert into transcript_segments (organization_id, session_id, provider_segment_id, sequence, speaker_estimate, text, starts_ms, ends_ms, retention_expires_at)
        values ('org-a', '11111111-2222-4000-8000-00000000000a', 'prov-injected', 99, 'speaker_a', 'injected', 0, 500, now() + interval '90 days')
      `
      participantWrite = 'inserted'
    })
  } catch {
    participantWrite = 'refused'
  }
  if (participantWrite !== 'refused') throw new Error('a granted participant wrote a transcript segment')

  // The retention sweeper runs as the worker and must see both.
  const liveWorker = await worker.begin(async (transaction) => {
    const sessions = await transaction`select id from interview_sessions`
    const segments = await transaction`select id from transcript_segments`
    return sessions.length + segments.length
  })
  if (liveWorker !== 2) throw new Error(`worker could not read live interview rows (${liveWorker})`)

  // availability_policies: owner-only, and specifically NOT readable by an org admin. This table
  // is where a policy's version and default reminder settings live, so a leak here would expose
  // when a colleague changed their working hours.
  const availabilityOwner = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-a', true)`
    return transaction`select id from availability_policies order by id`
  })
  assertIds(availabilityOwner, ['eeeeeeee-0000-4000-8000-00000000000a'], 'availability policy owner read')

  const availabilityAdmin = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-d', true)`
    await transaction`select set_config('app.organization_role', 'admin', true)`
    const rows = await transaction`select id from availability_policies`
    return rows.length
  })
  if (availabilityAdmin !== 0) throw new Error('org admin saw another member\'s availability policy')

  const availabilityForeignWrite = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-c', true)`
    const rows = await transaction`update availability_policies set version = 99 where organization_id = 'org-a' returning id`
    return rows.length
  })
  if (availabilityForeignWrite !== 0) throw new Error('a non-owner was able to rewrite an availability policy')

  const calendarSpoofedUser = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-a-attacker', true)`
    const rows = await transaction`select id from calendar_events`
    return rows.length
  })
  if (calendarSpoofedUser !== 0) throw new Error('spoofed user id saw calendar rows')

  let calendarCrossTenantInsert = 'allowed'
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`select set_config('app.user_id', 'user-a', true)`
      await transaction`
        insert into calendar_events (organization_id, calendar_id, owner_user_id, type, status, title, starts_at, ends_at, timezone)
        values ('org-b', 'aaaaaaaa-0000-4000-8000-00000000000b', 'user-a', 'personal', 'scheduled', 'X', now(), now() + interval '1 hour', 'UTC')
      `
    })
  } catch {
    calendarCrossTenantInsert = 'denied'
  }
  if (calendarCrossTenantInsert !== 'denied') throw new Error('cross-tenant calendar insert was allowed')

  /*
   * The worker is org-scoped with no session user, and has no write path into candidate data.
   *
   * Asserted as a property, not as a row list. This was `assertIds(…, [fixtureEvent])`, which
   * compares the whole list by strict equality — so the booking assertion above, which legitimately
   * inserts a second `org-a` event to prove 0096's capability policy, turned this gate red on
   * something that is not a leak. Worse, `order by id` over random UUIDs made the failure order
   * vary between runs. What this gate is actually for is "the worker sees its organization and
   * nothing else", so that is what it now checks: every visible row belongs to `org-a`, and the
   * fixture event is among them — the second half is what stops an empty result passing as a green.
   */
  const workerCalendar = await worker.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`select id, organization_id from calendar_events order by id`
  })
  const foreignRows = workerCalendar.filter((row) => row.organization_id !== 'org-a')
  if (foreignRows.length > 0) {
    throw new Error(`worker calendar scope failed: rows from another organization: ${JSON.stringify(foreignRows)}`)
  }
  if (!workerCalendar.some((row) => row.id === 'bbbbbbbb-0000-4000-8000-00000000000a')) {
    throw new Error(`worker calendar scope failed: fixture event missing: ${JSON.stringify(workerCalendar.map((r) => r.id))}`)
  }

  let workerCandidateWrite = 'allowed'
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`update candidate_submissions set display_name = 'x' where organization_id = 'org-a'`
    })
  } catch {
    workerCandidateWrite = 'denied'
  }
  if (workerCandidateWrite !== 'denied') throw new Error('worker was able to rewrite candidate data')

  /*
   * Credit writes: the app role must borrow the worker role, and borrowing must not widen scope.
   *
   * `drizzle/0028` grants the app role SELECT only on the credit tables, so `goLive`'s reservation
   * INSERT failed with 42501 for every interview — invisibly, because unit tests run as the migration
   * superuser and `.env` pointed at `postgres` until 2026-07-29. `drizzle/0098` makes the app role a
   * *member* of the worker role so the write can happen in the caller's transaction (atomicity), and
   * these three assertions are the reason that is safe rather than equivalent to granting the table.
   */
  let creditWriteUnelevated = 'allowed'
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into billing_credit_reservations (id, organization_id, operation, rate_card_version, idempotency_key, maximum_units, state, heartbeat_at, deadline_at)
        values ('rls-unelevated', 'org-a', 'interview_live_transcription', 1, 'rls-unelevated-key', 1, 'reserved', now(), now() + interval '1 hour')
      `
    })
  } catch (error) {
    // The code matters: any other failure is a broken test, not a denied write.
    creditWriteUnelevated = error?.code === '42501' ? 'denied' : `unexpected:${error?.code}`
  }
  if (creditWriteUnelevated !== 'denied') {
    throw new Error('app role wrote a credit reservation without elevating — 0028\'s SELECT-only grant is gone')
  }

  const creditWriteElevated = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`set local role builderhunt_worker`
    const rows = await transaction`
      insert into billing_credit_reservations (id, organization_id, operation, rate_card_version, idempotency_key, maximum_units, state, heartbeat_at, deadline_at)
      values ('rls-elevated', 'org-a', 'interview_live_transcription', 1, 'rls-elevated-key', 1, 'reserved', now(), now() + interval '1 hour')
      returning id
    `
    await transaction`reset role`
    // Same transaction, and the app role is back: this is what makes it atomic with the caller's
    // other writes rather than a second connection that can be left half-applied.
    const afterReset = await transaction`select has_table_privilege('billing_credit_reservations', 'INSERT') as can`
    if (afterReset[0].can !== false) throw new Error('reset role did not drop the elevated privilege')
    return rows.length
  })
  if (creditWriteElevated !== 1) throw new Error('elevated credit write did not insert')

  let creditWriteCrossTenant = 'allowed'
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`set local role builderhunt_worker`
      await transaction`
        insert into billing_credit_reservations (id, organization_id, operation, rate_card_version, idempotency_key, maximum_units, state, heartbeat_at, deadline_at)
        values ('rls-cross', 'org-b', 'interview_live_transcription', 1, 'rls-cross-key', 1, 'reserved', now(), now() + interval '1 hour')
      `
    })
  } catch (error) {
    creditWriteCrossTenant = error?.code === '42501' ? 'denied' : `unexpected:${error?.code}`
  }
  if (creditWriteCrossTenant !== 'denied') {
    throw new Error('elevating to the worker role let the app write another organization\'s credits')
  }

  console.log(JSON.stringify({
    missingContext: 'denied',
    tenantA: tenantA.map((row) => row.id),
    tenantB: tenantB.map((row) => row.id),
    crossTenantInsert: 'denied',
    poolReuse: 'clean',
    claimSubjectIsolation: subjectClaims.map((row) => row.id),
    crossSubjectClaimInsert: 'denied',
    authProductAccess: 'denied',
    creditWriteUnelevated: 'denied',
    creditWriteElevated: 'inserted',
    creditWriteCrossTenant: 'denied',
    workerMissingContext: 'denied',
    workerTenantIsolation: workerAlerts.map((row) => row.id),
    workerCrossTenantInsert: 'denied',
    workerAuthColumns: 'restricted',
    platformProductAccess: 'denied',
    personalOrganizationBootstrap: 'atomic',
    billingTenantA: billingTenantA.map((row) => row.id),
    billingTenantB: billingTenantB.map((row) => row.id),
    appBillingInsert: 'denied',
    appBillingUpdate: 'denied',
    checkoutAttemptSpoof: 'denied',
    workerBillingMissingContext: 'denied',
    workerBillingTenantIsolation: workerBillingA.map((row) => row.id),
    workerBillingCrossTenantUpdate: 'denied',
    platformBillingAccess: 'denied',
    userDevicesA: devicesA.map((row) => row.id),
    userDevicesB: devicesB.map((row) => row.id),
    crossSubjectDeviceInsert: 'denied',
    appAccountRiskAccess: 'denied',
    accountRiskWorkerIsolation: [riskA[0].user_id, riskB[0].user_id],
    workerCrossSubjectRiskUpdate: 'denied',
    platformAccountRiskScoped: platformRiskA.map((row) => row.user_id),
    seatUsageDailyA: seatUsageA.map((row) => row.id),
    seatUsageDailyB: seatUsageB.map((row) => row.id),
    crossTenantSeatUsageInsert: 'denied',
    appSessionSignalsAccess: 'denied',
    appAbuseSignalsAccess: 'denied',
    workerAbuseSignals: workerAbuseSignals.map((row) => row.id),
    platformAbuseSignals: platformAbuseSignals.map((row) => row.id),
    calendarOwnerRead: calendarOwner.map((row) => row.id),
    calendarParticipantRead: calendarParticipant.map((row) => row.id),
    calendarParticipantUpdate: 'denied',
    calendarAdminWithoutParticipation: 'denied',
    calendarParticipantCandidateAccess: 'denied',
    calendarSpoofedUser: 'denied',
    calendarCrossTenantInsert: 'denied',
    workerCalendarScope: workerCalendar.map((row) => row.id),
    availabilityPolicyOwnerRead: availabilityOwner.map((row) => row.id),
    availabilityPolicyAdminRead: 'denied',
    availabilityPolicyForeignWrite: 'denied',
    workerCandidateWrite: 'denied',
  }))
} finally {
  await Promise.all([app.end(), auth.end(), worker.end(), platform.end(), capability?.end()].filter(Boolean))
}

function assertIds(rows, expected, label) {
  const actual = rows.map((row) => row.id)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} failed: ${JSON.stringify(actual)}`)
  }
}
