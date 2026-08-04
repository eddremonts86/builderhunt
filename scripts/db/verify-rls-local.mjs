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

  // ── Tables carrying a `*_public_select` policy get their own A/B, and they need one ────────────────
  //
  // Added 2026-08-04 after finding that `saved_queries_public_select` and `feed_capabilities_public_select`
  // were `USING (id IS NOT NULL)` — true for every row. Both are PERMISSIVE and both target
  // `builderhunt_app`, and Postgres ORs permissive policies, so each one silently made its table's tenant
  // policy irrelevant. `drizzle/0145` narrowed them.
  //
  // Nothing here would have caught it: the A/B above only covers `organization_builders`, and the
  // api-isolation suite passes because it goes through the query layer, which filters `organization_id` in
  // SQL regardless of what RLS permits. So a table is only actually covered if *this* file scopes it as the
  // app role and asserts the negative half. Any future `*_public_select` policy belongs in this block.
  const scopedSaved = (organizationId) => app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`
    return transaction`select id from saved_queries order by id`
  })
  const [savedA, savedB] = await Promise.all([scopedSaved('org-a'), scopedSaved('org-b')])
  assertIds(savedA, ['query-a'], 'saved_queries org-a isolation')
  assertIds(savedB, ['query-b'], 'saved_queries org-b isolation')

  const scopedFeeds = (organizationId) => app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', ${organizationId}, true)`
    return transaction`select id from feed_capabilities order by id`
  })
  const [feedsA, feedsB] = await Promise.all([scopedFeeds('org-a'), scopedFeeds('org-b')])
  assertIds(feedsA, ['feed-a'], 'feed_capabilities org-a isolation')
  assertIds(feedsB, ['feed-b'], 'feed_capabilities org-b isolation')

  // The narrowed policy still has to let the anonymous feed read work — that is the whole reason it exists.
  // No tenant context at all here, which is the anonymous subscriber's situation.
  const publicFeedRead = await app`select id from saved_queries where id = 'query-a'`
  if (publicFeedRead.length !== 1) {
    throw new Error('Narrowed saved_queries_public_select broke the anonymous feed read (live capability)')
  }
  // And revocation must cut it off at the row level, not merely in the route's own branching.
  //
  // Revoked as `worker`, not as `app`: `feed_capabilities_app_update` is scoped by
  // `organization_id = current_setting('app.organization_id')`, so an `app` UPDATE with no tenant context
  // matches zero rows and silently changes nothing — the first version of this check did exactly that and
  // then "failed" because the capability was still live. `feed_capabilities_worker_all` is `ALL … USING
  // (true)`, which is the connection that legitimately owns this write.
  await worker`update feed_capabilities set revoked_at = now() where id = 'feed-a'`
  const revokedFeedRead = await app`select id from saved_queries where id = 'query-a'`
  await worker`update feed_capabilities set revoked_at = null where id = 'feed-a'`
  if (revokedFeedRead.length !== 0) {
    throw new Error('A revoked feed capability still exposed its saved query')
  }

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

  // `builder_claims_public_portfolio_select` (0111) additively lets the app role read *verified*
  // claims with no `app.user_id` context at all — the public portfolio page's anonymous read. This
  // must not leak a step further: a claim still pending its owner's verification stays invisible
  // with no context, same as before 0111.
  const claimMissingNoContext = await app`select id from builder_claims order by id`
  assertIds(claimMissingNoContext, ['claim-a', 'claim-b'], 'anonymous public portfolio read (verified only)')
  const pendingClaimLeaked = claimMissingNoContext.some((row) => row.id === 'claim-pending')
  if (pendingClaimLeaked) throw new Error('Anonymous read exposed a pending (unverified) builder claim')
  // user-a owns claim-a and, via 0111's additive public policy, also sees claim-b — claim-b is
  // verified and therefore publicly readable by anyone, which is the intended behavior now, not a
  // subject-isolation leak. claim-pending must stay invisible: it belongs to a different subject
  // and is not verified.
  const subjectClaims = await app.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', 'user-a', true)`
    return transaction`select id from builder_claims order by id`
  })
  assertIds(subjectClaims, ['claim-a', 'claim-b'], 'claim subject read + public verified read')

  const otherSubjectSeesPending = await app.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', 'user-a', true)`
    return transaction`select id from builder_claims where id = 'claim-pending'`
  })
  if (otherSubjectSeesPending.length !== 0) throw new Error("A non-owner read another subject's pending claim")

  const pendingOwnerSeesOwnClaim = await app.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', 'user-pending-claimant', true)`
    return transaction`select id from builder_claims where id = 'claim-pending'`
  })
  if (pendingOwnerSeesOwnClaim.length !== 1) throw new Error("The pending claim's own subject could not read their own claim")

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

  // `builder_claims_platform_revoke` (0116) — the admin revoke route writes through `platformDb`,
  // not `publicDb`/`app`, precisely because `app`'s own update policy is owner-scoped and can never
  // touch another subject's row. Confirm both halves: the platform role CAN flip a verified claim
  // to revoked, and the app role (even with no context at all) still cannot.
  const [platformRevoked] = await platform`
    update builder_claims set status = 'revoked', revoked_at = now() where id = 'claim-b' and status = 'verified' returning id
  `
  if (platformRevoked?.id !== 'claim-b') throw new Error('Platform role could not revoke a verified claim')

  // The app role's own UPDATE policy exists (`builder_claims_app_update`) — with no `app.user_id`
  // context, its USING clause compares `subject_user_id` to NULL, which is never true, so RLS
  // silently filters every row rather than throwing. A thrown error is not the signal here; a
  // returned empty row set is.
  const appRevokeAttempt = await app`update builder_claims set status = 'revoked' where id = 'claim-a' returning id`
  if (appRevokeAttempt.length !== 0) throw new Error('App role (no context) revoked a builder claim directly')

  // The platform policy's USING clause is `status = 'verified'` — a pending claim must stay
  // untouchable by this same role, not just by app. No thrown error is expected here (RLS silently
  // filters rows rather than erroring on an UPDATE that matches nothing) — the row simply must not
  // have changed. Platform has no SELECT policy on this table at all, so read the result back as
  // the claim's own subject (app role, same technique as `pendingOwnerSeesOwnClaim` above).
  await platform`update builder_claims set status = 'revoked' where id = 'claim-pending'`
  const [pendingStillPending] = await app.begin(async (transaction) => {
    await transaction`select set_config('app.user_id', 'user-pending-claimant', true)`
    return transaction`select status from builder_claims where id = 'claim-pending'`
  })
  if (pendingStillPending?.status !== 'pending') throw new Error('Platform role revoked a non-verified (pending) claim')

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

  /*
   * `createBillingCustomerIfAbsent`'s elevated insert (found 2026-07-31 exercising a real Stripe
   * test-mode checkout live): the app role has no INSERT grant on `billing_customers` at all (the
   * two assertions above), but a real user-initiated checkout still needs to create one on first
   * use. `~/shared/lib/repositories/billing.ts` elevates via the same `builderhunt_app` →
   * `builderhunt_worker` membership `0098` grants for credit writes — this asserts that elevation
   * actually lands a real row, not just that the unelevated path is denied.
   */
  // livemode=true — the fixture's own 'billing-cust-a' already occupies (org-a, livemode=false)
  // under `billing_customers_org_livemode_unique`.
  const elevatedCustomerInsert = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`set local role builderhunt_worker`
    const rows = await transaction`
      insert into billing_customers (id, organization_id, livemode, stripe_customer_id, created_at, updated_at)
      values ('rls-elevated-customer', 'org-a', true, 'cus_rls_elevated', now(), now())
      returning id
    `
    await transaction`reset role`
    return rows.length
  })
  if (elevatedCustomerInsert !== 1) throw new Error('Elevated billing_customers insert did not land')

  let elevatedCustomerCrossTenant = 'allowed'
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`set local role builderhunt_worker`
      await transaction`
        insert into billing_customers (id, organization_id, livemode, stripe_customer_id, created_at, updated_at)
        values ('rls-elevated-customer-cross', 'org-b', true, 'cus_rls_elevated_cross', now(), now())
      `
    })
  } catch {
    elevatedCustomerCrossTenant = 'denied'
  }
  if (elevatedCustomerCrossTenant !== 'denied') {
    throw new Error('Elevating to the worker role let the app write another organization\'s billing_customers row')
  }

  /*
   * `findOrganizationOwnerEmail` (found in the same live checkout session): `organization_members`
   * and `auth_users` are both auth-broker-owned tables neither `builderhunt_app` nor
   * `builderhunt_worker` can read — only `builderhunt_auth` (what `authDb` connects as) and
   * `builderhunt_platform` can. This asserts the auth role can actually perform the exact join the
   * repository function runs, and gets the real owner back, not just that the other two roles are
   * denied it.
   */
  const ownerEmailViaAuth = await auth`
    select au.email
    from organization_members om
    inner join auth_users au on om.user_id = au.id
    where om.organization_id = 'org-a' and om.role = 'owner'
    limit 1
  `
  if (ownerEmailViaAuth.length !== 1 || ownerEmailViaAuth[0].email !== 'a@test.invalid') {
    throw new Error(`Auth-broker owner-email join failed: ${JSON.stringify(ownerEmailViaAuth)}`)
  }

  // Interview material access is the event owner's to give. `event_participants_app_self_update`
  // (0069) lets an attendee write their own row so they can RSVP, and the app role holds table-wide
  // UPDATE, so without the trigger from 0101 a participant could set `material_access_granted` on
  // themselves and read the candidate's transcript. RLS cannot express this — it is row-level, and
  // this is the same row either way — so the trigger is the only thing standing there.
  let selfGrantDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`select set_config('app.user_id', 'user-c', true)`
      await transaction`
        update event_participants set material_access_granted = true
        where id = 'cccccccc-0000-4000-8000-00000000000a'
      `
    })
  } catch (error) {
    selfGrantDenied = error?.code === '42501'
  }
  if (!selfGrantDenied) throw new Error('A participant granted themselves interview material access')

  // The same statement from the event owner must work, or the guard above would be indistinguishable
  // from the feature being broken.
  await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-a', true)`
    await transaction`
      update event_participants set material_access_granted = true
      where id = 'cccccccc-0000-4000-8000-00000000000a'
    `
  })
  const [ownerGranted] = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`select set_config('app.user_id', 'user-a', true)`
    return transaction`
      select material_access_granted from event_participants
      where id = 'cccccccc-0000-4000-8000-00000000000a'
    `
  })
  if (ownerGranted?.material_access_granted !== true) {
    throw new Error('The event owner could not grant interview material access')
  }

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
  // Includes 'rls-elevated-customer': the elevated-insert assertion above already landed it in
  // org-a before this section runs.
  assertIds(workerBillingA, ['billing-cust-a', 'rls-elevated-customer'], 'worker billing org-a isolation')
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

  /**
   * The operator grant, as the role that actually performs it.
   *
   * This exists because its absence hid a real defect. `grantOrganizationEntitlement` originally wrote
   * `organization_entitlements` straight through `platformDb`, and `builderhunt_platform` has no privilege on
   * that table at all — the owner-facing grant was dead in production while its unit tests passed, because they
   * connect as the migration superuser. `drizzle/0141` added the narrow SECURITY DEFINER function; these three
   * checks are the part no unit test can make.
   *
   * All three matter together: the function must work, and the two direct routes to the same table must stay
   * shut. A passing first check with a passing second would mean the migration had simply granted the table.
   */
  const grantOrgId = 'org-a'
  const [grantedByPlatform] = await platform`
    select tier, seat_limit from platform_admin_grant_organization_entitlement(
      ${grantOrgId}, 'team', 'active', 10, 'rls verifier grant', null
    )
  `
  if (grantedByPlatform?.tier !== 'team' || Number(grantedByPlatform?.seat_limit) !== 10) {
    throw new Error('Platform role could not perform the operator grant through its SECURITY DEFINER function')
  }

  let platformEntitlementWriteDenied = false
  try {
    await platform`
      insert into organization_entitlements (
        organization_id, tier, status, billing_period, seat_limit, created_at, updated_at
      ) values (${grantOrgId}, 'team', 'active', 'none', 10, now(), now())
      on conflict (organization_id) do update set tier = 'team'
    `
  } catch (error) {
    platformEntitlementWriteDenied = error?.code === '42501'
  }
  if (!platformEntitlementWriteDenied) {
    throw new Error('Platform role wrote organization_entitlements directly — the grant function is not the only path')
  }

  /**
   * The cross-organization worker loop's very first query.
   *
   * `repositories/billing-worker.ts` and `repositories/sprints-worker.ts` both start their per-organization loop
   * with `listWorkerOrganizationIds()` — an unscoped `select id from organizations` as the worker role, which
   * `billing-worker.ts`'s own comment describes as "an unscoped read of the (non-tenant-private) organizations
   * table". Every billing worker sweep, reconciliation run and sprint run depends on it.
   *
   * Added 2026-08-04 because that assumption could not be confirmed from outside: `organizations`'s ACL grants
   * SELECT to `builderhunt_app` and `builderhunt_auth` and names no worker, yet an ad-hoc `SET ROLE` probe read
   * a row anyway, and the two could not be reconciled with ad-hoc tooling. This is the connection that settles
   * it — a real `builderhunt_worker` login against a real migrated database. If it throws 42501, the worker
   * loops are dead and this is where that gets said out loud instead of at 03:00 on a cron.
   */
  const workerOrganizationIds = await worker`select id from organizations order by id`
  if (workerOrganizationIds.length === 0) {
    throw new Error('Worker role read no organizations — the cross-organization worker loop would process nothing')
  }

  let platformEntitlementReadDenied = false
  try {
    await platform`select tier from organization_entitlements where organization_id = ${grantOrgId}`
  } catch (error) {
    platformEntitlementReadDenied = error?.code === '42501'
  }
  if (!platformEntitlementReadDenied) {
    throw new Error('Platform role read organization_entitlements directly — it must go through platform_admin_user_billing_summary')
  }

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

  // ── Stripe billing platform (plan 30) — the remaining 16 of 19 billing_* tables ──────────────────
  //
  // Found 2026-07-31: only billing_customers, billing_checkout_attempts, and
  // billing_credit_reservations had any live-role assertion here, and the latter two only for their
  // write-permission shape, never ordinary SELECT isolation. The team had already found and fixed
  // this exact class of bug twice by hand (credit reservations, reconciliation) with no automated
  // gate to have caught either. Each table below gets the isolation/permission shape its own grants
  // actually specify — asymmetric ones (ledger's no-UPDATE-ever, refunds' WITH CHECK, seller
  // profiles denying even the worker) are the ones worth measuring, not a copy-pasted default.

  const tenantIsolation = async (table, idsA, idsB) => {
    const missing = await app`select id from ${app(table)}`
    if (missing.length !== 0) throw new Error(`Missing context exposed ${table}`)
    const scoped = (organizationId) => app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', ${organizationId}, true)`
      return transaction`select id from ${transaction(table)} order by id`
    })
    const [rowsA, rowsB] = await Promise.all([scoped('org-a'), scoped('org-b')])
    assertIds(rowsA, idsA, `${table} org-a isolation`)
    assertIds(rowsB, idsB, `${table} org-b isolation`)
  }

  await tenantIsolation('billing_subscriptions', ['sub-a'], ['sub-b'])
  let appSubscriptionWriteDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`update billing_subscriptions set stripe_status = 'hacked' where id = 'sub-a'`
    })
  } catch (error) {
    appSubscriptionWriteDenied = error?.code === '42501'
  }
  if (!appSubscriptionWriteDenied) throw new Error('App role updated a billing_subscriptions row (app is SELECT-only)')

  await tenantIsolation('billing_credit_grants', ['grant-a'], ['grant-b'])
  let appCreditGrantWriteDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`update billing_credit_grants set remaining_units = 0 where id = 'grant-a'`
    })
  } catch (error) {
    appCreditGrantWriteDenied = error?.code === '42501'
  }
  if (!appCreditGrantWriteDenied) throw new Error('App role updated a billing_credit_grants row (app is SELECT-only)')

  // Distinct fixture ids from the 'rls-unelevated'/'rls-elevated'/'rls-cross' rows the role-elevation
  // test above creates itself — this is the ordinary SELECT-isolation case that test never covered.
  // The role-elevation credit-write assertions above already inserted 'rls-elevated' into org-a
  // ('rls-unelevated' and 'rls-cross' were both denied and never landed) — this section runs after
  // them, so org-a's expected set includes it alongside the pre-seeded fixture row.
  await tenantIsolation('billing_credit_reservations', ['credit-res-a', 'rls-elevated'], ['credit-res-b'])

  await tenantIsolation('billing_credit_allocations', ['alloc-a'], ['alloc-b'])
  let appCreditAllocationInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into billing_credit_allocations (id, organization_id, reservation_id, grant_id, allocated_units)
        values ('alloc-hack', 'org-a', 'credit-res-a', 'grant-a', 1)
      `
    })
  } catch (error) {
    appCreditAllocationInsertDenied = error?.code === '42501'
  }
  if (!appCreditAllocationInsertDenied) throw new Error('App role inserted a billing_credit_allocations row (app is SELECT-only)')

  await tenantIsolation('billing_ledger_entries', ['ledger-a'], ['ledger-b'])
  // Append-only for EVERY role, including the worker that writes it — a compensating entry is the
  // only correction this ledger allows, never an edit to a posted one.
  let workerLedgerUpdateDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`update billing_ledger_entries set units_delta = 0 where id = 'ledger-a'`
    })
  } catch (error) {
    workerLedgerUpdateDenied = error?.code === '42501'
  }
  if (!workerLedgerUpdateDenied) throw new Error('Worker role updated a billing_ledger_entries row (the ledger is append-only for every role)')

  await tenantIsolation('billing_provider_usage', ['provider-usage-a'], ['provider-usage-b'])
  let appProviderUsageInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into billing_provider_usage (id, organization_id, operation, units, estimated_cost_cents)
        values ('usage-hack', 'org-a', 'interview_live_transcription', 1, 10)
      `
    })
  } catch (error) {
    appProviderUsageInsertDenied = error?.code === '42501'
  }
  if (!appProviderUsageInsertDenied) throw new Error('App role inserted a billing_provider_usage row (app is SELECT-only)')

  // PK is organization_id — one row per org. Reversed permission shape from most tables here: the
  // owning app role can self-service INSERT/UPDATE its own row, and the worker may only UPDATE
  // (never INSERT — the row always originates from the owner's own settings page).
  const autoRechargeOwner = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`select organization_id from billing_auto_recharge_rules`
  })
  if (autoRechargeOwner.length !== 1 || autoRechargeOwner[0].organization_id !== 'org-a') {
    throw new Error('App role could not read its own billing_auto_recharge_rules row')
  }
  // An UPDATE whose WHERE targets a row the RLS policy filters out is not an error — it is a
  // silent 0-row no-op, same as any other UPDATE that matches nothing. The signal to check is the
  // affected-row count, not a thrown exception (that only fires when the whole table grant is
  // missing, which is not this case — the app role legitimately has UPDATE here, just row-scoped).
  const autoRechargeCrossTenantUpdate = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    const rows = await transaction`update billing_auto_recharge_rules set enabled = true where organization_id = 'org-b' returning organization_id`
    return rows.length
  })
  if (autoRechargeCrossTenantUpdate !== 0) throw new Error('App role updated another organization\'s billing_auto_recharge_rules row')
  let workerAutoRechargeInsertDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`insert into billing_auto_recharge_rules (organization_id, owner_user_id) values ('org-worker-hack', 'user-a')`
    })
  } catch (error) {
    workerAutoRechargeInsertDenied = error?.code === '42501'
  }
  if (!workerAutoRechargeInsertDenied) throw new Error('Worker role inserted a billing_auto_recharge_rules row (worker is UPDATE-only)')

  await tenantIsolation('billing_refunds', ['refund-a'], ['refund-b'])
  // The fixture rows are already 'succeeded' with a real stripe_refund_id — a shape the app role's
  // own INSERT WITH CHECK would reject. This is the app role actually exercising that CHECK: the
  // correct shape (pending, no stripe_refund_id) succeeds for its own org and is denied cross-org;
  // the wrong shape is denied even for its own org.
  const refundAppInsert = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    const rows = await transaction`
      insert into billing_refunds (id, organization_id, requested_by_user_id, idempotency_key, policy_decision, amount_cents, state)
      values ('refund-app-a', 'org-a', 'user-a', 'app-insert-a', 'full_unused_pack', 100, 'pending')
      returning id
    `
    return rows.length
  })
  if (refundAppInsert !== 1) throw new Error('App role could not insert a correctly-shaped billing_refunds row for its own org')
  let refundWrongShapeDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into billing_refunds (id, organization_id, requested_by_user_id, idempotency_key, policy_decision, amount_cents, state, stripe_refund_id)
        values ('refund-wrong-shape', 'org-a', 'user-a', 'app-insert-wrong', 'full_unused_pack', 100, 'succeeded', 're_should_not_insert')
      `
    })
  } catch (error) {
    refundWrongShapeDenied = error?.code === '42501'
  }
  if (!refundWrongShapeDenied) throw new Error('App role inserted a billing_refunds row outside the pending/no-stripe-id WITH CHECK shape')
  let refundCrossTenantInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into billing_refunds (id, organization_id, requested_by_user_id, idempotency_key, policy_decision, amount_cents, state)
        values ('refund-cross', 'org-b', 'user-a', 'app-insert-cross', 'full_unused_pack', 100, 'pending')
      `
    })
  } catch (error) {
    refundCrossTenantInsertDenied = error?.code === '42501'
  }
  if (!refundCrossTenantInsertDenied) throw new Error('App role inserted a billing_refunds row under a spoofed organization')

  await tenantIsolation('billing_disputes', ['dispute-a'], ['dispute-b'])
  let appDisputeInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`
        insert into billing_disputes (id, organization_id, stripe_dispute_id, stripe_payment_intent_id, amount_cents, stripe_status)
        values ('dispute-hack', 'org-a', 'dp_hack', 'pi_hack', 100, 'won')
      `
    })
  } catch (error) {
    appDisputeInsertDenied = error?.code === '42501'
  }
  if (!appDisputeInsertDenied) throw new Error('App role inserted a billing_disputes row (app is SELECT-only)')
  // Platform reviews disputes but does not resolve them directly — only the worker (driven by the
  // Stripe webhook) updates outcome, so a platform operator cannot silently mark one 'won'.
  let platformDisputeUpdateDenied = false
  try {
    await platform`update billing_disputes set outcome = 'won' where id = 'dispute-a'`
  } catch (error) {
    platformDisputeUpdateDenied = error?.code === '42501'
  }
  if (!platformDisputeUpdateDenied) throw new Error('Platform role updated a billing_disputes row (platform is SELECT-only here)')

  // PK is organization_id, same shape as billing_auto_recharge_rules: owner self-service, worker
  // read-only (verification email delivery is app-role work, not a worker sweep).
  const contactOwner = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`select organization_id from billing_contacts`
  })
  if (contactOwner.length !== 1 || contactOwner[0].organization_id !== 'org-a') {
    throw new Error('App role could not read its own billing_contacts row')
  }
  let workerContactUpdateDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`update billing_contacts set status = 'pending' where organization_id = 'org-a'`
    })
  } catch (error) {
    workerContactUpdateDenied = error?.code === '42501'
  }
  if (!workerContactUpdateDenied) throw new Error('Worker role updated a billing_contacts row (worker is SELECT-only)')

  await tenantIsolation('billing_risk_events', ['risk-event-a'], ['risk-event-b'])
  let appRiskEventCrossTenantInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`insert into billing_risk_events (id, organization_id, event_type) values ('risk-event-cross', 'org-b', 'card_rotation')`
    })
  } catch (error) {
    appRiskEventCrossTenantInsertDenied = error?.code === '42501'
  }
  if (!appRiskEventCrossTenantInsertDenied) throw new Error('App role inserted a billing_risk_events row under a spoofed organization')
  let appRiskEventUpdateDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`update billing_risk_events set detail = 'edited' where id = 'risk-event-a'`
    })
  } catch (error) {
    appRiskEventUpdateDenied = error?.code === '42501'
  }
  if (!appRiskEventUpdateDenied) throw new Error('App role updated a billing_risk_events row (append-only for every role)')

  // Only a platform operator can issue or lift a risk exception — neither the app nor the worker
  // role can grant itself relief from its own velocity block.
  await tenantIsolation('billing_risk_exceptions', ['risk-exc-a'], ['risk-exc-b'])
  let workerRiskExceptionInsertDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`insert into billing_risk_exceptions (id, organization_id, reason, issued_by_user_id, expires_at) values ('risk-exc-hack', 'org-a', 'self-issued', 'user-a', now() + interval '1 day')`
    })
  } catch (error) {
    workerRiskExceptionInsertDenied = error?.code === '42501'
  }
  if (!workerRiskExceptionInsertDenied) throw new Error('Worker role issued a billing_risk_exceptions row (only platform may issue exceptions)')
  // Platform's insert/update policies here are ALSO organization-scoped (unlike most tables above,
  // where platform access — where granted at all — is unconditional) — a platform operator issues
  // an exception for a specific tenant, so the GUC must be set the same way the app/worker roles do.
  const platformRiskExceptionInsert = await platform.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`
      insert into billing_risk_exceptions (id, organization_id, reason, issued_by_user_id, expires_at)
      values ('risk-exc-platform', 'org-a', 'platform issued', 'user-a', now() + interval '1 day')
      returning id
    `
  })
  if (platformRiskExceptionInsert.length !== 1) throw new Error('Platform role could not issue a billing_risk_exceptions row')

  // billing_webhook_events / billing_reconciliation_runs / billing_seller_profiles: system-operational,
  // no organization_id, no RLS at all — the app role is denied at the GRANT level (there is no row to
  // filter), and this is a deliberate positive control that worker/platform see every row with no scoping.
  let appWebhookEventsDenied = false
  try {
    await app`select id from billing_webhook_events`
  } catch (error) {
    appWebhookEventsDenied = error?.code === '42501'
  }
  if (!appWebhookEventsDenied) throw new Error('App role accessed billing_webhook_events (system-operational, no app grant)')

  // ── Global-public ingestion tables ────────────────────────────────────────────────────────────
  //
  // These have no organization_id and no RLS, so their entire access story is the GRANT — and this
  // gate had no coverage for any of them until 2026-08-01, which is exactly how
  // `builder_source_snapshots` shipped with grants for the `postgres` owner alone. It was created
  // with a schema, a unique index and a cascade FK, and every write as the app role failed with
  // 42501. Nothing noticed for as long as nothing wrote to it; the moment plan 43 Phase 3 wired the
  // write-through, every single insert was denied.
  //
  // Asserted as privileges rather than by attempting writes: these tables are global, so a write
  // here would leak fixture rows into every other assertion in this script.
  const globalIngestionGrantReport = {}
  const vectorOperatorReport = {}
  /**
   * Must match `AI_EMBEDDING_DIM` and the `builder_embeddings.embedding` column.
   *
   * Cast to `int` at the call site. Without the cast postgres.js binds it as an untyped parameter,
   * `array_fill(real, unknown[])` does not resolve, and the query fails with 42883 — an assertion that fails
   * for the wrong reason, which is worse than no assertion because it looks like it is testing something.
   */
  const EMBEDDING_DIMENSION = 768
  const globalIngestionExpectations = [
    // The request-path write-through upserts identities and appends snapshots as the app role.
    // SELECT accompanies INSERT on snapshots because the insert uses RETURNING to tell a new
    // observation from an unchanged one, and RETURNING requires SELECT.
    { table: 'builder_identities', role: 'builderhunt_app', granted: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: 'builder_source_snapshots', role: 'builderhunt_app', granted: ['SELECT', 'INSERT'], denied: ['UPDATE', 'DELETE'] },
    { table: 'builder_source_snapshots', role: 'builderhunt_worker', granted: ['SELECT', 'INSERT'], denied: ['UPDATE', 'DELETE'] },
    // Purging a subject's observations on a removal request is a platform action; ingestion must
    // never be able to delete history.
    { table: 'builder_source_snapshots', role: 'builderhunt_platform', granted: ['SELECT', 'DELETE'] },
    { table: 'builder_embeddings', role: 'builderhunt_app', granted: ['SELECT', 'INSERT', 'UPDATE'] },
    // Declarations arrive with a search observation, so the request path writes them — the same reasoning
    // that gives the app role INSERT on builder_identities. Verification is a worker's job and needs UPDATE.
    // Neither may DELETE: removing a declaration is a retention action or a subject's removal request.
    { table: 'identity_declared_links', role: 'builderhunt_app', granted: ['SELECT', 'INSERT', 'UPDATE'], denied: ['DELETE'] },
    { table: 'identity_declared_links', role: 'builderhunt_worker', granted: ['SELECT', 'INSERT', 'UPDATE'], denied: ['DELETE'] },
    { table: 'identity_declared_links', role: 'builderhunt_platform', granted: ['SELECT', 'DELETE'] },
    // Asserting that two accounts are one person is never a request-scoped action, so the app role reads and
    // nothing more — the same rule migration 0122 set, restated here because the reciprocity verifier is a new
    // writer and the temptation to widen it was real.
    { table: 'canonical_humans', role: 'builderhunt_platform', granted: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: 'human_source_links', role: 'builderhunt_platform', granted: ['SELECT', 'INSERT', 'UPDATE'] },
    // The catalog projector is a real worker and enqueues stubs for components it just projected. No
    // DELETE: removing an embedding is either retention or a subject's removal request, both platform
    // actions.
    { table: 'builder_embeddings', role: 'builderhunt_worker', granted: ['SELECT', 'INSERT', 'UPDATE'], denied: ['DELETE'] },
    // Projections are derived data the worker genuinely owns — rebuilding is DELETE + reinsert, which is
    // the normal operation here and would be unthinkable against version history.
    { table: 'solution_component_projections', role: 'builderhunt_app', granted: ['SELECT'], denied: ['INSERT', 'UPDATE', 'DELETE'] },
    { table: 'solution_component_projections', role: 'builderhunt_worker', granted: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
    // Asserting that two real people are the same person is never a request-scoped action.
    { table: 'canonical_humans', role: 'builderhunt_app', granted: ['SELECT'], denied: ['INSERT', 'UPDATE', 'DELETE'] },
    { table: 'human_source_links', role: 'builderhunt_app', granted: ['SELECT'], denied: ['INSERT', 'UPDATE', 'DELETE'] },
    { table: 'human_source_links', role: 'builderhunt_worker', granted: ['SELECT', 'INSERT', 'UPDATE'] },
    // The source registers are read on every search and every ingestion run, and written only by a
    // reviewed operator action. The denials are the load-bearing half: a role able to flip `enabled`
    // could re-enable a source someone withdrew, which makes the kill switch decorative. That is the
    // whole reason these two tables exist, so it is asserted rather than assumed.
    { table: 'search_sources', role: 'builderhunt_app', granted: ['SELECT'], denied: ['INSERT', 'UPDATE', 'DELETE'] },
    { table: 'search_sources', role: 'builderhunt_worker', granted: ['SELECT'], denied: ['INSERT', 'UPDATE', 'DELETE'] },
    { table: 'search_sources', role: 'builderhunt_platform', granted: ['SELECT', 'INSERT', 'UPDATE'] },
    { table: 'solution_sources', role: 'builderhunt_app', granted: ['SELECT'], denied: ['INSERT', 'UPDATE', 'DELETE'] },
    { table: 'solution_sources', role: 'builderhunt_worker', granted: ['SELECT'], denied: ['INSERT', 'UPDATE', 'DELETE'] },
    { table: 'solution_sources', role: 'builderhunt_platform', granted: ['SELECT', 'INSERT', 'UPDATE'] },
    // A capability claim keyed by (component, version, capability) is immutable content: if a source
    // changed what it says, the content hash changed and it is a new version. `evidence_level` is what a
    // human raises to `verified`, so a worker holding UPDATE here could push a verified claim back down
    // to `claimed`. The ingestion path uses ON CONFLICT DO NOTHING precisely so it does not need it.
    { table: 'solution_component_capabilities', role: 'builderhunt_worker', granted: ['SELECT', 'INSERT'], denied: ['UPDATE', 'DELETE'] },
    { table: 'solution_component_capabilities', role: 'builderhunt_platform', granted: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
    // Column-level, and the negative half is the point. Closing a validity window is ingestion's job —
    // the no-overlap EXCLUDE constraint makes it mandatory before a new version can be inserted — but
    // rewriting a historical version's metadata or content hash falsifies the audit trail the versions
    // exist to keep. `has_table_privilege` reports UPDATE as absent here, which is exactly right: the
    // grant is on one column, so the table-level assertion below must stay a denial.
    {
      table: 'solution_component_versions', role: 'builderhunt_worker',
      granted: ['SELECT', 'INSERT'], denied: ['UPDATE', 'DELETE'],
      grantedColumns: [['valid_until', 'UPDATE']],
      deniedColumns: [['metadata', 'UPDATE'], ['content_hash', 'UPDATE'], ['version', 'UPDATE'], ['valid_from', 'UPDATE']],
    },
  ]
  for (const expectation of globalIngestionExpectations) {
    for (const privilege of expectation.granted ?? []) {
      const [row] = await platform`
        select has_table_privilege(${expectation.role}, ${expectation.table}, ${privilege}) as ok
      `
      if (!row.ok) {
        throw new Error(`${expectation.role} is missing ${privilege} on ${expectation.table} — the write path that needs it will fail with 42501 at runtime`)
      }
    }
    for (const privilege of expectation.denied ?? []) {
      const [row] = await platform`
        select has_table_privilege(${expectation.role}, ${expectation.table}, ${privilege}) as ok
      `
      if (row.ok) {
        throw new Error(`${expectation.role} unexpectedly holds ${privilege} on ${expectation.table}`)
      }
    }
    for (const [column, privilege] of expectation.grantedColumns ?? []) {
      const [row] = await platform`
        select has_column_privilege(${expectation.role}, ${expectation.table}, ${column}, ${privilege}) as ok
      `
      if (!row.ok) {
        throw new Error(`${expectation.role} is missing ${privilege} on ${expectation.table}.${column} — the write path that needs it will fail with 42501 at runtime`)
      }
    }
    for (const [column, privilege] of expectation.deniedColumns ?? []) {
      const [row] = await platform`
        select has_column_privilege(${expectation.role}, ${expectation.table}, ${column}, ${privilege}) as ok
      `
      if (row.ok) {
        throw new Error(`${expectation.role} unexpectedly holds ${privilege} on ${expectation.table}.${column}`)
      }
    }
    const key = `${expectation.table}:${expectation.role}`
    const columnNote = expectation.grantedColumns
      ? `, granted ${expectation.grantedColumns.map(([c, p]) => `${p}(${c})`).join('/')}`
      : ''
    globalIngestionGrantReport[key] = `granted ${(expectation.granted ?? []).join('/')}${expectation.denied ? `, denied ${expectation.denied.join('/')}` : ''}${columnNote}`
  }
  /**
   * pgvector's operators must be executable by every runtime role.
   *
   * `0002_database_roles.sql` runs `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC`, aimed at
   * application functions — and pgvector installs its operator implementations into `public`. On a clean
   * chain the ordering saves it (0002 runs before 0013 creates the extension, so there is nothing to revoke
   * yet), but in any database where that revoke landed after the extension existed, semantic search dies
   * silently: reading the column needs no function, so nothing looks broken, while every query touching a
   * vector *operator* fails with 42501 into a fire-and-forget `.catch()`.
   *
   * Asserted through a real query rather than `has_function_privilege`, because the failing thing is an
   * operator expression and there is no single function name to name. `0136` is the grant.
   */
  try {
    await app`select id from builder_embeddings order by embedding <=> array_fill(0.0::real, array[${EMBEDDING_DIMENSION}::int])::vector limit 1`
  } catch (error) {
    throw new Error(
      `app role cannot evaluate a pgvector distance operator (${error?.code ?? 'unknown'}): a vector operator is unusable for this role, so semantic search cannot work`,
      { cause: error },
    )
  }
  try {
    await worker`select id from builder_embeddings order by embedding <=> array_fill(0.0::real, array[${EMBEDDING_DIMENSION}::int])::vector limit 1`
  } catch (error) {
    throw new Error(`worker role cannot evaluate a pgvector distance operator (${error?.code ?? 'unknown'})`, { cause: error })
  }
  vectorOperatorReport.appRole = 'can evaluate <=>'
  vectorOperatorReport.workerRole = 'can evaluate <=>'

  const workerWebhookEvents = await worker`select id from billing_webhook_events`
  if (workerWebhookEvents.length !== 1 || workerWebhookEvents[0].id !== 'webhook-a') {
    throw new Error(`Worker role could not read billing_webhook_events (${JSON.stringify(workerWebhookEvents)})`)
  }
  let platformWebhookInsertDenied = false
  try {
    await platform`insert into billing_webhook_events (id, livemode, stripe_event_id, api_version, object_type, event_type, payload_encrypted) values ('webhook-platform-hack', false, 'evt_hack', '2024-01-01', 'invoice', 'invoice.paid', 'x')`
  } catch (error) {
    platformWebhookInsertDenied = error?.code === '42501'
  }
  if (!platformWebhookInsertDenied) throw new Error('Platform role inserted a billing_webhook_events row (platform is SELECT/UPDATE only)')

  let appReconciliationDenied = false
  try {
    await app`select id from billing_reconciliation_runs`
  } catch (error) {
    appReconciliationDenied = error?.code === '42501'
  }
  if (!appReconciliationDenied) throw new Error('App role accessed billing_reconciliation_runs (system-operational, no app grant)')
  const workerReconciliation = await worker`select id from billing_reconciliation_runs`
  if (workerReconciliation.length !== 1 || workerReconciliation[0].id !== 'recon-a') {
    throw new Error(`Worker role could not read billing_reconciliation_runs (${JSON.stringify(workerReconciliation)})`)
  }
  let workerReconciliationUpdateDenied = false
  try {
    await worker`update billing_reconciliation_runs set result = 'mismatches_found' where id = 'recon-a'`
  } catch (error) {
    workerReconciliationUpdateDenied = error?.code === '42501'
  }
  if (!workerReconciliationUpdateDenied) throw new Error('Worker role updated a billing_reconciliation_runs row (worker is SELECT/INSERT only, runs are immutable once written)')
  const platformReconciliation = await platform`select id from billing_reconciliation_runs`
  if (platformReconciliation.length !== 1) throw new Error('Platform role could not read billing_reconciliation_runs')

  // No FK on organization_id — 'platform' is the documented cross-organization sentinel. The
  // interesting property is the OR-branch itself: a worker scoped to org-a sees ITS OWN
  // organization's rows plus every 'platform'-tagged row, never org-b's.
  let appNotificationLogDenied = false
  try {
    await app`select id from billing_notification_log`
  } catch (error) {
    appNotificationLogDenied = error?.code === '42501'
  }
  if (!appNotificationLogDenied) throw new Error('App role accessed billing_notification_log (system-operational, no app grant)')
  const workerNotificationsOrgA = await worker.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`select id from billing_notification_log order by id`
  })
  assertIds(workerNotificationsOrgA, ['notif-org-a', 'notif-platform'], 'billing_notification_log worker org-a + platform sentinel')
  const workerNotificationsOrgB = await worker.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-b', true)`
    return transaction`select id from billing_notification_log order by id`
  })
  assertIds(workerNotificationsOrgB, ['notif-platform'], 'billing_notification_log worker org-b sees only the platform sentinel')
  const platformNotifications = await platform`select id from billing_notification_log order by id`
  assertIds(platformNotifications, ['notif-org-a', 'notif-platform'], 'billing_notification_log platform sees every row unconditionally')

  // Platform-private seller configuration. Both app AND worker are denied — unlike every other
  // table above, the worker is not trusted here either, since this is the seller-of-record
  // configuration that determines whose name appears on every receipt.
  let appSellerProfilesDenied = false
  try {
    await app`select id from billing_seller_profiles`
  } catch (error) {
    appSellerProfilesDenied = error?.code === '42501'
  }
  if (!appSellerProfilesDenied) throw new Error('App role accessed billing_seller_profiles')
  let workerSellerProfilesDenied = false
  try {
    await worker`select id from billing_seller_profiles`
  } catch (error) {
    workerSellerProfilesDenied = error?.code === '42501'
  }
  if (!workerSellerProfilesDenied) throw new Error('Worker role accessed billing_seller_profiles (platform-private, worker is not trusted here either)')
  const platformSellerProfiles = await platform`select version from billing_seller_profiles`
  if (platformSellerProfiles.length !== 1) throw new Error('Platform role could not read billing_seller_profiles')
  let platformSellerProfileUpdateDenied = false
  try {
    await platform`update billing_seller_profiles set legal_name = 'hacked' where version = 999999`
  } catch (error) {
    platformSellerProfileUpdateDenied = error?.code === '42501'
  }
  if (!platformSellerProfileUpdateDenied) throw new Error('Platform role updated a billing_seller_profiles row (profiles are versioned insert-only, never edited)')

  await tenantIsolation('billing_terms_acceptances', ['terms-a'], ['terms-b'])
  let appTermsCrossTenantInsertDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`insert into billing_terms_acceptances (id, organization_id, actor_user_id, terms_version, privacy_version, commercial_action) values ('terms-cross', 'org-b', 'user-a', 'v1', 'v1', 'checkout_credits')`
    })
  } catch (error) {
    appTermsCrossTenantInsertDenied = error?.code === '42501'
  }
  if (!appTermsCrossTenantInsertDenied) throw new Error('App role inserted a billing_terms_acceptances row under a spoofed organization')
  let workerTermsInsertDenied = false
  try {
    await worker.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`insert into billing_terms_acceptances (id, organization_id, actor_user_id, terms_version, privacy_version, commercial_action) values ('terms-worker-hack', 'org-a', 'user-a', 'v1', 'v1', 'checkout_credits')`
    })
  } catch (error) {
    workerTermsInsertDenied = error?.code === '42501'
  }
  if (!workerTermsInsertDenied) throw new Error('Worker role inserted a billing_terms_acceptances row (only the app role records a live consent)')

  // No FK on organization_id (the organization is already gone by the time this row exists), and
  // the sharpest permission split of any table here: the worker that writes this row cannot read it
  // back, and the app role — which never touches financial records post-deletion — is denied
  // outright. Only platform, auditing after the fact, can read it.
  let appDeletionRecordsDenied = false
  try {
    await app`select id from organization_deletion_financial_records`
  } catch (error) {
    appDeletionRecordsDenied = error?.code === '42501'
  }
  if (!appDeletionRecordsDenied) throw new Error('App role accessed organization_deletion_financial_records')
  // No `returning id` here deliberately — `RETURNING` needs SELECT on the table to read the new row
  // back, which the worker does not have (INSERT only). That distinction is what the very next
  // assertion measures; asking for it here would turn "worker cannot read this table" into "worker
  // cannot insert into this table", which is a different property and the wrong one to break on.
  await worker`
    insert into organization_deletion_financial_records (id, organization_id, organization_name, deletion_type, livemode)
    values ('financial-record-worker', 'org-deleted-worker', 'Deleted Org Worker', 'immediate', false)
  `
  let workerDeletionSelectDenied = false
  try {
    await worker`select id from organization_deletion_financial_records`
  } catch (error) {
    workerDeletionSelectDenied = error?.code === '42501'
  }
  if (!workerDeletionSelectDenied) throw new Error('Worker role read organization_deletion_financial_records back after writing it (write-only, by design)')
  const platformDeletionRecords = await platform`select id from organization_deletion_financial_records order by id`
  assertIds(platformDeletionRecords, ['financial-record-a', 'financial-record-worker'], 'organization_deletion_financial_records platform sees every row, no tenant filter exists')

  // plans/UI/tasks.md Wave 2 "Shortlist metadata and visibility editing" added the first UPDATE
  // ever issued against builder_lists — 0109_builder_lists_grants.sql only granted SELECT/INSERT/
  // DELETE to builderhunt_app because nothing updated this table at the time. Found here (not by a
  // unit test, which runs as the migration superuser and would have shown the write as "successful"
  // for the wrong reason) by running the actual repository function against this exact role.
  const [renamedListA] = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`
      update builder_lists set name = 'List A (renamed)', version = version + 1
      where id = 'list-a' and version = 1
      returning id, name, version
    `
  })
  if (!renamedListA || renamedListA.name !== 'List A (renamed)' || renamedListA.version !== 2) {
    throw new Error('App role could not UPDATE its own tenant\'s builder_lists row')
  }

  // A cross-tenant UPDATE's WHERE clause matches 0 rows under RLS — the same "no such row from
  // here" shape as every other cross-tenant access in this file — so the real assertion is that
  // org-b's row is untouched, not that the statement itself throws.
  await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    await transaction`update builder_lists set name = 'hijacked' where id = 'list-b'`
  })
  const listBUnchanged = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-b', true)`
    return transaction`select name from builder_lists where id = 'list-b'`
  })
  if (listBUnchanged[0]?.name !== 'List B') throw new Error("Cross-tenant UPDATE reached another organization's builder_lists row")

  // Saved Solutions briefs, runs, and routes (plan 43 Phase 8, migration 0137). Checked here rather than only
  // in a unit test for the reason this file exists: the unit suite connects as the migration superuser, which
  // bypasses RLS and holds every privilege, so it cannot see either of the two properties below.
  const solutionBriefsA = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`select id from solution_briefs order by id`
  })
  assertIds(solutionBriefsA, ['solution-brief-a'], 'solution_briefs tenant isolation')

  const solutionRunsB = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-b', true)`
    return transaction`select id from solution_runs order by id`
  })
  assertIds(solutionRunsB, ['solution-run-b'], 'solution_runs tenant isolation')

  const solutionRoutesA = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`select run_id from solution_run_routes order by run_id`
  })
  if (solutionRoutesA.length !== 1 || solutionRoutesA[0].run_id !== 'solution-run-a') {
    throw new Error('solution_run_routes tenant isolation failed')
  }

  /**
   * A stored run is immutable, and the mechanism is the *absence* of an UPDATE grant rather than a trigger or a
   * check. That distinction only shows up as the real role: under the superuser every unit test would see the
   * update succeed and conclude the opposite.
   */
  let solutionRunUpdateDenied = false
  try {
    await app.begin(async (transaction) => {
      await transaction`select set_config('app.organization_id', 'org-a', true)`
      await transaction`update solution_runs set composition_hash = 'rewritten' where id = 'solution-run-a'`
    })
  } catch (error) {
    solutionRunUpdateDenied = error.code === '42501'
  }
  if (!solutionRunUpdateDenied) throw new Error('App role could UPDATE solution_runs — a stored recommendation must not be editable')

  // A saved brief, by contrast, is a working document its owner edits. Both grants are deliberate, so both are
  // asserted: a copy-pasted grant block that made runs updatable would otherwise pass unnoticed.
  const [renamedBriefA] = await app.begin(async (transaction) => {
    await transaction`select set_config('app.organization_id', 'org-a', true)`
    return transaction`update solution_briefs set title = 'Brief A (renamed)' where id = 'solution-brief-a' returning id, title`
  })
  if (renamedBriefA?.title !== 'Brief A (renamed)') throw new Error('App role could not UPDATE its own solution_briefs row')

  console.log(JSON.stringify({
    missingContext: 'denied',
    tenantA: tenantA.map((row) => row.id),
    tenantB: tenantB.map((row) => row.id),
    crossTenantInsert: 'denied',
    poolReuse: 'clean',
    anonymousPublicClaimRead: claimMissingNoContext.map((row) => row.id),
    pendingClaimAnonymousRead: 'denied',
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
    elevatedCustomerInsert: 'inserted',
    elevatedCustomerCrossTenant: 'denied',
    ownerEmailViaAuth: ownerEmailViaAuth[0].email,
    checkoutAttemptSpoof: 'denied',
    workerBillingMissingContext: 'denied',
    workerBillingTenantIsolation: workerBillingA.map((row) => row.id),
    workerBillingCrossTenantUpdate: 'denied',
    platformBillingAccess: 'denied',
    workerOrganizationLoop: workerOrganizationIds.map((row) => row.id),
    platformOperatorGrant: `${grantedByPlatform.tier}/${grantedByPlatform.seat_limit} seats`,
    platformEntitlementDirectWrite: 'denied',
    platformEntitlementDirectRead: 'denied',
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
    solutionBriefsTenantA: solutionBriefsA.map((row) => row.id),
    solutionRunsTenantB: solutionRunsB.map((row) => row.id),
    solutionRunUpdate: 'denied',
    solutionBriefUpdate: renamedBriefA.title,
    appBuilderListUpdate: renamedListA.name,
    appBuilderListCrossTenantUpdate: 'no-op (0 rows under RLS)',
    // Reported, not merely asserted: these four checks throw on failure and were otherwise silent, which
    // makes a passing check invisible. The `*_public_select` gap they exist to catch went unnoticed for a
    // week precisely because nothing printed anything about those tables.
    savedQueriesTenantA: savedA.map((row) => row.id),
    savedQueriesTenantB: savedB.map((row) => row.id),
    feedCapabilitiesTenantA: feedsA.map((row) => row.id),
    publicFeedReadWithLiveCapability: publicFeedRead.length === 1 ? 'allowed' : 'BROKEN',
    publicFeedReadAfterRevocation: revokedFeedRead.length === 0 ? 'denied' : 'LEAKED',
    globalIngestionGrants: globalIngestionGrantReport, vectorOperators: vectorOperatorReport,
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
