import { createAuthClient } from 'better-auth/react'
import { ensureProtocol } from '~/shared/lib/env'

export const authClient = createAuthClient({
  baseURL: ensureProtocol(import.meta.env.VITE_APP_URL ?? 'http://localhost:3000'),
})

export const signInEmail = authClient.signIn.email
export const signUpEmail = authClient.signUp.email
export const signOut = authClient.signOut
export const useSession = authClient.useSession