import { createHash } from 'node:crypto'

export function builderIdentityId(source: string, sourceId: string) {
  return `bid_${sha256(`builderhunt:builder-identity:v1:${source}:${sourceId}`).slice(0, 32)}`
}

export function builderSnapshotHash(payload: Record<string, unknown>) {
  return sha256(stableJson(payload))
}

export function classifyLegacyBuilder(input: {
  organizationId: string | null
  hasResourceConflict: boolean
  isClaimed: boolean
  isVerified: boolean
}): 'migrated' | 'conflict' | 'orphan' {
  if (!input.organizationId) return 'orphan'
  if (input.hasResourceConflict || input.isClaimed || input.isVerified) return 'conflict'
  return 'migrated'
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

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
