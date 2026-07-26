/**
 * Validates the `next` search param carried from guest `/explore` through
 * signup (plan: audit-conversion) so the user lands back on their
 * authenticated search instead of losing intent — without opening a
 * redirect to an arbitrary or attacker-controlled destination.
 *
 * Only `/search` (optionally with a query string) is ever allowed. This is
 * intentionally narrow rather than a general "internal path" allowlist:
 * `/search` is the only authenticated destination guest search intent is
 * meant to restore.
 */
export function parseSafeNext(raw: string | undefined | null): string | null {
  if (!raw) return null
  // Reject anything that isn't a same-origin, root-relative path: absolute
  // URLs (`https://evil.com`), protocol-relative (`//evil.com`), and any
  // path not starting with a single `/` (backslash tricks, `javascript:`, etc).
  if (!/^\/(?!\/)/.test(raw)) return null

  let path: string
  try {
    // Resolve against a fixed dummy origin purely to get URL's own parsing/
    // normalization (handles `%2F`, `..`, etc. consistently) — the origin
    // itself is discarded below, never trusted from `raw`.
    path = new URL(raw, 'https://internal.invalid').pathname
  } catch {
    return null
  }

  if (path !== '/search') return null

  try {
    const url = new URL(raw, 'https://internal.invalid')
    return `${path}${url.search}`
  } catch {
    return null
  }
}
