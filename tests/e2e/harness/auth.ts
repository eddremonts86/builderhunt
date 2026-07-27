/**
 * Wave 1 Task 2 — real-API auth helpers for E2E fixtures.
 *
 * Everything here talks to the actual Better Auth endpoints of a running
 * per-worker app server (`/api/auth/*`) — no cookie forging, no session
 * fabrication. Storage states are captured from real authenticated request
 * contexts and verified through `/api/auth/get-session`, so a state that
 * passes here is byte-for-byte what a browser context receives.
 */
import { request, type APIRequestContext } from 'playwright/test'
import { uniqueId } from './ids'

export interface E2ECredentials {
  name: string
  email: string
  password: string
}

/**
 * One fixed strong password for every fixture user. Fixtures are minted in
 * disposable per-worker databases; per-user secrets would only make failure
 * output harder to reproduce.
 */
export const DEFAULT_E2E_PASSWORD = 'E2e-fixture-password-1!'

export function credentialsFor(label: string, scope?: string): E2ECredentials {
  const id = uniqueId(label, scope)
  return {
    name: `E2E ${label}`,
    email: `${id}@e2e.test`,
    password: DEFAULT_E2E_PASSWORD,
  }
}

export type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>

export const EMPTY_STORAGE_STATE: StorageState = { cookies: [], origins: [] }

export async function newApiContext(baseURL: string, storageState?: StorageState): Promise<APIRequestContext> {
  return request.newContext({
    baseURL,
    storageState,
    // Better Auth validates the Origin header against trusted origins when
    // one is present; send the app's own origin exactly like a browser would.
    extraHTTPHeaders: { origin: baseURL },
  })
}

async function expectOk(response: Awaited<ReturnType<APIRequestContext['post']>>, action: string): Promise<unknown> {
  if (!response.ok()) {
    const body = await response.text().catch(() => '<unreadable>')
    throw new Error(`${action} failed with ${response.status()}: ${body}`)
  }
  return response.json()
}

/** Real product sign-up (`POST /api/auth/sign-up/email`). Leaves the context authenticated. */
export async function signUp(api: APIRequestContext, credentials: E2ECredentials): Promise<{ userId: string }> {
  const body = (await expectOk(
    await api.post('/api/auth/sign-up/email', { data: credentials }),
    `sign-up for ${credentials.email}`,
  )) as { user?: { id?: string } }
  const userId = body.user?.id
  if (!userId) throw new Error(`sign-up for ${credentials.email} returned no user id`)
  return { userId }
}

/** Real product sign-in (`POST /api/auth/sign-in/email`). Leaves the context authenticated. */
export async function signIn(
  api: APIRequestContext,
  credentials: Pick<E2ECredentials, 'email' | 'password'>,
): Promise<{ userId: string }> {
  const body = (await expectOk(
    await api.post('/api/auth/sign-in/email', {
      data: { email: credentials.email, password: credentials.password },
    }),
    `sign-in for ${credentials.email}`,
  )) as { user?: { id?: string } }
  const userId = body.user?.id
  if (!userId) throw new Error(`sign-in for ${credentials.email} returned no user id`)
  return { userId }
}

export interface SessionSnapshot {
  userId: string
  email: string
  emailVerified: boolean
  activeOrganizationId: string | null
}

/** The canonical session check: `GET /api/auth/get-session` on the real server. */
export async function getSession(api: APIRequestContext): Promise<SessionSnapshot | null> {
  const response = await api.get('/api/auth/get-session')
  if (!response.ok()) return null
  const body = (await response.json().catch(() => null)) as {
    user?: { id: string; email: string; emailVerified: boolean }
    session?: { activeOrganizationId?: string | null }
  } | null
  if (!body?.user || !body.session) return null
  return {
    userId: body.user.id,
    email: body.user.email,
    emailVerified: body.user.emailVerified,
    activeOrganizationId: body.session.activeOrganizationId ?? null,
  }
}

/** Real product API: `POST /api/auth/organization/set-active`. */
export async function setActiveOrganization(api: APIRequestContext, organizationId: string): Promise<void> {
  await expectOk(
    await api.post('/api/auth/organization/set-active', { data: { organizationId } }),
    `set-active organization ${organizationId}`,
  )
}

/**
 * Real product API: `POST /api/auth/organization/create`. Unless
 * `keepCurrentActiveOrganization` is set, Better Auth switches the caller's
 * session to the new organization — the same behavior the product UI gets.
 */
export async function createOrganizationViaApi(
  api: APIRequestContext,
  input: { name: string; slug: string; keepCurrentActiveOrganization?: boolean },
): Promise<{ organizationId: string; slug: string }> {
  const body = (await expectOk(
    await api.post('/api/auth/organization/create', { data: input }),
    `create organization ${input.slug}`,
  )) as { id?: string; slug?: string }
  if (!body.id) throw new Error(`create organization ${input.slug} returned no id`)
  return { organizationId: body.id, slug: body.slug ?? input.slug }
}

export async function captureStorageState(api: APIRequestContext): Promise<StorageState> {
  return api.storageState()
}

/**
 * Prove a storage state authenticates on its own: build a brand-new request
 * context from nothing but the state and ask the real server who it is.
 */
export async function sessionFromStorageState(
  baseURL: string,
  storageState: StorageState,
): Promise<SessionSnapshot | null> {
  const api = await newApiContext(baseURL, storageState)
  try {
    return await getSession(api)
  } finally {
    await api.dispose()
  }
}
