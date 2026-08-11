import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '~/shared/lib/env'
import { poolOptions, type PoolRole } from './pool-options'

/**
 * Lazily constructs the real `postgres()` client + drizzle instance on first
 * actual use, not at module-evaluation time.
 *
 * Why this matters: several "global table" repositories (e.g.
 * `repositories/devpost-profiles.ts`, `repositories/public-radars.ts`) import
 * `publicDb` as a value and call it directly, rather than receiving an
 * already-open `TenantTransaction`. Those repositories are themselves
 * imported — transitively, via `~/lib/search`'s source-connector fan-out —
 * by several `src/routes/api/**` route files, which TanStack Start's
 * generated route tree pulls into the **client** bundle too (a route module
 * needs to exist client-side for client-navigation, even when its only
 * client-relevant export is `component: () => null`). Eagerly calling
 * `postgres(...)` at module scope meant simply *importing* one of those
 * chains — never actually calling the function — was enough to execute
 * `postgres`'s Node-only internals in the browser, which reference the
 * Node global `Buffer` and throw `ReferenceError: Buffer is not defined`
 * before React ever mounts. That's a silent, total hydration failure with
 * no console error surfaced through normal means (only visible via a
 * `window.addEventListener('unhandledrejection', ...)` probe) — every click
 * handler, form submit, and theme toggle in the entire app stops working,
 * with the server-rendered HTML still displaying normally, masking the
 * cause. Deferring construction to first property access means the browser
 * bundle can safely *contain* this module without ever *running* the
 * Postgres client construction, since the browser never actually calls the
 * exported query functions.
 */
function lazyPostgresDb(role: PoolRole, resolveUrl: () => string): PostgresJsDatabase {
  let instance: PostgresJsDatabase | null = null
  function resolve(): PostgresJsDatabase {
    if (!instance) {
      instance = drizzle(postgres(resolveUrl(), poolOptions(role)))
    }
    return instance
  }
  return new Proxy({} as PostgresJsDatabase, {
    get(_target, prop, _receiver) {
      const real = resolve()
      const value = Reflect.get(real as object, prop, real)
      return typeof value === 'function' ? value.bind(real) : value
    },
  })
}

export const runtimeDb = lazyPostgresDb('runtime', () => env.DATABASE_URL)

// Public repositories are the only non-tenant product code allowed to use this
// surface. Private repositories must receive a TenantTransaction instead.
export const publicDb = runtimeDb
export type PublicDb = typeof publicDb
export const platformDb = lazyPostgresDb('platform', () => env.DATABASE_PLATFORM_URL ?? env.DATABASE_URL)
export const accountDb = runtimeDb

export type TenantTransaction = Parameters<Parameters<typeof runtimeDb.transaction>[0]>[0]
