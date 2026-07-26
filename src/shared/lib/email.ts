import { env } from '~/shared/lib/env'
import { recordOutbox } from '~/shared/lib/email/outbox'
import { SITE_URL } from '~/shared/lib/site-url'

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

/**
 * Wave 1 Task 4 — E2E outbox seam
 * (docs/superpowers/plans/2026-07-23-wave1-task4-external-fakes.md).
 *
 * When `E2E_MODE === 'true'` every sender below short-circuits into this
 * dispatcher BEFORE its dev-mode/Resend branches, so E2E captures emails
 * even without `RESEND_API_KEY` and never performs Resend egress. Outside
 * E2E mode the dispatcher is unreachable (it throws), and every sender's
 * existing code path is byte-identical to its pre-seam behavior.
 */
export interface DispatchEmailInput {
  to: string
  subject: string
  html: string
  /** Passed through untouched so E2E UI flows that surface dev links keep working. */
  devLink?: string
  /** Optional scenario tag stored on the outbox entry. */
  scenario?: string
}

function isE2EOutboxActive(): boolean {
  return typeof process !== 'undefined' && process.env.E2E_MODE === 'true'
}

export async function dispatchEmail(input: DispatchEmailInput): Promise<SendResult> {
  if (!isE2EOutboxActive()) {
    throw new Error('dispatchEmail is E2E-only (E2E_MODE=true required) — production senders use their own Resend paths')
  }
  const sequence = recordOutbox({ to: input.to, subject: input.subject, html: input.html, scenario: input.scenario })
  return { ok: true, id: `outbox:${sequence}`, devLink: input.devLink }
}

export async function sendOrganizationInvitationEmail(
  to: string,
  organizationName: string,
  link: string,
): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({
      to,
      subject: `Invitation to join ${organizationName} on BuilderHunt`,
      html: organizationInvitationEmailHtml(organizationName, link),
      devLink: link,
    })
  }
  if (!env.RESEND_API_KEY) {
    // Do not log invitation URLs or recipient addresses: both are credentials/PII.
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
        subject: `Invitation to join ${organizationName} on BuilderHunt`,
        html: organizationInvitationEmailHtml(organizationName, link),
      }),
    })
    if (!res.ok) return { ok: false, error: `Resend request failed (${res.status})` }
    const data = (await res.json()) as { id: string }
    return { ok: true, id: data.id }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Email delivery failed' }
  }
}

export async function sendClaimEmail(to: string, link: string): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'Verify your BuilderHunt profile', html: claimEmailHtml(link), devLink: link })
  }
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
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'Reset your BuilderHunt password', html: resetPasswordEmailHtml(link), devLink: link })
  }
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
  if (isE2EOutboxActive()) {
    return dispatchEmail({
      to,
      subject: items.length === 1 ? 'BuilderHunt: 1 new alert match' : `BuilderHunt: ${items.length} new alert matches`,
      html: alertDigestEmailHtml(items),
    })
  }
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
      <a href="${SITE_URL}/alerts" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">View all in dashboard</a>
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

