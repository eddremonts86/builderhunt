import { createFileRoute } from '@tanstack/react-router'
import { ResetPasswordPage } from '~/modules/auth/components/ResetPasswordPage'

export const Route = createFileRoute('/auth/reset')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  component: ResetPasswordPage,
})
