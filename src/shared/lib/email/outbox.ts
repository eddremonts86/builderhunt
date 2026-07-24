/**
 * Wave 1 Task 4 — in-process E2E email outbox.
 *
 * Pure module: no env parsing, no I/O, no imports. The outbox is a
 * per-process singleton stored on `globalThis.__emailOutbox` so both the
 * app code (the `dispatchEmail` seam in `src/shared/lib/email.ts`) and the
 * E2E harness (`e2e/harness/fakes/email.ts`) observe the same array
 * regardless of module-graph duplication (Vite SSR and the Playwright
 * runner can each hold their own module instance, but they share one
 * `globalThis` per process).
 *
 * E2E gating lives in the dispatcher, not here — this module is inert data
 * storage; recording only ever happens when `dispatchEmail` (E2E-only) or
 * a test calls it explicitly.
 */

export interface OutboxEntry {
  to: string
  subject: string
  html: string
  /** ISO timestamp of the capture — assigned by `recordOutbox`. */
  sentAt: string
  /** Optional scenario tag the sender was driven under (e.g. a billing scenario). */
  scenario?: string
}

export interface RecordOutboxInput {
  to: string
  subject: string
  html: string
  scenario?: string
}

interface OutboxGlobal {
  __emailOutbox?: OutboxEntry[]
  __emailOutboxCounter?: number
}

function outboxGlobal(): OutboxGlobal {
  return globalThis as OutboxGlobal
}

/**
 * Idempotent: returns the per-process singleton array, creating it on the
 * first call. A second call returns the exact same instance.
 */
export function installOutbox(): OutboxEntry[] {
  const g = outboxGlobal()
  if (!g.__emailOutbox) {
    g.__emailOutbox = []
    g.__emailOutboxCounter = 0
  }
  return g.__emailOutbox
}

/** Appends one entry and returns its 1-based sequence number. */
export function recordOutbox(input: RecordOutboxInput): number {
  const entries = installOutbox()
  const g = outboxGlobal()
  g.__emailOutboxCounter = (g.__emailOutboxCounter ?? 0) + 1
  entries.push({
    to: input.to,
    subject: input.subject,
    // Stored verbatim — token links are NOT redacted here; redaction (when
    // needed) is the reading test's responsibility, mirroring the existing
    // `devLink` behavior in `src/shared/lib/email.ts`.
    html: input.html,
    sentAt: new Date().toISOString(),
    ...(input.scenario !== undefined ? { scenario: input.scenario } : {}),
  })
  return g.__emailOutboxCounter
}

/** Read-only view of the captured entries (same singleton array). */
export function readOutbox(): readonly OutboxEntry[] {
  return installOutbox()
}

/**
 * Empties the singleton in place (held references stay valid) and restarts
 * the counter — the `dropNamespace`-style per-worker reset.
 */
export function resetOutbox(): void {
  const entries = installOutbox()
  entries.length = 0
  outboxGlobal().__emailOutboxCounter = 0
}
