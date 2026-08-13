import { AlertTriangle } from 'lucide-react'

import { Button } from '~/components/ui/button'

interface ErrorRowProps {
  message: string
  onRetry?: () => void
}

/**
 * An inline error that keeps the loaded rows visible.
 *
 * Replacing the table with a full-page error throws away rows the user was reading and a scroll
 * position they may not be able to recover — and for a paged table the failure is usually the
 * *next* page, not the ones already on screen. So it renders below them, as a row.
 *
 * `role="alert"` because it appears without the user navigating to it.
 */
export function ErrorRow({ message, onRetry }: ErrorRowProps) {
  return (
    <div
      role="alert"
      data-testid="table-error"
      className="tbl-error-row"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="min-w-0 flex-1 truncate">{message}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry} data-testid="table-error-retry">
          Retry
        </Button>
      )}
    </div>
  )
}
