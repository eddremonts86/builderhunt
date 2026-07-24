/**
 * Wave 1 Task 4 — the single URL-allowlist used by the egress guard
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md
 * §External-egress guard, factored out per §Step 7).
 *
 * Policy:
 *   - Allowed hosts: `localhost`, `127.0.0.1`, and the worker's own
 *     Postgres host (endpoint only, read from `DATABASE_MIGRATION_URL`
 *     at install time — never the full URL, never its credentials).
 *   - Even on an allowed host, the Postgres port itself is blocked: an
 *     HTTP fetch aimed at the database is always a bug (SSRF-shaped),
 *     never a legitimate E2E request.
 *   - Everything else — api.resend.com, api.stripe.com, api.minimax.io,
 *     DNS-rebinding hosts, all of it — is blocked by default.
 */

export type EgressBlockReason = `host: ${string}` | `port: ${string}`

export interface EgressAllowlist {
  hosts: ReadonlySet<string>
  blockedPorts: ReadonlySet<string>
}

export interface EgressDecision {
  allowed: boolean
  reason?: EgressBlockReason
}

const DEFAULT_POSTGRES_PORT = '5432'

/** Endpoint-only parse of `DATABASE_MIGRATION_URL` — host and port, nothing else. */
export function resolveAllowlist(databaseMigrationUrl: string | undefined = process.env.DATABASE_MIGRATION_URL): EgressAllowlist {
  const hosts = new Set(['localhost', '127.0.0.1'])
  const blockedPorts = new Set([DEFAULT_POSTGRES_PORT])
  if (databaseMigrationUrl) {
    try {
      const parsed = new URL(databaseMigrationUrl)
      if (parsed.hostname) hosts.add(parsed.hostname)
      blockedPorts.add(parsed.port || DEFAULT_POSTGRES_PORT)
    } catch {
      // Unparseable DB URL — keep the localhost-only default.
    }
  }
  return { hosts, blockedPorts }
}

export function evaluateEgress(url: URL, allowlist: EgressAllowlist): EgressDecision {
  if (!allowlist.hosts.has(url.hostname)) {
    return { allowed: false, reason: `host: ${url.hostname}` }
  }
  if (url.port && allowlist.blockedPorts.has(url.port)) {
    return { allowed: false, reason: `port: ${url.port}` }
  }
  return { allowed: true }
}
