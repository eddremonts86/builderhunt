import { createFileRoute } from '@tanstack/react-router'
import { SignInPage } from '~/modules/auth/components/SignInPage'

export const Route = createFileRoute('/auth/sign-in')({
  component: SignInPage,
})