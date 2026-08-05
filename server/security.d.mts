/**
 * Hand-written declarations for `server/security.mjs`.
 *
 * The implementation is plain ESM so the production entrypoint (`server.prod.mjs`) can import
 * it — the runtime Docker stage does not copy `src/`. These declarations exist so TypeScript
 * callers and `test/security-headers.test.ts` stay type-checked. Keep them in sync by hand;
 * the module is intentionally small.
 */

export interface SecurityHeaderOptions {
  production: boolean
  secure: boolean
  /**
   * Request path. When it matches `PUBLIC_SCHEDULING_PATH_PREFIXES`, the returned set carries the
   * stricter scheduling CSP plus `Referrer-Policy: no-referrer` and `Cache-Control: no-store`.
   * Omit it for responses that cannot be a scheduling surface, such as static assets.
   */
  pathname?: string
  /** Browser-reachable origin of the object store, for the strict variant's `connect-src`. */
  uploadOrigin?: string | null
}

/** Path prefixes whose responses belong to an account-less candidate holding a capability. */
export const PUBLIC_SCHEDULING_PATH_PREFIXES: readonly string[]

export function isPublicSchedulingPath(pathname: unknown): boolean

export function publicSchedulingContentSecurityPolicy(
  options?: { uploadOrigin?: string | null },
): string

/** `new URL(endpoint).origin`, or null for anything unparseable — never throws. */
export function uploadOriginFrom(endpoint: string | undefined | null): string | null

/** Header name → value, for `res.writeHead()`. */
export function securityHeaderEntries(
  options: SecurityHeaderOptions,
): Record<string, string>

export function applySecurityHeaders(
  headers: Headers,
  options: SecurityHeaderOptions,
): Headers

/**
 * Anything shaped like a request: a Web `Request`, or node's `IncomingMessage` whose `headers`
 * is a plain object of lowercased names.
 */
export interface MutationOriginRequest {
  method?: string
  headers?:
    | Headers
    | Record<string, string | string[] | undefined>
    | null
}

export function isTrustedMutationOrigin(
  request: MutationOriginRequest,
  trustedOrigin: string,
): boolean
