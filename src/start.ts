import { createStart } from '@tanstack/react-start'
import { canonicalHostMiddleware } from '~/shared/lib/http/canonical-host'

export const startInstance = createStart(() => ({
  defaultSsr: true,
  // First and only request middleware: a request for a retired hostname should be answered with a
  // redirect before anything reads a session or touches the database. Unset configuration makes it a
  // no-op, so this costs one comparison per request everywhere except production.
  requestMiddleware: [canonicalHostMiddleware],
}))
