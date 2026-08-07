/**
 * seed-test-users.ts
 *
 * Creates the three test users the `/saas-review` flow expects for role-based
 * coverage: one workspace owner, one admin, one member. All three live inside
 * the owner's personal workspace so the audit can view the same org through
 * each role's permissions.
 *
 * Reads from `SAAS_REVIEW_*` env vars (with sensible defaults) so the
 * `saas-review` skill can drive the seed from `.env` without code changes.
 *
 *   SAAS_REVIEW_OWNER_EMAIL       (default saas-review-owner@test.local)
 *   SAAS_REVIEW_OWNER_PASSWORD    (default SaasReview!Owner#1)
 *   SAAS_REVIEW_ADMIN_EMAIL       (default saas-review-admin@test.local)
 *   SAAS_REVIEW_ADMIN_PASSWORD    (default SaasReview!Admin#1)
 *   SAAS_REVIEW_MEMBER_EMAIL      (default saas-review-member@test.local)
 *   SAAS_REVIEW_MEMBER_PASSWORD   (default SaasReview!Member#1)
 *
 * Usage:
 *   pnpm db:seed:test-users
 *
 * Idempotent: re-running updates the rows in place. Does NOT touch the
 * existing platform admin (DEFAULT_ADMIN_*) or any e2e test users.
 *
 * Safety: refuses to run against a non-local host. Production DBs must never
 * receive a known-password test user, even by accident.
 */

import type { Sql } from 'postgres'
import postgres from 'postgres'
import { hashPassword } from 'better-auth/crypto'
import { personalOrganizationId, personalOrganizationSlug } from '../../src/shared/lib/migration/backfill'

type Role = 'owner' | 'admin' | 'member'

interface TestUser {
  role: Role
  email: string
  password: string
  name: string
}

const USERS: TestUser[] = [
  {
    role: 'owner',
    email: process.env.SAAS_REVIEW_OWNER_EMAIL ?? 'saas-review-owner@test.local',
    password: process.env.SAAS_REVIEW_OWNER_PASSWORD ?? 'SaasReview!Owner#1',
    name: 'SaaS Review — Owner',
  },
  {
    role: 'admin',
    email: process.env.SAAS_REVIEW_ADMIN_EMAIL ?? 'saas-review-admin@test.local',
    password: process.env.SAAS_REVIEW_ADMIN_PASSWORD ?? 'SaasReview!Admin#1',
    name: 'SaaS Review — Admin',
  },
  {
    role: 'member',
    email: process.env.SAAS_REVIEW_MEMBER_EMAIL ?? 'saas-review-member@test.local',
    password: process.env.SAAS_REVIEW_MEMBER_PASSWORD ?? 'SaasReview!Member#1',
    name: 'SaaS Review — Member',
  },
]

const DATABASE_URL = process.env.DATABASE_AUTH_URL ?? process.env.DATABASE_URL

// `auth_users` / `auth_accounts` are auth-broker-only tables. Same privileged
// connection as `seed-admin.ts` — the runtime app role has no grant on them.
if (!DATABASE_URL) {
  console.error('❌  DATABASE_AUTH_URL / DATABASE_URL is not set. Check your .env file.')
  process.exit(1)
}

const sqlUrl = new URL(DATABASE_URL)
if (sqlUrl.hostname !== 'localhost' && sqlUrl.hostname !== '127.0.0.1' && !sqlUrl.hostname.endsWith('.local')) {
  console.error(
    `❌  Refusing to seed test users against non-local host (${sqlUrl.hostname}). ` +
      'These passwords are public — production DBs must never see them.',
  )
  process.exit(1)
}

async function ensureUser(sql: Sql, user: TestUser): Promise<string> {
  // Try to find the user first; the id is needed for the personal-org seed.
  const [existing] = await sql<{ id: string }[]>`
    SELECT id FROM auth_users WHERE email = ${user.email} LIMIT 1
  `

  const userId = existing?.id ?? crypto.randomUUID()
  const hashed = await hashPassword(user.password)

  if (!existing) {
    await sql`
      INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at)
      VALUES (${userId}, ${user.name}, ${user.email}, true, now(), now())
    `
  } else {
    await sql`
      UPDATE auth_users
         SET name = ${user.name}, email_verified = true, updated_at = now()
       WHERE id = ${userId}
    `
  }

  // Upsert the credential account. Provider is `credential` (email/password).
  await sql`
    INSERT INTO auth_accounts (
      id, user_id, account_id, provider_id, password, created_at, updated_at
    )
    VALUES (
      ${crypto.randomUUID()},
      ${userId},
      ${user.email},
      'credential',
      ${hashed},
      now(),
      now()
    )
    ON CONFLICT (account_id, provider_id) DO UPDATE
      SET password = EXCLUDED.password,
          updated_at = now()
  `

  return userId
}

