import postgres from 'postgres'

const migrationUrl = process.env.TEST_MIGRATION_URL
if (!migrationUrl) throw new Error('TEST_MIGRATION_URL is required')
const parsed = new URL(migrationUrl)
const databaseName = parsed.pathname.slice(1)
if (!/^builderhunt_security_test_[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error('RLS fixture refuses to run outside a named builderhunt_security_test database')
}

const owner = postgres(migrationUrl, { max: 1, prepare: false })
try {
  await owner.unsafe("alter role builderhunt_app password 'test-app-password'")
  await owner.unsafe("alter role builderhunt_auth password 'test-auth-password'")
  await owner.unsafe("alter role builderhunt_worker password 'test-worker-password'")
  await owner.unsafe("alter role builderhunt_platform password 'test-platform-password'")
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
  console.log(JSON.stringify({ prepared: true, database: databaseName }))
} finally {
  await owner.end({ timeout: 5 })
}
