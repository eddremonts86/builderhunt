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

/**
 * `from` continuity for the builder workspace (plans/UI/tasks.md Wave 2 "Preserve safe origin
 * context on builder pages") — several legitimate origins instead of `parseSafeNext`'s exactly one,
 * so it gets its own allowlist rather than widening that function's single-purpose contract.
 * Reuses the same URL-normalization technique: resolving against a fixed dummy origin uses the
 * platform's own parser to collapse percent-encoding, `..`, and backslash tricks consistently.
 */
const ALLOWED_BUILDER_FROM_EXACT = new Set(['/search', '/alerts'])
const ALLOWED_BUILDER_FROM_PREFIXES = ['/sprints/', '/lists/'] as const

export const DEFAULT_BUILDER_FROM = '/search'

export function parseSafeBuilderFrom(raw: string | undefined | null): string | null {
  if (!raw) return null
  if (!/^\/(?!\/)/.test(raw)) return null

  let url: URL
  try {
    url = new URL(raw, 'https://internal.invalid')
  } catch {
    return null
  }
  const path = url.pathname

  const isAllowed = ALLOWED_BUILDER_FROM_EXACT.has(path)
    || ALLOWED_BUILDER_FROM_PREFIXES.some((prefix) => path.startsWith(prefix) && path.length > prefix.length)
  if (!isAllowed) return null

  return `${path}${url.search}`
}

/** Resolves an untrusted `from` query value to a safe origin the builder workspace understands, or `DEFAULT_BUILDER_FROM`. */
export function resolveSafeBuilderFrom(raw: string | undefined | null): string {
  return parseSafeBuilderFrom(raw) ?? DEFAULT_BUILDER_FROM
}
