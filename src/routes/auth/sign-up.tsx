import { createFileRoute } from '@tanstack/react-router'
import { SignUpPage } from '~/modules/auth/components/SignUpPage'

export const Route = createFileRoute('/auth/sign-up')({
  // Accepts ?next=/search?... from a completed guest search on /explore
  // (plan: audit-conversion) — SignUpPage validates it via safe-next.ts
  // before ever redirecting there.
  //
  // And ?goal=investing from a segmented landing CTA (plan: phase-2/06-landing-segmentada). It is
  // carried through, never acted on: `stashSegmentHint` narrows it to the enum before anything
  // stores it, and the goal step on the other side only uses it to preselect a radio button.
  validateSearch: (search: Record<string, unknown>): { next?: string; goal?: string } => ({
    next: typeof search.next === 'string' ? search.next : undefined,
    goal: typeof search.goal === 'string' ? search.goal : undefined,
  }),
  component: SignUpPage,
})