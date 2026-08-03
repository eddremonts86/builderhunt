import type { SecurityAuditEvent, SecurityAuditSink } from './audit'

/**
 * Logs the event and nothing else. Kept rather than replaced: it is what the durable sink degrades to when an insert
 * fails, so a database problem costs a line its query-ability but never the line itself.
 */
export const consoleSecurityAuditSink: SecurityAuditSink = {
  write(event) {
    console.log('[security-audit]', JSON.stringify(event))
  },
}

/**
 * Writes the event to `security_audit_events`, and logs it either way.
 *
 * ## Why both
 *
 * The console line is not redundant. An audit trail that a failing insert can silence is not a trail, so the log
 * always happens; the row is what makes it *queryable*, which is the part that was missing. Plan 32 hit exactly this
 * while building denial clustering — found no durable table and had to route around it with Redis counters.
 *
 * ## Why a failed insert never propagates
 *
 * Every caller is mid-action: `auditPlatformAdminAction` runs after an admin operation has already happened,
 * `inviteMember` after an invitation already exists. Letting the audit write fail the request would turn a
 * bookkeeping problem into a user-visible error *and* leave the committed action unrecorded — strictly worse than an
 * event that is logged but not indexed. So the insert is best-effort, and its failure is itself logged with the event
 * that could not be stored.
 *
 * ## No RETURNING
 *
 * The app role gets INSERT and deliberately not SELECT: a trail the request path can read back is a trail it can
 * leak. `INSERT ... RETURNING` needs SELECT as well, so this has to stay a plain insert — the same trap already
 * recorded for write-only roles in this codebase.
 */
export function createDatabaseSecurityAuditSink(
  insert: (event: SecurityAuditEvent) => Promise<void>,
): SecurityAuditSink {
  return {
    async write(event) {
      consoleSecurityAuditSink.write(event)
      try {
        await insert(event)
      } catch (error) {
        // Logged, not thrown — see above. The event is repeated so a failed insert still leaves the whole record in
        // one place, next to the reason it was not stored.
        console.error('[security-audit] persist failed', JSON.stringify(event), error)
      }
    },
  }
}
