import postgres from 'postgres'

/**
 * A connection for a test that needs to *observe* database state — session rows, memberships,
 * anything the app wrote that no endpoint exposes.
 *
 * It deliberately uses `DATABASE_MIGRATION_URL` (the admin role) rather than `DATABASE_URL`, for two
 * reasons that both showed up as confusing failures:
 *
 *   * `DATABASE_URL` is `builderhunt_app`, and the app role has no grant on `auth_sessions` or
 *     `auth_users` — those belong to the auth role. A test reading them that way fails with
 *     `permission denied` and looks like an application bug.
 *   * Even where a grant exists, the app role is subject to RLS with no tenant context set, so rows
 *     the application really did write come back empty. That reads as "the feature is broken" when
 *     the only broken thing is the observer's vantage point.
 *
 * An assertion about what the app *can reach* belongs in an HTTP request or a role-scoped harness
 * fixture, not here. This is for checking that a write landed, from outside.
 */
export function observerSql(): ReturnType<typeof postgres> {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('observerSql needs DATABASE_MIGRATION_URL or DATABASE_URL')
  return postgres(url, { max: 1 })
}
