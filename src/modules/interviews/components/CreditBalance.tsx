import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Zap } from 'lucide-react'
import { LinkComponent } from '~/components/ui'
import { resolveLowBalanceWarnings, type LowBalanceWarningLevel } from '~/modules/interviews/billing'

/**
 * Credit state inside the interview UI (plan: calendar-scheduling-interview-intelligence, Phase 7
 * "Show platform-owned credit state in interview UX").
 *
 * ## Reads the platform's summary; owns none of it
 *
 * Everything here comes from `GET /api/billing/summary`, which is already role-minimized: an
 * owner/admin receives `OrganizationBillingSummaryDto`, a plain member receives only
 * `BillingAvailabilityDto`. This component renders whichever it was given and **never** derives a
 * balance, an expiry, or an entitlement of its own — a second opinion about how many credits an
 * organization has is worse than no opinion, because it will be believed while being wrong.
 *
 * There are no payment mutations. The owner gets *links* to the billing settings that already exist;
 * duplicating the pack picker or the auto-recharge form inside an interview page would mean two places
 * to keep correct and two places to get a refund policy wrong.
 *
 * ## Warnings are announced once, not continuously
 *
 * A live session updates consumption every few seconds. An `aria-live` region that re-announced the
 * same "90% used" on every tick would make a screen reader unusable for exactly the person who most
 * needs to hear it once. So the announcement is keyed on the *set* of active warning levels and only
 * re-announced when that set changes.
 */

export interface CreditBalanceSummary {
  tier: string
  status: string
  grace: { gracePeriodEndsAt: string | null; paymentBlockedAt: string | null }
  activeCreditGrants: ReadonlyArray<{ id: string; source: string; remainingUnits: number; expiresAt: string }>
  capabilities: {
    paidActionsAllowed: boolean
    canOpenPortal: boolean
    canConfigureAutoRecharge: boolean
  }
}

/** What a plain member receives — no financial detail at all. */
export interface CreditBalanceAvailability {
  capabilities: { paidActionsAllowed: boolean }
}

export interface CreditBalanceProps {
  /** `null` while loading, and after a failed load — see `stale`. */
  summary: CreditBalanceSummary | CreditBalanceAvailability | null
  /**
   * True when the summary on screen is known to be out of date (a refetch failed). Rendered as an
   * explicit caveat rather than by hiding the numbers: a stale balance is still the best information
   * available, and blanking it mid-interview reads as "you have no credits".
   */
  stale?: boolean
  /** Live-session consumption, when one is running. Drives the 80/90/ten-minute/zero warnings. */
  liveSession?: { reservedUnits: number; consumedUnits: number } | null
}

/**
 * Which warning to say out loud when several apply at once.
 *
 * They frequently do: a 100-unit reservation at 90% consumed has exactly ten minutes left, so both
 * thresholds fire on the same tick. Ranked explicitly rather than taking the last element of
 * `resolveLowBalanceWarnings`, which happens to be ordered most-severe-last today and would silently
 * change meaning the moment someone reordered that function's pushes.
 */
const WARNING_SEVERITY: Readonly<Record<LowBalanceWarningLevel, number>> = {
  eighty_percent: 1,
  ninety_percent: 2,
  ten_minutes_remaining: 3,
}

const WARNING_COPY: Readonly<Record<LowBalanceWarningLevel, string>> = {
  eighty_percent: 'You have used 80% of the credits reserved for this interview.',
  ninety_percent: 'You have used 90% of the credits reserved for this interview.',
  ten_minutes_remaining: 'About ten minutes of transcription remain on this interview.',
}

function isFullSummary(
  summary: CreditBalanceSummary | CreditBalanceAvailability,
): summary is CreditBalanceSummary {
  return 'activeCreditGrants' in summary
}

