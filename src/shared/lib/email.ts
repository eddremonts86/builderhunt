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
