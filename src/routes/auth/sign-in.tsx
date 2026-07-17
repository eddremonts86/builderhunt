import { createFileRoute } from '@tanstack/react-router'
import { SignInPage } from '~/modules/auth/components/SignInPage'

export const Route = createFileRoute('/auth/sign-in')({
  // Accept ?redirect=/some/path so we can return the user to the page
  // they tried to visit before being bounced to sign-in.
  validateSearch: (search: Record<string, unknown>): {
    redirect?: string
    claimed?: string
    email?: string
    claimError?: string
  } => ({
    redirect: typeof search.redirect === 'string' ? search.redirect : undefined,
    // `claimed` arrives as ?claimed=1 — the router's default search parser
    // coerces numeric-looking query values to `number`, so accept both.
    claimed: typeof search.claimed === 'string' || typeof search.claimed === 'number'
      ? String(search.claimed)
      : undefined,
    email: typeof search.email === 'string' ? search.email : undefined,
    claimError: typeof search.claimError === 'string' ? search.claimError : undefined,
  }),
  component: SignInPage,
})