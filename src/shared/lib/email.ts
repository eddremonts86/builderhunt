import { env } from '~/shared/lib/env'

/**
 * Email helper. Uses Resend in production (when RESEND_API_KEY is set);
 * otherwise logs the link to the console and returns it as `devLink` so
 * the UI can show it in dev mode.
 *
 * Spec reference: plans/claimable-profiles/tasks.md#email-sending
 */

export interface SendResult {
  ok: boolean
  id?: string
  devLink?: string
  error?: string
}

export async function sendClaimEmail(to: string, link: string): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    // Dev mode — log and return the link so the UI can show it
    console.log('\n📧 [DEV] Claim email would be sent to:', to)
    console.log('   Link:', link, '\n')
    return { ok: true, devLink: link }
  }
  // Production: use Resend HTTP API (no extra dep — fetch directly)
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: 'Verify your BuilderHunt profile',
        html: claimEmailHtml(link),
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Resend ${res.status}: ${body}` }
    }
    const data = (await res.json()) as { id: string }
    return { ok: true, id: data.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Send a "reset your password" email. Used by better-auth's
 * emailAndPassword.sendResetPassword callback, and by the claim-verify flow
 * (a claimed profile creates an account with an unknown auto-generated
 * password — the user needs this to set a real one).
 */
export async function sendResetPasswordEmail(to: string, link: string): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Password reset email would be sent to:', to)
    console.log('   Link:', link, '\n')
    return { ok: true, devLink: link }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: 'Reset your BuilderHunt password',
        html: resetPasswordEmailHtml(link),
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Resend ${res.status}: ${body}` }
    }
    const data = (await res.json()) as { id: string }
    return { ok: true, id: data.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface AlertDigestItem {
  alertName: string
  username: string
  displayName?: string | null
  source: string
  profileUrl: string
  eventType: string
}

/**
 * Send a smart-alerts digest email — one email per user per worker run,
 * listing every trigger match found since the last run. Falls back to a
 * dev-mode console log (same pattern as sendClaimEmail /
 * sendResetPasswordEmail) when RESEND_API_KEY isn't configured.
 */
export async function sendAlertDigestEmail(to: string, items: AlertDigestItem[]): Promise<SendResult> {
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Alert digest email would be sent to:', to)
    for (const item of items) {
      console.log(`   - [${item.alertName}] ${item.displayName ?? item.username} (${item.source}) — ${item.eventType} — ${item.profileUrl}`)
    }
    console.log('')
    return { ok: true, devLink: undefined }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'BuilderHunt <alerts@builderhunt.dev>',
        to,
        subject: items.length === 1 ? 'BuilderHunt: 1 new alert match' : `BuilderHunt: ${items.length} new alert matches`,
        html: alertDigestEmailHtml(items),
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, error: `Resend ${res.status}: ${body}` }
    }
    const data = (await res.json()) as { id: string }
    return { ok: true, id: data.id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function alertDigestEmailHtml(items: AlertDigestItem[]): string {
  const rows = items
    .map(
      (item) => `
    <tr>
      <td style="padding:0.6rem 0;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:600;">${item.displayName ?? item.username}</div>
        <div style="color:#6b7280;font-size:0.85rem;">${item.source} · matched "${item.alertName}"</div>
      </td>
      <td style="padding:0.6rem 0;border-bottom:1px solid #e5e7eb;text-align:right;">
        <a href="${item.profileUrl}" style="color:#6366f1;text-decoration:none;font-size:0.85rem;">View →</a>
      </td>
    </tr>`,
    )
    .join('')
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">${items.length} new alert ${items.length === 1 ? 'match' : 'matches'}</h1>
    <p>Here's what matched your smart alerts since the last check:</p>
    <table style="width:100%;border-collapse:collapse;margin:1rem 0;">${rows}</table>
    <p style="margin:1.5rem 0;">
      <a href="https://builderhunt.dev/alerts" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">View all in dashboard</a>
    </p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function resetPasswordEmailHtml(link: string): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Reset your password</h1>
    <p>Someone (hopefully you) requested a password reset for your BuilderHunt account. Click the button below to set a new password:</p>
    <p style="margin:1.5rem 0;">
      <a href="${link}" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Reset my password</a>
    </p>
    <p style="color:#6b7280;font-size:0.85rem;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function claimEmailHtml(link: string): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Verify your BuilderHunt profile</h1>
    <p>Someone (hopefully you) claimed a BuilderHunt profile using this email. If that was you, click the button below to verify:</p>
    <p style="margin:1.5rem 0;">
      <a href="${link}" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Verify my profile</a>
    </p>
    <p style="color:#6b7280;font-size:0.85rem;">This link expires in 24 hours. If you didn't request this, you can safely ignore this email.</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}