export function CreditBalance({ summary, stale = false, liveSession = null }: CreditBalanceProps) {
  const warnings = useMemo(() => {
    if (!liveSession || liveSession.reservedUnits <= 0) return []
    return resolveLowBalanceWarnings(liveSession)
  }, [liveSession])

  const exhausted = liveSession !== null && liveSession.reservedUnits > 0
    && liveSession.consumedUnits >= liveSession.reservedUnits

  const mostSevere = warnings.length === 0
    ? null
    : warnings.reduce((worst, warning) =>
      WARNING_SEVERITY[warning.level] > WARNING_SEVERITY[worst.level] ? warning : worst)

  // The announced message, recomputed only when the *set* of levels changes.
  const levelKey = warnings.map((warning) => warning.level).join(',') + (exhausted ? '|zero' : '')
  const [announcement, setAnnouncement] = useState('')
  const lastKey = useRef('')
  useEffect(() => {
    if (levelKey === lastKey.current) return
    lastKey.current = levelKey
    if (levelKey === '') {
      setAnnouncement('')
      return
    }
    setAnnouncement(exhausted || mostSevere === null
      ? 'The credits reserved for this interview are used up. Transcription has stopped; your notes and controls still work.'
      : WARNING_COPY[mostSevere.level])
  }, [levelKey, exhausted, mostSevere])

  if (summary === null) {
    return <p className="text-muted-foreground text-xs">Loading credit balance…</p>
  }

  const remainingUnits = isFullSummary(summary)
    ? summary.activeCreditGrants.reduce((total, grant) => total + grant.remainingUnits, 0)
    : null

  return (
    <section aria-labelledby="credit-balance-heading" className="space-y-2 rounded-md border p-3 text-sm">
      <h3 id="credit-balance-heading" className="flex items-center gap-2 text-sm font-medium">
        <Zap aria-hidden className="size-4" />
        AI interview credits
      </h3>

      {/*
        One polite live region for the whole component. `aria-live` on each warning would announce
        three at once when a session crosses all three thresholds in the same tick.
      */}
      <p aria-live="polite" className="sr-only">{announcement}</p>

      {remainingUnits === null ? (
        // A plain member. They can see whether paid features work, and nothing about the money.
        <p className="text-muted-foreground text-xs">
          {summary.capabilities.paidActionsAllowed
            ? 'AI interview features are available on this organization’s plan.'
            : 'AI interview features are not available on this organization’s plan. Ask an owner to review the billing settings.'}
        </p>
      ) : (
        <>
          <p>
            <span className="font-medium">{remainingUnits}</span>
            {' credits remaining'}
          </p>
          {stale && (
            // Shown, not hidden. Blanking a balance mid-interview reads as "you have none".
            <p className="text-muted-foreground text-xs">
              This balance may be out of date — we could not refresh it just now.
            </p>
          )}
        </>
      )}

      {isFullSummary(summary) && !summary.capabilities.paidActionsAllowed && (
        <p role="alert" className="text-destructive flex items-start gap-1 text-xs">
          <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
          {summary.grace.paymentBlockedAt !== null
            ? 'Paid AI features are paused while a payment problem is resolved.'
            : 'Paid AI features are not available on the current plan.'}
        </p>
      )}

      {/* Visible copy of the warnings. The live region above is for announcement only. */}
      {(mostSevere !== null || exhausted) && (
        <p className="text-xs">
          {exhausted || mostSevere === null
            ? 'The credits reserved for this interview are used up. Transcription has stopped — your notes and interview controls still work.'
            : WARNING_COPY[mostSevere.level]}
        </p>
      )}

      {isFullSummary(summary) && (summary.capabilities.canOpenPortal || summary.capabilities.canConfigureAutoRecharge) && (
        <nav aria-label="Billing settings" className="flex flex-wrap gap-3 text-xs">
          {/*
            Links only. The pack picker, the portal and the auto-recharge form all already exist in
            billing settings; a second copy here is a second place to get a refund policy wrong.
          */}
          {summary.capabilities.canOpenPortal && (
            <LinkComponent to="/settings/billing" className="underline">Billing settings</LinkComponent>
          )}
          {summary.capabilities.canConfigureAutoRecharge && (
            <LinkComponent to="/settings/billing" className="underline">Buy credits or set up auto-recharge</LinkComponent>
          )}
        </nav>
      )}
    </section>
  )
}
