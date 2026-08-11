import { createServerFn } from '@tanstack/react-start'

/**
 * This platform admin's saved landing view, readable from a route's `beforeLoad` (plan 57, Admin track —
 * "Persist isolated platform-admin preferences").
 *
 * ## Why a server function and not a `fetch`
 *
 * `beforeLoad` runs on the server for the first load of a URL and in the browser for every client navigation
 * after it. A `fetch('/api/admin/preferences')` from there needs an absolute URL and forwarded cookies on the
 * server leg, which is a second authentication path for the same data. `createServerFn` runs on the server
 * however it is called, so there is one path.
 *
 * ## Why not import the repository directly
 *
 * Because `beforeLoad` is also client code. A direct import of
 * `~/shared/lib/repositories/platform-admin-preferences` reaches `postgres` through the db client, and this
 * repository has already shipped that mistake once: a route helper that touched the server layer put the
 * `postgres` driver in the browser bundle while `tsc`, `eslint`, 4,236 unit tests and `vite build` all passed
 * and every page was dead. `createServerFn`'s handler body is stripped from the client build, and the dynamic
 * `import()` inside it keeps the module graph out of the client's reach even at analysis time.
 *
 * ## Why it returns only the landing view
 *
 * `beforeLoad` decides one thing: where a bare `/admin/metrics` should land. The hidden-widget list is not part
 * of that decision, and returning it here would put a second copy of it in the router's state alongside
 * whatever the page fetches for itself — two sources for one preference, disagreeing the moment one is saved.
 */
export interface AdminLandingView {
  section: string
  range: string
  variant: string
}

/**
 * Never throws, and answers `null` rather than a default when it cannot read.
 *
 * `null` and "the defaults" have to be distinguishable here, because the caller does something different with
 * each: a saved landing view is worth redirecting to, and an unreadable one must leave the URL alone. A
 * `readPlatformAdminPreferences` that returned defaults on failure would make every failed read look like an
 * admin who had deliberately chosen the overview, and the redirect would fire on every load.
 */
export const getAdminLandingView = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AdminLandingView | null> => {
    try {
      const { getRequestHeaders } = await import('@tanstack/react-start/server')
      const { auth } = await import('~/shared/lib/auth/better-auth')
      const { parseAdminUserIds } = await import('~/shared/lib/auth/platform-admin')

      const headers = getRequestHeaders()
      const session = await auth.api.getSession({ headers })
      const userId = session?.user?.id
      if (!userId) return null

      /**
       * Re-checked here rather than trusted from the caller.
       *
       * `requirePlatformAdminPage()` runs first in the route and would already have redirected a non-admin, so
       * this looks redundant — but a server function is an endpoint, callable directly, and one that reads a
       * platform admin's console layout for whoever asks is a small disclosure of who the admins are.
       */
      if (!parseAdminUserIds(process.env.ADMIN_USER_IDS).has(userId)) return null

      const { readPlatformAdminPreferences } = await import(
        '~/shared/lib/repositories/platform-admin-preferences'
      )
      const preferences = await readPlatformAdminPreferences(userId)
      return preferences.landing
    } catch {
      // A preferences read must never keep an admin off the metrics page during an incident, which is exactly
      // when the database it reads from may be the thing that is broken.
      return null
    }
  },
)
