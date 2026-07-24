/**
 * Wave 1 Task 4 — E2E egress guard
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md
 * §External-egress guard).
 *
 * The ONLY module that overrides `globalThis.fetch`. Installed at most once
 * per worker process; refuses to attach unless `E2E_MODE=true`. Every
 * request to a host outside the allowlist (`localhost`, `127.0.0.1`, the
 * worker's Postgres host) — api.resend.com, api.stripe.com,
 * api.minimax.io, DNS-rebinding hosts, anything — rejects with
 * `EgressBlockedError`. Production code never imports this module.
 */
import { evaluateEgress, resolveAllowlist, type EgressAllowlist, type EgressBlockReason } from './_allowlist'

export class EgressBlockedError extends Error {
  constructor(
    readonly url: string,
    readonly reason: EgressBlockReason,
  ) {
    super(`E2E egress blocked (${reason}): ${url}`)
    this.name = 'EgressBlockedError'
  }
}

let originalFetch: typeof fetch | null = null

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === 'string') return new URL(input)
  if (input instanceof URL) return input
  return new URL(input.url)
}

/**
 * Installs the guard (idempotent — a second call on an already-guarded
 * process is a no-op, so multiple spec files sharing one worker are safe).
 * Uses `Object.defineProperty` so the override is cleanly reversible even
 * where `globalThis.fetch` is not a plain writable property.
 */
export function installEgressGuard(): void {
  if (process.env.E2E_MODE !== 'true') {
    throw new Error('installEgressGuard is E2E-only (E2E_MODE=true required)')
  }
  if (originalFetch) return
  const allowlist: EgressAllowlist = resolveAllowlist()
  const realFetch = globalThis.fetch
  originalFetch = realFetch

  const guardedFetch: typeof fetch = (input, init) => {
    let url: URL
    try {
      url = requestUrl(input)
    } catch {
      // Relative/unparseable URLs cannot leave the process — let the real
      // fetch produce its own error for them.
      return realFetch(input, init)
    }
    const decision = evaluateEgress(url, allowlist)
    if (!decision.allowed) {
      return Promise.reject(new EgressBlockedError(url.href, decision.reason!))
    }
    return realFetch(input, init)
  }

  Object.defineProperty(globalThis, 'fetch', { value: guardedFetch, configurable: true, writable: true })
}

/** Restores the original `fetch` — called by worker teardown. */
export function uninstallEgressGuard(): void {
  if (!originalFetch) return
  Object.defineProperty(globalThis, 'fetch', { value: originalFetch, configurable: true, writable: true })
  originalFetch = null
}

export function isEgressGuardInstalled(): boolean {
  return originalFetch !== null
}
