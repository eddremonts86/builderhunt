/**
 * Wave 1 Task 2 — principal fixtures.
 *
 * Mints every principal the product knows: anonymous, unverified, verified,
 * member, organization admin, owner, and (via `fixtures/platform-admin.ts`)
 * platform admin. Users are created through the REAL sign-up API — real
 * sign-up as a user journey remains a separate regression path; this layer
 * just refuses to fabricate sessions. Two deliberate direct-DB writes exist
 * because no product flow covers them locally:
 *   - email verification (`markEmailVerified`) — the app sends no
 *     verification email flow;
 *   - role-carrying membership (see `fixtures/organizations.ts`).
 *
 * Every principal captures a Playwright storage state from its live
 * authenticated context; the spec proves each state authenticates through
 * `/api/auth/get-session` and resolves through the real authorization layer.
 */
import type { APIRequestContext } from 'playwright/test'
import type { Sql } from 'postgres'
import {
  captureStorageState,
  credentialsFor,
  EMPTY_STORAGE_STATE,
  getSession,
  newApiContext,
  setActiveOrganization,
  signUp,
  type E2ECredentials,
  type StorageState,
} from '../auth'
import type { FixedClock } from '../clock'
import type { EntitlementTier, OrganizationRole, PrincipalKind } from '../roles'
import { addMemberDirect, createOrganizationFixture, deleteOrganization, type OrganizationFixture } from './organizations'

/** Everything a fixture needs to reach one worker's world: its app server and its disposable database. */
export interface FixtureContext {
  baseURL: string
  sql: Sql
  /** Worker tag (e.g. `w0`) mixed into every deterministic fixture id. */
  scope: string
}

export interface Principal {
  kind: PrincipalKind
  userId: string | null
  email: string | null
  password: string | null
  /** The principal's ACTIVE organization (null for anonymous). */
  organizationId: string | null
  /** Role held in the active organization (null for anonymous). */
  role: OrganizationRole | null
  storageState: StorageState | null
  /** Live authenticated request context (null for anonymous). */
  api: APIRequestContext | null
  /** Organizations this principal owns (personal workspace first) — cleanup scope. */
  ownedOrganizationIds: string[]
}

export async function createAnonymousPrincipal(_ctx: FixtureContext): Promise<Principal> {
  return {
    kind: 'anonymous',
    userId: null,
    email: null,
    password: null,
    organizationId: null,
    role: null,
    storageState: { ...EMPTY_STORAGE_STATE },
    api: null,
    ownedOrganizationIds: [],
  }
}

async function signUpPrincipal(
  ctx: FixtureContext,
  kind: PrincipalKind,
  label: string,
): Promise<{ principal: Principal; credentials: E2ECredentials }> {
  const credentials = credentialsFor(label, ctx.scope)
  const api = await newApiContext(ctx.baseURL)
  const { userId } = await signUp(api, credentials)
  const session = await getSession(api)
  if (!session || session.userId !== userId) {
    throw new Error(`sign-up for ${credentials.email} did not produce an authenticated session`)
  }
  if (!session.activeOrganizationId) {
    throw new Error(`sign-up for ${credentials.email} produced a session without a personal workspace`)
  }
  const principal: Principal = {
    kind,
    userId,
    email: credentials.email,
    password: credentials.password,
    organizationId: session.activeOrganizationId,
    role: 'owner', // owner of the personal workspace created at sign-up
    storageState: await captureStorageState(api),
    api,
    ownedOrganizationIds: [session.activeOrganizationId],
  }
  return { principal, credentials }
}

export async function createUnverifiedPrincipal(ctx: FixtureContext, label = 'unverified'): Promise<Principal> {
  const { principal } = await signUpPrincipal(ctx, 'unverified', label)
  return principal
}

/** Direct DB write — the product has no email-verification flow to drive. */
export async function markEmailVerified(sql: Sql, userId: string): Promise<void> {
  await sql`update auth_users set email_verified = true, updated_at = now() where id = ${userId}`
}

export async function createVerifiedPrincipal(ctx: FixtureContext, label = 'verified'): Promise<Principal> {
  const { principal } = await signUpPrincipal(ctx, 'verified', label)
  await markEmailVerified(ctx.sql, principal.userId!)
  return principal
}

/** A verified user who creates (and owns) a fixture organization with explicit entitlements. */
export async function createOwnerPrincipal(
  ctx: FixtureContext,
  options: { tier: EntitlementTier; seatLimit: number; clock: FixedClock; name?: string },
): Promise<{ principal: Principal; organization: OrganizationFixture }> {
  const { principal } = await signUpPrincipal(ctx, 'owner', 'owner')
  await markEmailVerified(ctx.sql, principal.userId!)
  const organization = await createOrganizationFixture(ctx, principal, options)
  // Better Auth switches the creator's session to the new organization.
  principal.organizationId = organization.organizationId
  principal.role = 'owner'
  principal.storageState = await captureStorageState(principal.api!)
  return { principal, organization }
}

/** A verified user holding `role` in an existing organization, session scoped to it. */
export async function createMemberPrincipal(
  ctx: FixtureContext,
  organizationId: string,
  role: Exclude<OrganizationRole, 'owner'>,
): Promise<Principal> {
  const { principal } = await signUpPrincipal(ctx, role, role)
  await markEmailVerified(ctx.sql, principal.userId!)
  await addMemberDirect(ctx.sql, { organizationId, userId: principal.userId!, role, scope: ctx.scope })
  // Real product API scopes the session to the organization (and verifies membership).
  await setActiveOrganization(principal.api!, organizationId)
  principal.organizationId = organizationId
  principal.role = role
  principal.storageState = await captureStorageState(principal.api!)
  return principal
}

export async function disposePrincipal(principal: Principal): Promise<void> {
  if (principal.api) {
    await principal.api.dispose().catch(() => undefined)
    principal.api = null
  }
}

/**
 * Remove exactly this principal's data: its owned organizations (cascading
 * members/invitations/entitlements), its user row (cascading sessions,
 * accounts, memberships, consents, export requests), and its FK-less
 * `deletion_requests` compliance row. Never touches any other principal.
 */
export async function cleanupPrincipal(ctx: FixtureContext, principal: Principal): Promise<void> {
  await disposePrincipal(principal)
  if (!principal.userId) return
  for (const organizationId of principal.ownedOrganizationIds) {
    await deleteOrganization(ctx.sql, organizationId)
  }
  await ctx.sql`delete from auth_users where id = ${principal.userId}`
  await ctx.sql`delete from deletion_requests where user_id = ${principal.userId}`
}
