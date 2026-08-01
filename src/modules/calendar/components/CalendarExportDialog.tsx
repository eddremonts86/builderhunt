import * as React from 'react'
import { Download, Loader2, ShieldAlert } from 'lucide-react'
import { Button, Dialog, Input, Label } from '~/components/ui'

/**
 * Bounded ICS export dialog (plans/UI Wave 3 "Expose bounded ICS export").
 *
 * `/api/calendar/export.ics` already enforces authentication, a required range, and a 400-day
 * span cap server-side (`exportIcsRequestSchema` → `withBoundedRange`) — this dialog mirrors that
 * cap client-side so a doomed request never leaves the browser, and it triggers the actual file
 * save only after a real 200, never optimistically. The exported file is a `.ics` full of event
 * titles, times, and locations, so the warning text is not boilerplate: anyone who opens the
 * downloaded file can read it, unlike the private calendar it came from.
 */

const MAX_RANGE_SPAN_DAYS = 400

export interface CalendarExportDialogProps {
  open: boolean
  onClose: () => void
  /** Defaults the range to what the caller currently has loaded — usually the active view's window. */
  defaultFrom: Date
  defaultTo: Date
  /** Injected in tests; defaults to a real fetch + browser download. */
  requestExport?: (range: { from: string; to: string }) => Promise<{ ok: boolean; status: number; blob?: Blob }>
  /** Injected in tests to observe the triggered download without touching the real DOM/URL APIs. */
  triggerDownload?: (blob: Blob, filename: string) => void
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

async function defaultRequestExport(range: { from: string; to: string }) {
  const params = new URLSearchParams({ from: range.from, to: range.to })
  const response = await fetch(`/api/calendar/export.ics?${params.toString()}`, { credentials: 'include' })
  if (!response.ok) return { ok: false as const, status: response.status }
  return { ok: true as const, status: response.status, blob: await response.blob() }
}

function defaultTriggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function CalendarExportDialog({
  open,
  onClose,
  defaultFrom,
  defaultTo,
  requestExport = defaultRequestExport,
  triggerDownload = defaultTriggerDownload,
}: CalendarExportDialogProps) {
  const [from, setFrom] = React.useState(() => isoDay(defaultFrom))
  const [to, setTo] = React.useState(() => isoDay(defaultTo))
  const [exporting, setExporting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Reset the form to the caller's current range on every closed→open transition — done during
  // render (React's "adjusting state when a prop changes" pattern), not an effect, so there is no
  // extra render between the dialog opening and the fields showing the right dates.
  const [wasOpen, setWasOpen] = React.useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setFrom(isoDay(defaultFrom))
      setTo(isoDay(defaultTo))
      setError(null)
    }
  }

  const spanDays = React.useMemo(() => {
    const fromMs = new Date(`${from}T00:00:00.000Z`).getTime()
    const toMs = new Date(`${to}T00:00:00.000Z`).getTime()
    return Math.round((toMs - fromMs) / (24 * 60 * 60 * 1000))
  }, [from, to])

  async function handleExport(formEvent: React.FormEvent) {
    formEvent.preventDefault()
    setError(null)
    if (spanDays <= 0) {
      setError('The end date must be after the start date.')
      return
    }
    if (spanDays > MAX_RANGE_SPAN_DAYS) {
      setError(`Range too wide — pick ${MAX_RANGE_SPAN_DAYS} days or fewer.`)
      return
    }
    setExporting(true)
    try {
      const result = await requestExport({
        from: new Date(`${from}T00:00:00.000Z`).toISOString(),
        to: new Date(`${to}T00:00:00.000Z`).toISOString(),
      })
      if (!result.ok || !result.blob) {
        setError(result.status === 401
          ? 'Your session expired. Sign in again and retry.'
          : 'We could not export your calendar. Try a narrower range.')
        return
      }
      triggerDownload(result.blob, `builderhunt-${from}-to-${to}.ics`)
      onClose()
    } finally {
      setExporting(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Export calendar">
      <form onSubmit={handleExport} className="space-y-4" data-testid="calendar-export-form">
        <p className="flex items-start gap-2 rounded-md border border-bh-warning/40 bg-bh-warning/10 px-3 py-2 text-xs text-bh-text">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            The downloaded file contains your private event titles, times, and locations in plain
            text. Anyone who opens it can read it — only save it somewhere you trust.
          </span>
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="export-from">From</Label>
            <Input
              id="export-from"
              type="date"
              value={from}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFrom(e.target.value)}
              required
              data-testid="calendar-export-from"
            />
          </div>
          <div>
            <Label htmlFor="export-to">To</Label>
            <Input
              id="export-to"
              type="date"
              value={to}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setTo(e.target.value)}
              required
              data-testid="calendar-export-to"
            />
          </div>
        </div>

        {error && (
          <p className="text-sm text-bh-danger" role="alert" data-testid="calendar-export-error">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={exporting} data-testid="calendar-export-submit">
            {exporting ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : <Download className="mr-2 size-4" aria-hidden />}
            Download .ics
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
