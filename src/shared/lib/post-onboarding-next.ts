/**
 * Shared sessionStorage key for the guest-search intent stashed at signup
 * (plan: audit-conversion) — read once onboarding finishes so a user who
 * arrived via `/explore` lands back on their search instead of a bare
 * dashboard. The stashed value is always `safe-next.ts`-validated before
 * being written, so every reader can navigate to it directly.
 */
export const POST_ONBOARDING_NEXT_KEY = 'bh-post-onboarding-next'

/** Reads and clears the stashed destination — one-shot, so it doesn't leak into later sessions. */
export function consumePostOnboardingNext(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.sessionStorage.getItem(POST_ONBOARDING_NEXT_KEY)
    if (value) window.sessionStorage.removeItem(POST_ONBOARDING_NEXT_KEY)
    return value
  } catch {
    return null
  }
}
