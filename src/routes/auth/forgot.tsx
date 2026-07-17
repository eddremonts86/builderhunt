import { createFileRoute } from '@tanstack/react-router'
import { ForgotPasswordPage } from '~/modules/auth/components/ForgotPasswordPage'

export const Route = createFileRoute('/auth/forgot')({
  component: ForgotPasswordPage,
})