function organizationInvitationEmailHtml(organizationName: string, link: string): string {
  const safeName = organizationName
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
  const safeLink = link.replaceAll('&', '&amp;').replaceAll('"', '&quot;')

  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Join ${safeName}</h1>
    <p>You have been invited to collaborate in BuilderHunt.</p>
    <p style="margin:1.5rem 0;"><a href="${safeLink}" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Review invitation</a></p>
    <p style="color:#6b7280;font-size:0.85rem;">This invitation expires in 7 days. Sign in with the invited email address to accept it.</p>
  </body>
</html>`
}

/**
 * Deletion request confirmed — sent once when the 30-day grace period starts.
 * Free-tier friendly: same optional-key pattern as every other sender here —
 * no Resend key configured means log-and-return, zero cost, zero new dependency.
 */
export async function sendDeletionScheduledEmail(to: string, gracePeriodEndsAt: Date): Promise<SendResult> {
  const formattedDate = gracePeriodEndsAt.toISOString().slice(0, 10)
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'Your BuilderHunt account deletion is scheduled', html: deletionScheduledEmailHtml(formattedDate) })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Deletion-scheduled email would be sent to:', to, '— grace ends', formattedDate, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: 'Your BuilderHunt account deletion is scheduled',
        html: deletionScheduledEmailHtml(formattedDate),
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
 * Deletion completed — sent by the purge worker (legal.ts's
 * processPendingDeletions) right after the hard delete succeeds. The caller
 * must capture the email address before calling performHardDelete, since the
 * auth_users row (and its email) is gone once the delete transaction commits.
 */
export async function sendDeletionCompletedEmail(to: string): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'Your BuilderHunt account has been deleted', html: deletionCompletedEmailHtml() })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Deletion-completed email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: 'Your BuilderHunt account has been deleted',
        html: deletionCompletedEmailHtml(),
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

/** Data export ready — sent once the synchronous export payload is stored. */
export async function sendExportReadyEmail(to: string): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'Your BuilderHunt data export is ready', html: exportReadyEmailHtml() })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Export-ready email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: 'Your BuilderHunt data export is ready',
        html: exportReadyEmailHtml(),
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

/** Verify a newly-set billing contact email (plans/stripe-billing-platform/tasks.md §9 task 4). */
export async function sendBillingContactVerificationEmail(to: string, link: string): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'Confirm your BuilderHunt billing contact email', html: billingContactVerificationEmailHtml(link), devLink: link })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Billing contact verification email would be sent to:', to)
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
        subject: 'Confirm your BuilderHunt billing contact email',
        html: billingContactVerificationEmailHtml(link),
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

export interface BillingReceiptDetails {
  description: string
  amountCents: number
  currency: string
}

/** A successful subscription/pack payment — receipt only, never sent for a $0 or manually-granted change. */
export async function sendBillingReceiptEmail(to: string, details: BillingReceiptDetails): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'Your BuilderHunt receipt', html: billingReceiptEmailHtml(details) })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Billing receipt email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: 'Your BuilderHunt receipt',
        html: billingReceiptEmailHtml(details),
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

/** A failed subscription payment attempt — this and its grace-period consequences (see dunning.ts) are critical enough that this sender is always ALSO called for the organization owner, even when a separate billing contact exists (plans/stripe-billing-platform/tasks.md §9 task 4: "critical messages also reach owner"). */
export async function sendBillingPaymentFailedEmail(to: string): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'Action needed: your BuilderHunt payment failed', html: billingPaymentFailedEmailHtml() })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Billing payment-failed email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: 'Action needed: your BuilderHunt payment failed',
        html: billingPaymentFailedEmailHtml(),
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

/** Sent to the FORMER owner once an ownership transfer commits (plans/stripe-billing-platform/tasks.md §9 task 5) — confirms billing authority moved with ownership, never a request for action. */
export async function sendOwnershipTransferredFromEmail(to: string, organizationName: string, newOwnerName: string): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: `You transferred ownership of ${organizationName}`, html: ownershipTransferredFromEmailHtml(organizationName, newOwnerName) })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Ownership-transferred (from) email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: `You transferred ownership of ${organizationName}`,
        html: ownershipTransferredFromEmailHtml(organizationName, newOwnerName),
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

/** Sent to the NEW owner once an ownership transfer commits — billing authority (subscription, payment method, Portal access) moved to them along with ownership. */
export async function sendOwnershipTransferredToEmail(to: string, organizationName: string, previousOwnerName: string): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: `You're now the owner of ${organizationName}`, html: ownershipTransferredToEmailHtml(organizationName, previousOwnerName) })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Ownership-transferred (to) email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: `You're now the owner of ${organizationName}`,
        html: ownershipTransferredToEmailHtml(organizationName, previousOwnerName),
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

function deletionScheduledEmailHtml(gracePeriodEndDate: string): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Your account is scheduled for deletion</h1>
    <p>We received a request to delete your BuilderHunt account. If you don't cancel it, your account and its
      associated data will be permanently deleted on <strong>${gracePeriodEndDate}</strong>.</p>
    <p style="margin:1.5rem 0;">
      <a href="${SITE_URL}/dashboard/settings/privacy" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Sign in to cancel</a>
    </p>
    <p style="color:#6b7280;font-size:0.85rem;">If you didn't request this, sign in and cancel it immediately from your privacy settings.</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function deletionCompletedEmailHtml(): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Your account has been deleted</h1>
    <p>As requested, your BuilderHunt account and its associated data have been permanently deleted. This action
      cannot be undone.</p>
    <p style="color:#6b7280;font-size:0.85rem;">If you didn't request this, please contact us immediately — this email is the only record of the deletion.</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function exportReadyEmailHtml(): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Your data export is ready</h1>
    <p>The data export you requested from BuilderHunt is ready to view.</p>
    <p style="margin:1.5rem 0;">
      <a href="${SITE_URL}/dashboard/settings/privacy" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">View my export</a>
    </p>
    <p style="color:#6b7280;font-size:0.85rem;">This export link expires 7 days after the request. Request a new one anytime from your privacy settings.</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function billingContactVerificationEmailHtml(link: string): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Confirm your billing contact email</h1>
    <p>Someone set this address as the billing contact for a BuilderHunt organization. Confirm it to start receiving
      receipts and payment notices at this address.</p>
    <p style="margin:1.5rem 0;">
      <a href="${link}" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Confirm this email</a>
    </p>
    <p style="color:#6b7280;font-size:0.85rem;">This link expires in 24 hours. If you didn't expect this, you can safely ignore it — this address grants no account access.</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function billingReceiptEmailHtml(details: { description: string; amountCents: number; currency: string }): string {
  const amount = `${(details.amountCents / 100).toFixed(2)} ${details.currency.toUpperCase()}`
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Receipt from BuilderHunt</h1>
    <p>${details.description} — <strong>${amount}</strong>.</p>
    <p style="margin:1.5rem 0;">
      <a href="${SITE_URL}/settings/billing" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">View billing</a>
    </p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function billingPaymentFailedEmailHtml(): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Your payment didn't go through</h1>
    <p>We couldn't process your latest BuilderHunt subscription payment. Update your payment method to avoid
      losing access when your grace period ends.</p>
    <p style="margin:1.5rem 0;">
      <a href="${SITE_URL}/settings/billing" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Update payment method</a>
    </p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function ownershipTransferredFromEmailHtml(organizationName: string, newOwnerName: string): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">You transferred ownership of ${organizationName}</h1>
    <p><strong>${newOwnerName}</strong> is now the owner of ${organizationName}. Billing authority — the
      subscription, saved payment method, and Customer Portal access — moved to them along with ownership.
      Nothing was charged as part of this transfer.</p>
    <p style="color:#6b7280;font-size:0.85rem;">If you didn't request this, contact us immediately.</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function ownershipTransferredToEmailHtml(organizationName: string, previousOwnerName: string): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">You're now the owner of ${organizationName}</h1>
    <p><strong>${previousOwnerName}</strong> transferred ownership of ${organizationName} to you. Billing
      authority — the subscription, saved payment method, and Customer Portal access — moved to you along with
      ownership. Nothing was charged as part of this transfer.</p>
    <p style="margin:1.5rem 0;">
      <a href="${SITE_URL}/settings/billing" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Review billing</a>
    </p>
    <p style="color:#6b7280;font-size:0.85rem;">If you didn't expect this, contact us immediately.</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

/** Credit expiry notice at 30/7/1 days (plans/stripe-billing-platform/tasks.md §10 "Add financial notifications, metrics, and alerts") — `notifications.ts` calls this at most once per grant per bucket (deduplicated via `billing_notification_log`). */
export async function sendCreditExpiryNoticeEmail(to: string, details: { remainingUnits: number; daysUntilExpiry: number }): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({
      to,
      subject: `${details.remainingUnits} BuilderHunt credits expire in ${details.daysUntilExpiry} day${details.daysUntilExpiry === 1 ? '' : 's'}`,
      html: creditExpiryNoticeEmailHtml(details),
    })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Credit expiry notice email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: `${details.remainingUnits} BuilderHunt credits expire in ${details.daysUntilExpiry} day${details.daysUntilExpiry === 1 ? '' : 's'}`,
        html: creditExpiryNoticeEmailHtml(details),
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

/** A reminder that a subscription is about to renew (billed) — sent once, 7 days ahead. */
export async function sendSubscriptionRenewalReminderEmail(to: string, details: { tier: string; currentPeriodEnd: Date }): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'Your BuilderHunt subscription renews soon', html: subscriptionRenewalReminderEmailHtml(details) })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Subscription renewal reminder email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: 'Your BuilderHunt subscription renews soon',
        html: subscriptionRenewalReminderEmailHtml(details),
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

/** A subscription has been payment-blocked (grace period exhausted without recovery) — distinct from `sendBillingPaymentFailedEmail` (the FIRST failure, which starts grace); this is the harder "access is at risk now" message. */
export async function sendActionRequiredEmail(to: string): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'Action required: your BuilderHunt subscription is on hold', html: actionRequiredEmailHtml() })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Action-required (payment-blocked) email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: 'Action required: your BuilderHunt subscription is on hold',
        html: actionRequiredEmailHtml(),
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

/** A refund request has been decided (succeeded or failed) — one email per refund, never per retry. */
export async function sendRefundDecisionEmail(to: string, details: { amountCents: number; state: string }): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({
      to,
      subject: details.state === 'succeeded' ? 'Your BuilderHunt refund was processed' : 'Your BuilderHunt refund could not be processed',
      html: refundDecisionEmailHtml(details),
    })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Refund decision email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: details.state === 'succeeded' ? 'Your BuilderHunt refund was processed' : 'Your BuilderHunt refund could not be processed',
        html: refundDecisionEmailHtml(details),
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

/** A chargeback was opened against a payment — one email per dispute (plans/stripe-billing-platform/tasks.md §8 task 5, §10). */
export async function sendDisputeNotificationEmail(to: string, details: { amountCents: number; evidenceDueBy: Date | null }): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject: 'A dispute was opened on a BuilderHunt payment', html: disputeNotificationEmailHtml(details) })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Dispute notification email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: 'A dispute was opened on a BuilderHunt payment',
        html: disputeNotificationEmailHtml(details),
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

/** Platform-operator alert for a non-clean daily reconciliation run — sent once per run id, to the current seller profile's support email (there is no separate operator-alert recipient list yet). */
export async function sendReconciliationAlertEmail(to: string, details: { result: string; mismatchCount: number; windowEnd: string }): Promise<SendResult> {
  if (isE2EOutboxActive()) {
    return dispatchEmail({
      to,
      subject: `Billing reconciliation: ${details.result} (${details.mismatchCount} mismatch${details.mismatchCount === 1 ? '' : 'es'})`,
      html: reconciliationAlertEmailHtml(details),
    })
  }
  if (!env.RESEND_API_KEY) {
    console.log('\n📧 [DEV] Reconciliation alert email would be sent to:', to, '\n')
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
        from: 'BuilderHunt <noreply@builderhunt.dev>',
        to,
        subject: `Billing reconciliation: ${details.result} (${details.mismatchCount} mismatch${details.mismatchCount === 1 ? '' : 'es'})`,
        html: reconciliationAlertEmailHtml(details),
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

function creditExpiryNoticeEmailHtml(details: { remainingUnits: number; daysUntilExpiry: number }): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">${details.remainingUnits} credits expiring soon</h1>
    <p>You have <strong>${details.remainingUnits} BuilderHunt credits</strong> that expire in
      <strong>${details.daysUntilExpiry} day${details.daysUntilExpiry === 1 ? '' : 's'}</strong>. Unused credits are
      not refunded or extended once they expire.</p>
    <p style="margin:1.5rem 0;">
      <a href="${SITE_URL}/settings/billing" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Use your credits</a>
    </p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function subscriptionRenewalReminderEmailHtml(details: { tier: string; currentPeriodEnd: Date }): string {
  const date = details.currentPeriodEnd.toISOString().slice(0, 10)
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Your ${details.tier} plan renews on ${date}</h1>
    <p>Your BuilderHunt subscription will renew automatically on <strong>${date}</strong> using your saved payment
      method. No action is needed unless you want to make a change.</p>
    <p style="margin:1.5rem 0;">
      <a href="${SITE_URL}/settings/billing" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Review your plan</a>
    </p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function actionRequiredEmailHtml(): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Your subscription is on hold</h1>
    <p>We still haven't been able to charge your saved payment method after your grace period ended. Your
      BuilderHunt subscription access is now paused. Update your payment method to restore it.</p>
    <p style="margin:1.5rem 0;">
      <a href="${SITE_URL}/settings/billing" style="display:inline-block;padding:0.7rem 1.2rem;background:#6366f1;color:white;border-radius:6px;text-decoration:none;font-weight:600;">Update payment method</a>
    </p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function refundDecisionEmailHtml(details: { amountCents: number; state: string }): string {
  const amount = `$${(details.amountCents / 100).toFixed(2)}`
  const body = details.state === 'succeeded'
    ? `Your refund of <strong>${amount}</strong> has been processed and should appear on your original payment method within a few business days.`
    : `We were unable to process your refund of <strong>${amount}</strong>. Our team has been notified and will follow up.`
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">${details.state === 'succeeded' ? 'Refund processed' : 'Refund failed'}</h1>
    <p>${body}</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function disputeNotificationEmailHtml(details: { amountCents: number; evidenceDueBy: Date | null }): string {
  const amount = `$${(details.amountCents / 100).toFixed(2)}`
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">A dispute was opened</h1>
    <p>A chargeback of <strong>${amount}</strong> was opened against a BuilderHunt payment. The related credits
      have been frozen pending the outcome.${details.evidenceDueBy ? ` Evidence is due by <strong>${details.evidenceDueBy.toISOString().slice(0, 10)}</strong>.` : ''}</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function reconciliationAlertEmailHtml(details: { result: string; mismatchCount: number; windowEnd: string }): string {
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">Reconciliation: ${details.result}</h1>
    <p>The daily billing reconciliation run completed at <strong>${details.windowEnd}</strong> with
      <strong>${details.mismatchCount}</strong> mismatch${details.mismatchCount === 1 ? '' : 'es'}. Review
      <code>billing_reconciliation_runs</code> and the operations dashboard for detail.</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

// ── Calendar event notifications (plan: calendar-scheduling-interview-intelligence, Phase 3) ──

export type CalendarEmailKind = 'reminder' | 'invitation' | 'reschedule' | 'cancellation'

export interface CalendarEventEmailDetails {
  kind: CalendarEmailKind
  title: string
  startsAt: Date
  endsAt: Date
  timezone: string
  location?: string | null
  meetingUrl?: string | null
  /** RFC 5545 body. Attached so the recipient's own calendar applies the update, not just reads about it. */
  icsContent: string
}

/**
 * Sends a calendar notification with its ICS payload attached.
 *
 * The attachment is the point: a REQUEST or CANCEL carrying a stable UID and an increasing
 * SEQUENCE is what makes a real calendar client update the existing entry in place rather than
 * creating a duplicate. The HTML body is a courtesy for clients that ignore the attachment.
 *
 * The MIME type is spelled `text/calendar; method=...` because Outlook decides between "update
 * this event" and "here is a file" from that parameter alone.
 */
export async function sendCalendarEventEmail(to: string, details: CalendarEventEmailDetails): Promise<SendResult> {
  const subject = calendarEmailSubject(details)
  const html = calendarEventEmailHtml(details)
  const method = details.kind === 'cancellation' ? 'CANCEL' : 'REQUEST'
  const filename = details.kind === 'cancellation' ? 'cancel.ics' : 'invite.ics'

  if (isE2EOutboxActive()) {
    return dispatchEmail({ to, subject, html, scenario: `calendar:${details.kind}` })
  }
  if (!env.RESEND_API_KEY) {
    console.log(`\n📧 [DEV] Calendar ${details.kind} email would be sent to:`, to, '—', subject, '\n')
    return { ok: true }
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
        subject,
        html,
        attachments: [{
          filename,
          content: Buffer.from(details.icsContent, 'utf8').toString('base64'),
          content_type: `text/calendar; charset=utf-8; method=${method}`,
        }],
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

function calendarEmailSubject(details: CalendarEventEmailDetails): string {
  switch (details.kind) {
    case 'invitation': return `Invitation: ${details.title}`
    case 'reschedule': return `Rescheduled: ${details.title}`
    case 'cancellation': return `Cancelled: ${details.title}`
    case 'reminder': return `Reminder: ${details.title}`
  }
}

/** Formatted in the EVENT's timezone, not the server's — a reminder showing the wrong hour is worse than none. */
function formatEventWindow(details: CalendarEventEmailDetails): string {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: details.timezone, timeZoneName: 'short',
  })
  const endFormatter = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: details.timezone,
  })
  return `${formatter.format(details.startsAt)} – ${endFormatter.format(details.endsAt)}`
}

function calendarEventEmailHtml(details: CalendarEventEmailDetails): string {
  const heading = calendarEmailSubject(details)
  const cancelled = details.kind === 'cancellation'
  const whereRow = details.meetingUrl
    ? `<p style="margin:0.25rem 0;"><strong>Join:</strong> <a href="${escapeHtml(details.meetingUrl)}">${escapeHtml(details.meetingUrl)}</a></p>`
    : details.location
      ? `<p style="margin:0.25rem 0;"><strong>Where:</strong> ${escapeHtml(details.location)}</p>`
      : ''
  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:560px;margin:2rem auto;padding:0 1rem;color:#1f2937;line-height:1.5;">
    <h1 style="font-size:1.4rem;margin-bottom:0.5rem;">${escapeHtml(heading)}</h1>
    <div style="border-left:3px solid ${cancelled ? '#ef4444' : '#6366f1'};padding-left:1rem;margin:1.25rem 0;">
      <p style="margin:0.25rem 0;font-weight:600;${cancelled ? 'text-decoration:line-through;color:#6b7280;' : ''}">${escapeHtml(details.title)}</p>
      <p style="margin:0.25rem 0;">${escapeHtml(formatEventWindow(details))}</p>
      ${cancelled ? '' : whereRow}
    </div>
    <p style="color:#6b7280;font-size:0.85rem;">${cancelled
      ? 'This event has been cancelled. The attached file removes it from your calendar.'
      : 'The attached calendar file adds or updates this event in your calendar.'}</p>
    <p style="color:#9ca3af;font-size:0.8rem;">BuilderHunt — find active developers across the open web.</p>
  </body>
</html>`
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
