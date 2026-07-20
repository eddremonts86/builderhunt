import type { TenantWriteMode } from './tenant-flags'

export interface TenantWriteOperations<TLegacy, TCanonical> {
  idempotencyKey: string
  legacy(idempotencyKey: string): Promise<TLegacy>
  canonical(idempotencyKey: string): Promise<TCanonical>
}

export async function executeTenantWrite<TLegacy, TCanonical>(
  mode: TenantWriteMode,
  operations: TenantWriteOperations<TLegacy, TCanonical>,
): Promise<TLegacy | TCanonical> {
  if (!operations.idempotencyKey) throw new Error('Tenant write idempotency key is required')
  if (mode === 'legacy') return operations.legacy(operations.idempotencyKey)
  if (mode === 'canonical') return operations.canonical(operations.idempotencyKey)

  const legacyResult = await operations.legacy(operations.idempotencyKey)
  await operations.canonical(operations.idempotencyKey)
  return legacyResult
}
