/**
 * Wave 1 Task 4 — E2E email fake (in-process outbox control surface)
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md).
 *
 * The storage itself lives in `src/shared/lib/email/outbox.ts` (a
 * `globalThis`-backed singleton) so the app's `dispatchEmail` seam and this
 * harness module observe the same array. This wrapper adds the harness-side
 * install semantics: E2E-gated, once per worker, `dropNamespace`-style
 * reset.
 *
 * When installed, every sender in `src/shared/lib/email.ts`
 * (`sendOrganizationInvitationEmail`, `sendClaimEmail`,
 * `sendResetPasswordEmail`, `sendAlertDigestEmail`,
 * `sendDeletionScheduledEmail`, `sendDeletionCompletedEmail`,
 * `sendExportReadyEmail`, and the billing senders) records here instead of
 * reaching Resend.
 */
import {
  installOutbox,
  readOutbox,
  resetOutbox,
  type OutboxEntry,
} from '../../../src/shared/lib/email/outbox'

export type { OutboxEntry }
export { readOutbox }

let installedForWorker = false

/**
 * Installs the outbox for this worker process. E2E-gated; a second install
 * without an intervening `uninstallEmailFake` is a harness bug and throws.
 */
export function installEmailFake(): OutboxEntry[] {
  if (process.env.E2E_MODE !== 'true') {
    throw new Error('installEmailFake is E2E-only (E2E_MODE=true required)')
  }
  if (installedForWorker) {
    throw new Error('Email fake is already installed for this worker — install once per worker process')
  }
  installedForWorker = true
  return installOutbox()
}

export function isEmailFakeInstalled(): boolean {
  return installedForWorker
}

/** Per-test cleanup: empties the outbox, keeps the install. */
export function resetEmailFake(): void {
  resetOutbox()
}

/** Worker teardown: empties the outbox and allows a fresh install. */
export function uninstallEmailFake(): void {
  resetOutbox()
  installedForWorker = false
}
