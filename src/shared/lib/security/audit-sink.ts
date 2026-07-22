import type { SecurityAuditSink } from './audit'

// No durable sink wired yet — audits land in server logs (already redacted by
// emitSecurityAudit) until a persistent store exists.
export const consoleSecurityAuditSink: SecurityAuditSink = {
  write(event) {
    console.log('[security-audit]', JSON.stringify(event))
  },
}
