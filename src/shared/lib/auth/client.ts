import { createAuthClient } from 'better-auth/client'

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_APP_URL ?? 'http://localhost:3000',
})

export const signInEmail = authClient.signIn.email
export const signUpEmail = authClient.signUp.email
export const signOut = authClient.signOut
export const useSession = authClient.useSession