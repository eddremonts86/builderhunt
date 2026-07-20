import { createHash } from 'node:crypto'

export function tenantAiCacheKey(input: { organizationId: string; artifact: string; input: string }) {
  if (!input.organizationId.trim()) throw new Error('AI tenant cache requires an organization ID')
  if (!input.artifact.trim()) throw new Error('AI tenant cache requires an artifact type')
  return `ai:tenant:${digest(input.organizationId)}:${digest(input.artifact)}:${digest(input.input)}`
}

export function publicSourceCacheKey(input: { source: string; sourceId: string; input: string }) {
  if (!input.source.trim() || !input.sourceId.trim()) throw new Error('Public AI cache requires source provenance')
  return `ai:public:${digest(`${input.source}:${input.sourceId}`)}:${digest(input.input)}`
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
