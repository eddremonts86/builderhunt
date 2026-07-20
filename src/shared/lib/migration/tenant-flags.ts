export type TenantWriteMode = 'legacy' | 'dual' | 'canonical'
export type TenantReadMode = 'legacy' | 'shadow' | 'canonical'

export interface TenantMigrationReadiness {
  canonicalReady: boolean
}

export function resolveTenantMigrationModes(
  environment: Record<string, unknown>,
  readiness: TenantMigrationReadiness,
): { read: TenantReadMode; write: TenantWriteMode } {
  const read = parseMode(environment.TENANT_READ_MODE, ['legacy', 'shadow', 'canonical'], 'legacy')
  const write = parseMode(environment.TENANT_WRITE_MODE, ['legacy', 'dual', 'canonical'], 'legacy')

  if (!readiness.canonicalReady && (read === 'canonical' || write === 'canonical')) {
    throw new Error('Canonical tenant mode is not ready')
  }
  return { read, write }
}

function parseMode<const T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === '') return fallback
  if (typeof value === 'string' && allowed.includes(value as T)) return value as T
  throw new Error(`Invalid tenant migration mode: ${String(value)}`)
}