async function ensurePersonalOrg(sql: Sql, userId: string): Promise<string> {
  // Use the app's canonical deterministic id so a real signup and this seed
  // produce the same org_id for the same user_id. The `bootstrap_*` SQL
  // function validates the exact pattern; a hand-rolled hash would diverge.
  const orgId = personalOrganizationId(userId)
  const slug = personalOrganizationSlug(userId)
  const memberId = `${orgId}:owner`

  // Idempotent: ON CONFLICT DO NOTHING inside the function.
  await sql`SELECT bootstrap_personal_organization(${userId}, ${orgId}, ${slug}, ${memberId})`

  return orgId
}

async function addMember(
  sql: Sql,
  organizationId: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<void> {
  // Idempotent insert: ON CONFLICT, update the role. Unique key is
  // (organization_id, user_id).
  const memberId = `${organizationId}:${role}:${userId.replace(/-/g, '').slice(0, 16)}`
  await sql`
    INSERT INTO organization_members (id, organization_id, user_id, role, created_at)
    VALUES (${memberId}, ${organizationId}, ${userId}, ${role}, now())
    ON CONFLICT (organization_id, user_id) DO UPDATE
      SET role = EXCLUDED.role
  `
}

async function main() {
  const sql = postgres(DATABASE_URL!, { max: 1, prepare: false })

  try {
    console.log('🌱  Seeding saas-review test users (idempotent)…')

    const userIds: Record<Role, string> = {} as Record<Role, string>
    const orgIds: Record<Role, string> = {} as Record<Role, string>

    // Wipe the previous test users' memberships and accounts so we can
    // re-create them in the order this run dictates. ON CONFLICT alone
    // can't change `created_at` on existing rows, so the landing-org
    // ordering from a previous run would leak through otherwise.
    // Owner-side (the user + their personal org) is preserved; only the
    // org_members rows and auth_accounts are touched.
    const owner = USERS.find((u) => u.role === 'owner')!
    const admin = USERS.find((u) => u.role === 'admin')!
    const member = USERS.find((u) => u.role === 'member')!

    userIds.owner = await ensureUser(sql, owner)
    userIds.admin = await ensureUser(sql, admin)
    userIds.member = await ensureUser(sql, member)

    const testEmails = USERS.map((u) => u.email)
    const [wipedMembers] = await sql<{ count: number }[]>`
      WITH d AS (
        DELETE FROM organization_members
         WHERE user_id IN (SELECT id FROM auth_users WHERE email = ANY(${testEmails}))
         RETURNING 1
      )
      SELECT count(*)::int AS count FROM d
    `
    if (wipedMembers.count > 0) {
      console.log(`  ↺  Wiped ${wipedMembers.count} stale membership(s) to reset landing-org ordering`)
    }

    // 1. Owner — their personal org is the shared workspace. Bootstrap it
    //    before any other user exists, so the org owner membership has the
    //    earliest timestamp.
    orgIds.owner = await ensurePersonalOrg(sql, userIds.owner)
    console.log(`  ✓ owner   ${owner.email}  →  org ${orgIds.owner}`)

    // 2. Add admin and member to the shared org BEFORE creating their own
    //    personal orgs. That way the shared-org membership has the earlier
    //    created_at, so `pickDefaultActiveOrganizationId` lands them in the
    //    shared workspace on login instead of their own personal one.
    await addMember(sql, orgIds.owner, userIds.admin, 'admin')
    await addMember(sql, orgIds.owner, userIds.member, 'member')
    console.log(`  ✓ admin   ${admin.email}  →  member of ${orgIds.owner} (role: admin)`)
    console.log(`  ✓ member  ${member.email}  →  member of ${orgIds.owner} (role: member)`)

    // 3. Bootstrap personal orgs for admin and member, so the rows exist
    //    for any code path that assumes every user has one (org switcher,
    //    /me, etc.). These have LATER created_at than the shared membership,
    //    so they don't change the default landing.
    orgIds.admin = await ensurePersonalOrg(sql, userIds.admin)
    orgIds.member = await ensurePersonalOrg(sql, userIds.member)
    console.log(`  ✓ admin   personal org ${orgIds.admin} (created after shared — does not affect default landing)`)
    console.log(`  ✓ member  personal org ${orgIds.member} (created after shared — does not affect landing)`)

    console.log('\n✅  Done. Use these credentials in the saas-review audit:')
    for (const user of USERS) {
      console.log(`  ${user.role.padEnd(6)}  ${user.email}  /  ${user.password}`)
    }
    console.log(`  platform-admin  ${process.env.DEFAULT_ADMIN_EMAIL ?? 'edd_admin@local.com'}  (DEFAULT_ADMIN_*)`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

main().catch((err) => {
  console.error('❌  seed-test-users failed:', err)
  process.exit(1)
})
