import { createAuthClient } from 'better-auth/react'
import { organizationClient } from 'better-auth/client/plugins'
import { ensureProtocol } from '~/shared/lib/env'

export const authClient = createAuthClient({
  /**
   * The origin this page was actually served from — not the one baked at build time.
   *
   * `import.meta.env.VITE_APP_URL` is statically replaced by Vite when the client bundle is built,
   * so the value is fixed for the life of that build. For a client calling *its own* backend that
   * is strictly wrong: it makes a same-origin request into a cross-origin one the moment the app is
   * served from anywhere other than the host it was compiled for.
   *
   * It has been paid for twice. `playwright.config.ts` has to override APP_URL and VITE_APP_URL for
   * the dev server it starts, "or every request (starting with sign-up) 404s/connection-refuses
   * against whatever port `.env` happens to say" — its own comment. And it is why one build cannot
   * be served from N origins: the E2E harness gives every spec file a server on its own ephemeral
   * port, and a built client called `http://localhost:3010/api/auth/get-session` from a page on
   * 127.0.0.1:51983, which the browser then blocked on CORS.
   *
   * `window.location.origin` is what a same-origin client should have asked for all along. The
   * build-time value survives only for the server-rendering pass, where there is no window and
   * nothing is fetched anyway.
   */
  baseURL: typeof window === 'undefined'
    ? ensureProtocol(import.meta.env.VITE_APP_URL ?? 'http://localhost:3000')
    : window.location.origin,
  plugins: [organizationClient()],
})

export const signInEmail = authClient.signIn.email
export const signUpEmail = authClient.signUp.email
export const signOut = authClient.signOut
export const useSession = authClient.useSession
