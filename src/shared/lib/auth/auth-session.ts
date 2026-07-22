import { createServerFn } from '@tanstack/react-start'
import { auth } from '~/shared/lib/auth/better-auth'
import { parseAdminUserIds } from '~/shared/lib/auth/platform-admin'

export const getAppAuthSession = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const { getRequestHeaders } = await import('@tanstack/react-start/server')
    const headers = getRequestHeaders()
    const session = await auth.api.getSession({ headers })
    return {
      userId: session?.user?.id ?? null,
      email: session?.user?.email ?? null,
      name: session?.user?.name ?? null,
      image: session?.user?.image ?? null,
    }
  } catch {
    return { userId: null, email: null, name: null, image: null }
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