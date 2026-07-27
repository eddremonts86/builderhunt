/**
 * Wave 1 Task 1 — unique-id helper for E2E fixtures.
 *
 * Every fixture identifier (user, organization, builder, alert, etc.) must
 * be unique across the test run so that two workers running the same
 * fixture template cannot collide on a primary key. Tests must not use
 * fixed shared identifiers for this reason — see
 * `docs/superpowers/specs/2026-07-23-exhaustive-local-e2e-design.md`
 * "Determinism and isolation".
 *
 * The id format is intentionally short and human-readable: prefixed with
 * the caller's label so test failures are self-explanatory, followed by a
 * timestamp + random suffix so two calls in the same millisecond cannot
 * collide, and finally an optional scope tag (e.g. worker index) so
 * different test contexts can be told apart at a glance.
 */
import { randomBytes } from 'node:crypto'

export function uniqueId(label: string, scope?: string): string {
  const ts = Date.now().toString(36)
  const rand = randomBytes(6).toString('hex')
  const scopePart = scope ? `_${scope}` : ''
  // Lowercase, ASCII-safe, bounded length — safe to use as a postgres
  // identifier suffix and as a Better Auth user id fragment.
  return `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}${scopePart}_${ts}_${rand}`
}
