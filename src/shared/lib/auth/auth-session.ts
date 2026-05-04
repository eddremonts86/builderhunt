import { createServerFn } from '@tanstack/react-start'
import { auth } from '~/shared/lib/auth/better-auth'

export const getAppAuthSession = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    const { getRequestHeaders } = await import('@tanstack/react-start/server')
    const headers = getRequestHeaders()
    const session = await auth.api.getSession({ headers })
    return {
      userId: session?.user?.id ?? null,
      email: session?.user?.email ?? null,
      name: session?.user?.name ?? null,
      image: session?.user?.image ?? null,
    }
  } catch {
    return { userId: null, email: null, name: null, image: null }
  }
})