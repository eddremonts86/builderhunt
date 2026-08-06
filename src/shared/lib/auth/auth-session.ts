import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'
import { auth } from '~/shared/lib/auth/better-auth'
import { parseAdminUserIds } from '~/shared/lib/auth/platform-admin'

export const getAppAuthSession = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const { getRequestHeaders } = await import('@tanstack/react-start/server')
    const headers = getRequestHeaders()
    const session = await auth.api.getSession({ headers })
    const userId = session?.user?.id ?? null
    let isPlatformAdmin = false
    if (userId) {
      const adminIds = parseAdminUserIds(process.env.ADMIN_USER_IDS)
      isPlatformAdmin = adminIds.has(userId)
    }
    return {
      userId,
      email: session?.user?.email ?? null,
      name: session?.user?.name ?? null,
      image: session?.user?.image ?? null,
      activeOrganizationId: session?.session?.activeOrganizationId ?? null,
      isPlatformAdmin,
    }
  } catch {
    return { userId: null, email: null, name: null, image: null, activeOrganizationId: null, isPlatformAdmin: false }
  }
})

/**
 * Admin routes' `beforeLoad` runs on BOTH the server (SSR / full page load)
 * AND the client (SPA link navigation). `process.env.ADMIN_USER_IDS` only
 * exists on the server — reading it directly in a route file makes every
 * client-side navigation to an admin page compute an empty allow-list and
 * throw a false "Forbidden", even for real admins (fixed after a manual
 * refresh, since that re-runs beforeLoad via SSR with the real env).
 * `createServerFn` guarantees this always executes on the server, however
 * it's called.
 */
export const getIsAppAdmin = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const { getRequestHeaders } = await import('@tanstack/react-start/server')
    const headers = getRequestHeaders()
    const session = await auth.api.getSession({ headers })
    const userId = session?.user?.id
    if (!userId) return false
    const adminIds = parseAdminUserIds(process.env.ADMIN_USER_IDS)
    return adminIds.has(userId)
  } catch {
    return false
  }
})

/**
 * Guard for admin routes' `beforeLoad`. Throws `redirect()` rather than
 * `Error('Forbidden')` so a non platform-admin is sent to `/dashboard` with
 * a flash — not handed the raw "Something went wrong" page that
 * `RootErrorBoundary` renders (saas-review F5).
 *
 * Unauthenticated callers land on `/auth/sign-in` first; authed non-admins
 * land on `/dashboard`. The flash parameter carries the reason so the
 * destination can surface it as a toast.
 *
 * Returns the session on success — callers that need the userId can read it
 * off the result instead of re-fetching.
 */
export async function requirePlatformAdminPage(): Promise<{ userId: string }> {
  const session = await getAppAuthSession({ data: undefined })
  if (!session.userId) {
    throw redirect({
      to: '/auth/sign-in',
      search: { redirect: '/admin' },
    })
  }
  if (!(await getIsAppAdmin({ data: undefined }))) {
    throw redirect({
      to: '/dashboard',
      search: { denied: 'admin' },
    })
  }
  return { userId: session.userId }
}