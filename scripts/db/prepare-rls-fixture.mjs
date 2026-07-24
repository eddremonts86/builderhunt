import postgres from 'postgres'

const migrationUrl = process.env.TEST_MIGRATION_URL
if (!migrationUrl) throw new Error('TEST_MIGRATION_URL is required')
const parsed = new URL(migrationUrl)
const databaseName = parsed.pathname.slice(1)
if (!/^builderhunt_security_test_[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error('RLS fixture refuses to run outside a named builderhunt_security_test database')
}

// Postgres roles are cluster-global. On a shared local instance, ALTERing the
// base application roles' passwords breaks every concurrent session (dev
// servers, E2E runs) mid-flight — observed as sign-up 500s and 28P01 errors.
// CI runs on a throwaway service container AND its later job steps connect as
// the base roles with these fixed passwords, so only there (or under an
// explicit escape hatch) do we keep the legacy global mutation. Everywhere
// else we create per-run dedicated login roles that are members of the base
// roles: table privileges and RLS policies (`TO builderhunt_app` …) apply to
// inheriting members, and nothing shared is ever mutated.
const mutateGlobalRoles = process.env.CI === 'true' || process.env.RLS_ALLOW_GLOBAL_ROLE_MUTATION === '1'
const ROLE_PASSWORDS = {
  builderhunt_app: 'test-app-password',
  builderhunt_auth: 'test-auth-password',
  builderhunt_worker: 'test-worker-password',
  builderhunt_platform: 'test-platform-password',
}
const roleSuffix = databaseName.replace(/^builderhunt_security_test_/, '')

const owner = postgres(migrationUrl, { max: 1, prepare: false })
try {
  const roles = {}
  const urls = {}
  for (const [baseRole, password] of Object.entries(ROLE_PASSWORDS)) {
    let connectAs = baseRole
    if (mutateGlobalRoles) {
      await owner.unsafe(`alter role ${baseRole} password '${password}'`)
    } else {
      connectAs = `${baseRole}_rls_${roleSuffix}`
      await owner.unsafe(`drop role if exists ${connectAs}`)
      await owner.unsafe(`create role ${connectAs} login inherit password '${password}' in role ${baseRole}`)
    }
    await owner.unsafe(`grant connect on database ${databaseName} to ${connectAs}`)
    roles[baseRole] = connectAs
    const url = new URL(migrationUrl)
    url.username = connectAs
    url.password = password
    urls[baseRole] = url.toString()
  }
  await owner`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values
      ('user-a', 'A', 'a@test.invalid', true, now(), now()),
      ('user-b', 'B', 'b@test.invalid', true, now(), now())
    on conflict (id) do nothing
  `
  await owner`
    insert into organizations (id, name, slug, metadata, created_at)
    values ('org-a', 'A', 'org-a', '{}', now()), ('org-b', 'B', 'org-b', '{}', now())
    on conflict (id) do nothing
  `
  await owner`
    insert into organization_members (id, organization_id, user_id, role, created_at)
    values ('member-a', 'org-a', 'user-a', 'owner', now()), ('member-b', 'org-b', 'user-b', 'owner', now())
    on conflict (organization_id, user_id) do nothing
  `
  await owner`
    insert into alerts (
      id, organization_id, user_id, name, keywords, enabled, trigger_conditions, delivery_channel, created_at
    ) values
      ('alert-a', 'org-a', 'user-a', 'A', '{}', true, '{"eventType":"any_activity"}', 'dashboard', now()),
      ('alert-b', 'org-b', 'user-b', 'B', '{}', true, '{"eventType":"any_activity"}', 'dashboard', now())
    on conflict (id) do nothing
  `
  await owner`
    insert into builder_identities (id, source, source_id, username, profile_url, created_at, updated_at)
    values
      ('identity-a', 'github', 'a', 'a', 'https://github.com/a', now(), now()),
      ('identity-b', 'github', 'b', 'b', 'https://github.com/b', now(), now())
    on conflict (source, source_id) do nothing
  `
  await owner`
    insert into organization_builders (
      id, organization_id, builder_identity_id, creator_user_id,
      visibility, status, private_metadata, created_at, updated_at
    ) values
      ('tracked-a', 'org-a', 'identity-a', 'user-a', 'private', 'tracked', '{}', now(), now()),
      ('tracked-b', 'org-b', 'identity-b', 'user-b', 'private', 'tracked', '{}', now(), now())
    on conflict (organization_id, builder_identity_id) do nothing
  `
  await owner`
    insert into builder_claims (
      id, builder_identity_id, subject_user_id, evidence_source, evidence_reference, status, created_at
    ) values
      ('claim-a', 'identity-a', 'user-a', 'email', 'a@test.invalid', 'verified', now()),
      ('claim-b', 'identity-b', 'user-b', 'email', 'b@test.invalid', 'verified', now())
    on conflict (id) do nothing
  `
  await owner`
    insert into billing_customers (id, organization_id, livemode, stripe_customer_id, created_at, updated_at)
    values
      ('billing-cust-a', 'org-a', false, 'cus_test_a', now(), now()),
      ('billing-cust-b', 'org-b', false, 'cus_test_b', now(), now())
    on conflict (id) do nothing
  `
  await owner`
    insert into user_devices (id, user_id, device_hash, ua_family, trust_state)
    values
      ('device-a', 'user-a', 'hash-a', 'chrome', 'new'),
      ('device-b', 'user-b', 'hash-b', 'chrome', 'new')
    on conflict (id) do nothing
  `
  await owner`
    insert into account_risk (user_id, risk_score, stage, updated_at)
    values ('user-a', 0, 'observe', now()), ('user-b', 0, 'observe', now())
    on conflict (user_id) do nothing
  `
  await owner`
    insert into seat_usage_daily (id, organization_id, user_id, day, action, count, credit_units)
    values
      ('usage-a', 'org-a', 'user-a', '2026-01-01', 'searches', 1, 0),
      ('usage-b', 'org-b', 'user-b', '2026-01-01', 'searches', 1, 0)
    on conflict (id) do nothing
  `
  // `roles`/`urls` tell the caller which login roles to use for the verifier
  // (`scripts/db/verify-rls-local.mjs` reads RLS_TEST_*_URL): the base roles
  // themselves in CI, per-run dedicated members everywhere else.
  console.log(JSON.stringify({ prepared: true, database: databaseName, mutatedGlobalRoles: mutateGlobalRoles, roles, urls }))
} finally {
  await owner.end({ timeout: 5 })
}
