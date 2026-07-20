import { redactLogValue } from '../log'

export interface SecurityAuditInput {
  organizationId: string | null
  actorUserId: string | null
  action: string
  targetType: string
  targetId: string | null
  result: 'allowed' | 'denied' | 'failed'
  requestId: string
  details?: Record<string, unknown>
}

export interface SecurityAuditEvent extends SecurityAuditInput {
  id: string
  createdAt: Date
  details: Record<string, unknown>
}

export interface SecurityAuditSink {
  write(event: SecurityAuditEvent): Promise<void> | void
}

export async function emitSecurityAudit(input: SecurityAuditInput, sink: SecurityAuditSink) {
  if (!input.action || !input.targetType || !input.requestId) {
    throw new Error('Security audit correlation fields are required')
  }
  const details = redactLogValue(input.details ?? {})
  await sink.write({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    result: input.result,
    requestId: input.requestId,
    details: isRecord(details) ? details : {},
    createdAt: new Date(),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
