import { createHmac, randomUUID } from 'node:crypto'
import { emitSecurityAudit, type SecurityAuditSink } from '../security/audit'
import { consoleSecurityAuditSink } from '../security/audit-sink'
import { insertAbuseSignal } from '../repositories/abuse-signals'

export type AbuseSignalType =
  | 'concurrent_sessions'
  | 'impossible_travel'
  | 'ua_change'
  | 'seat_overuse'
  | 'signup_velocity'
  | 'linked_account'
  | 'export_burst'
  | 'cross_tenant_denied'
  | 'credit_farming'
  | 'pool_drain'
  | 'refund_farming'
  | 'margin_drift'
  | 'reserve_leak'

export type AbuseSignalSeverity = 'low' | 'medium' | 'high'

export interface AbuseSignal {
  type: AbuseSignalType
  severity: AbuseSignalSeverity
  requestId: string
  userId?: string | null
  organizationId?: string | null
  details?: Record<string, unknown>
}

/**
 * Stable, salted session-id hash for correlation in logs/signals — never the
 * raw session token. Same HMAC-with-caller-supplied-secret convention as
 * `abuse/device.ts`'s `computeDeviceHash` and `security/feed-capability.ts`.
 */
export function hashSessionId(sessionId: string, salt: string): string {
  return createHmac('sha256', salt).update(`builderhunt:session-signal:v1:${sessionId}`).digest('hex')
}

export interface EmitAbuseSignalDeps {
  sink?: SecurityAuditSink
  insert?: typeof insertAbuseSignal
}

/**
 * Records an abuse signal two ways: a security-audit log line (via the
 * existing `emitSecurityAudit`, which already redacts `details` through
 * `redactLogValue`) and a durable `abuse_signals` row for later
 * scoring/dashboards. `result: 'allowed'` because Phase 0-4 of this plan are
 * observe-only (`ABUSE_ENFORCEMENT_MODE` never blocks anything yet) — the
 * action that triggered this signal was always allowed to proceed; this call
 * only records that it happened.
 */
export async function emitAbuseSignal(signal: AbuseSignal, deps: EmitAbuseSignalDeps = {}): Promise<void> {
  const sink = deps.sink ?? consoleSecurityAuditSink
  const insert = deps.insert ?? insertAbuseSignal

  await emitSecurityAudit({
    organizationId: signal.organizationId ?? null,
    actorUserId: signal.userId ?? null,
    action: `abuse.${signal.type}`,
    targetType: 'abuse_signal',
    targetId: null,
    result: 'allowed',
    requestId: signal.requestId,
    details: signal.details,
  }, sink)

  await insert({
    id: randomUUID(),
    type: signal.type,
    severity: signal.severity,
    userId: signal.userId ?? null,
    organizationId: signal.organizationId ?? null,
    requestId: signal.requestId,
    details: signal.details ?? {},
  })
}
