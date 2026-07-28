import { z } from 'zod'

/**
 * URLs that are safe to put in an `href`.
 *
 * `z.string().url()` is not that check. It accepts `javascript:alert(1)` and
 * `data:text/html,<script>…</script>` — measured, not assumed — because WHATWG URL parsing is about
 * syntax, not about what a browser will do when someone clicks it.
 *
 * That mattered concretely: `scheduling_invitations.meeting_url` was validated with `z.string().url()` and
 * rendered as a link on the **public candidate portal**, a signed-out page opened from an emailed capability
 * link. An organizer storing a `javascript:` URL would hand every candidate a clickable script execution in
 * the application's own origin, alongside the capability cookie that page runs on.
 *
 * So the rule is a scheme allowlist, not a denylist. A denylist has to anticipate `vbscript:`, `blob:`,
 * `filesystem:`, and whatever a future browser adds; an allowlist of `http` and `https` is complete by
 * construction and needs no maintenance.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/** True when a browser can be given this as an `href` without executing anything. */
export function isSafeHttpUrl(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    // A relative URL reaches here. Refused rather than allowed: every caller of this stores an
    // externally-supplied absolute link, and a relative one would silently point at our own app.
    return false
  }
  return ALLOWED_PROTOCOLS.has(parsed.protocol)
}

/**
 * The value to put in an `href`, or null.
 *
 * Used at the render site as well as at the API boundary, because rows stored before the schema was
 * tightened are still in the database. Validating only on the way in would leave those clickable.
 */
export function safeHttpHref(value: string | null | undefined): string | null {
  return isSafeHttpUrl(value) ? (value as string) : null
}

/** A zod schema for an externally-supplied link. Replaces `z.string().url()` wherever one is stored. */
export const httpUrlSchema = z.string().url().refine(isSafeHttpUrl, {
  message: 'must be an http or https URL',
})
