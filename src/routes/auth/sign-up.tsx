import { createFileRoute } from '@tanstack/react-router'
import { SignUpPage } from '~/modules/auth/components/SignUpPage'

export const Route = createFileRoute('/auth/sign-up')({
  // Accepts ?next=/search?... from a completed guest search on /explore
  // (plan: audit-conversion) — SignUpPage validates it via safe-next.ts
  // before ever redirecting there.
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === 'string' ? search.next : undefined,
  }),
  component: SignUpPage,
})