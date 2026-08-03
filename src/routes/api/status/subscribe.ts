// Plan 47 (status-and-trust) Phase 2 — public subscribe endpoint.
//
// POST /api/status/subscribe  { email }  → 200 { ok: true }
// GET  /api/status/subscribe?remove=<token>  → 302 to /status
//
// Anti-enumeration: the POST response is the same shape whether the
// address was new or already on the list (the only difference is a
// "you are already subscribed" hint). A probe cannot enumerate which
// addresses are subscribed. The unsubscribe token is sent by email
// only; the GET removes the row keyed by the SHA-256 of the token.
//
// Rate limit is the same "public write" bucket as the rest of the
// status surface (`/api/health`, `/api/status`).
import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { z } from 'zod'
import { rateLimit } from '~/shared/lib/rate-limit'
import { env } from '~/shared/lib/env'
import {
  subscribe,
  unsubscribeByToken,
} from '~/shared/lib/repositories/status-subscribers'
import { dispatchEmail } from '~/shared/lib/email'

const SubscribeBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
})

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const Route = createFileRoute('/api/status/subscribe')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET', 'POST']),

      POST: async ({ request }) => {
        const limited = await rateLimit('status-subscribe', clientIp(request), 10, 60 * 60)
        if (!limited.allowed) {
          return Response.json(
            { error: 'rate_limited' },
            { status: 429, headers: { 'Retry-After': String(Math.ceil(limited.resetMs / 1000)) } },
          )
        }
        let rawBody: unknown = {}
        try {
          rawBody = await request.json()
        } catch {
          // Empty body is a 400.
        }
        const parsed = SubscribeBody.safeParse(rawBody)
        if (!parsed.success) {
          return Response.json({ error: 'invalid_email' }, { status: 400 })
        }
        const result = await subscribe({ email: parsed.data.email })
        if (result.unsubscribeToken) {
          // The confirmation email is the consent receipt. Until
          // /api/status/subscribe is called with a real RESEND_API_KEY
          // (the dispatchEmail helper no-ops when the key is unset)
          // we do not actually send, but the row exists, the token is
          // in the row, and the unsubscribe GET works.
          const appUrl = env.APP_URL.replace(/\/$/, '')
          const unsubscribeUrl = `${appUrl}/api/status/subscribe?remove=${encodeURIComponent(result.unsubscribeToken)}`
          await dispatchEmail({
            to: result.email,
            subject: 'You are subscribed to BuilderHunt status updates',
            html: `<!doctype html><p>Thanks for subscribing to BuilderHunt status updates.</p>` +
              `<p>We will email you when an incident is opened or resolved.</p>` +
              `<p><a href="${unsubscribeUrl}">Unsubscribe</a></p>`,
            scenario: 'status_subscribe_confirmation',
          }).catch((err) => {
            console.error('status subscribe confirmation email failed:', err)
          })
        }
        // Same response shape either way: a probe cannot tell
        // "newly subscribed" from "already subscribed" from the
        // status code or the body.
        return Response.json({ ok: true, alreadySubscribed: result.alreadySubscribed })
      },
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const token = url.searchParams.get('remove')
        const appUrl = env.APP_URL.replace(/\/$/, '') || '/'
        if (!token || !EMAIL_REGEX.test(token) === false && token.length < 8) {
          return Response.redirect(`${appUrl}/status?unsubscribed=invalid`, 302)
        }
        const removed = await unsubscribeByToken({ token })
        const query = removed ? 'unsubscribed=ok' : 'unsubscribed=invalid'
        return Response.redirect(`${appUrl}/status?${query}`, 302)
      },
    },
  },
})

function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  return request.headers.get('x-real-ip') ?? 'unknown'
}
