import { createHash } from 'node:crypto'
import type { TenantReadMode } from './tenant-flags'

interface ShadowRow {
  id: string
  [key: string]: unknown
}

export interface ShadowMismatchMetric {
  surface: string
  requestId: string
  legacyCount: number
  canonicalCount: number
  legacyOnlyIds: string[]
  canonicalOnlyIds: string[]
  changedIds: string[]
}

export interface TenantReadOperations<TRow extends ShadowRow> {
  surface: string
  requestId: string
  legacy(): Promise<TRow[]>
  canonical(): Promise<TRow[]>
  recordMismatch(metric: ShadowMismatchMetric): void | Promise<void>
}

export async function executeTenantRead<TRow extends ShadowRow>(
  mode: TenantReadMode,
  operations: TenantReadOperations<TRow>,
): Promise<TRow[]> {
  if (mode === 'legacy') return operations.legacy()
  if (mode === 'canonical') return operations.canonical()

  const legacyRows = await operations.legacy()
  const canonicalRows = await operations.canonical()
  const mismatch = compareRows(operations.surface, operations.requestId, legacyRows, canonicalRows)
  if (mismatch) await operations.recordMismatch(mismatch)
  return legacyRows
}

function compareRows<TRow extends ShadowRow>(
  surface: string,
  requestId: string,
  legacyRows: TRow[],
  canonicalRows: TRow[],
): ShadowMismatchMetric | null {
  const legacy = new Map(legacyRows.map((row) => [row.id, hashRow(row)]))
  const canonical = new Map(canonicalRows.map((row) => [row.id, hashRow(row)]))
  const legacyOnlyIds = [...legacy.keys()].filter((id) => !canonical.has(id)).sort()
  const canonicalOnlyIds = [...canonical.keys()].filter((id) => !legacy.has(id)).sort()
  const changedIds = [...legacy.keys()]
    .filter((id) => canonical.has(id) && canonical.get(id) !== legacy.get(id))
    .sort()
  if (legacyOnlyIds.length === 0 && canonicalOnlyIds.length === 0 && changedIds.length === 0) return null
  return {
    surface,
    requestId,
    legacyCount: legacyRows.length,
    canonicalCount: canonicalRows.length,
    legacyOnlyIds,
    canonicalOnlyIds,
    changedIds,
  }
}

function hashRow(row: ShadowRow) {
  return createHash('sha256').update(stableJson(row)).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
