/**
 * Wave 1 Task 2 — platform admin fixture.
 *
 * Platform admin is an env-allow-listed principal (`ADMIN_USER_IDS`, see
 * `src/shared/lib/auth/platform-admin.ts`), never an organization role.
 * The server process reads the allow-list from its own environment, so the
 * admin's user id must exist BEFORE the worker server is spawned:
 *
 *   1. `reservePlatformAdminSeed` — mint the deterministic id/credentials.
 *   2. `registerPlatformAdminEnv` — put the id into `process.env.ADMIN_USER_IDS`
 *      (the worker-server spawner inherits `process.env`).
 *   3. start the worker server.
 *   4. `createPlatformAdminPrincipal` — insert the user + credential account
 *      rows with the RESERVED id (sign-up would generate its own id, which
 *      could never be allow-listed ahead of time — no product flow exists
 *      for pre-assigned ids), then sign in through the real API. Sign-in
 *      runs the real session hooks, so the admin also gets a personal
 *      workspace and an active organization like any other user.
 */
import { hashPassword } from 'better-auth/crypto'
import { uniqueId } from '../ids'
import {
  captureStorageState,
  DEFAULT_E2E_PASSWORD,
  getSession,
  newApiContext,
  signIn,
} from '../auth'
import type { FixtureContext, Principal } from './principals'
import { markEmailVerified } from './principals'

export interface PlatformAdminSeed {
  userId: string
  name: string
  email: string
  password: string
}

export function reservePlatformAdminSeed(scope?: string): PlatformAdminSeed {
  const userId = uniqueId('padmin', scope)
  return {
    userId,
    name: 'E2E Platform Admin',
    email: `${userId}@e2e.test`,
    password: DEFAULT_E2E_PASSWORD,
  }
}

/**
 * Append the reserved id to this process's ADMIN_USER_IDS so a subsequently
 * spawned worker server allow-lists it. Idempotent.
 */
export function registerPlatformAdminEnv(seed: PlatformAdminSeed): void {
  const existing = (process.env.ADMIN_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  if (!existing.includes(seed.userId)) existing.push(seed.userId)
  process.env.ADMIN_USER_IDS = existing.join(',')
}

export async function createPlatformAdminPrincipal(
  ctx: FixtureContext,
  seed: PlatformAdminSeed,
): Promise<Principal> {
  // Better Auth credential accounts store a scrypt hash produced by its own
  // `hashPassword`; using it here means the real sign-in endpoint verifies
  // the password with zero test-only seams in the app.
  const passwordHash = await hashPassword(seed.password)
  await ctx.sql`
    insert into auth_users (id, name, email, email_verified)
    values (${seed.userId}, ${seed.name}, ${seed.email}, true)
  `
  await ctx.sql`
    insert into auth_accounts (id, user_id, account_id, provider_id, password)
    values (${uniqueId('padmin-account', ctx.scope)}, ${seed.userId}, ${seed.userId}, 'credential', ${passwordHash})
  `
  await markEmailVerified(ctx.sql, seed.userId)

  const api = await newApiContext(ctx.baseURL)
  const { userId } = await signIn(api, seed)
  if (userId !== seed.userId) {
    throw new Error(`platform admin sign-in resolved ${userId}, expected reserved id ${seed.userId}`)
  }
  const session = await getSession(api)
  if (!session?.activeOrganizationId) {
    throw new Error('platform admin sign-in did not bootstrap a personal workspace')
  }
  return {
    kind: 'platform-admin',
    userId: seed.userId,
    email: seed.email,
    password: seed.password,
    organizationId: session.activeOrganizationId,
    role: 'owner', // owner of the personal workspace, like any signed-in user
    storageState: await captureStorageState(api),
    api,
    ownedOrganizationIds: [session.activeOrganizationId],
  }
}
