/**
 * The one remaining tenant-migration switch: whether a surface reads the legacy
 * per-creator way or the canonical per-organization way. Kept as a flag rather
 * than removed outright because it is the runbook's rollback — flipping a
 * surface back to `legacy` is the recovery path if canonical reads misbehave.
 *
 * There is no write mode: every insert has set `organization_id` for a long
 * time, so writes have been canonical all along and `TENANT_WRITE_MODE` never
 * selected anything.
 */
export type TenantReadMode = 'legacy' | 'canonical'

export interface TenantMigrationReadiness {
  canonicalReady: boolean
}

export function resolveTenantReadMode(
  environment: Record<string, unknown>,
  readiness: TenantMigrationReadiness,
): TenantReadMode {
  const read = parseMode(environment.TENANT_READ_MODE, ['legacy', 'canonical'], 'legacy')
  if (!readiness.canonicalReady && read === 'canonical') {
    throw new Error('Canonical tenant mode is not ready')
  }
  return read
}

function parseMode<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback
  // Retired mode, folded into `legacy` so an environment still set to it keeps
  // booting: it returned the legacy rows and only logged a comparison against
  // the canonical ones. See the note in `env.ts`.
  if (value === 'shadow') return fallback
  if (typeof value === 'string' && allowed.includes(value as T)) return value as T
  throw new Error(`Invalid tenant migration mode: ${String(value)}`)
}
