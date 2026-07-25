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
}

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
