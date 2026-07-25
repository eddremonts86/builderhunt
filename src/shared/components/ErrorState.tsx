import * as React from 'react'
import { AlertCircle, type LucideIcon } from 'lucide-react'
import { cn } from '~/shared/lib/utils'
import { Button } from '~/components/ui/button'

interface ErrorStateProps {
  /** Main error message. */
  message: React.ReactNode
  /** Optional bold heading above the message (e.g. "Search failed"). */
  title?: string
  /** Defaults to AlertCircle; pass `false` to omit the icon entirely. */
  icon?: LucideIcon | false
  /** When provided, renders a "Try again" button that calls this. */
  onRetry?: () => void
  retryLabel?: string
  className?: string
  testId?: string
}

/**
 * Danger-toned inline error banner — message plus an optional retry action.
 * Matches the `card border-bh-danger/30 bg-bh-danger/5 ... text-bh-danger`
 * shape repeated across billing/search/profile modules.
 */
export function ErrorState({
  message,
  title,
  icon: Icon = AlertCircle,
  onRetry,
  retryLabel = 'Try again',
  className,
  testId,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'card border-bh-danger/30 bg-bh-danger/5 p-4 text-sm text-bh-danger flex items-start gap-2',
        className,
      )}
      data-testid={testId}
    >
      {Icon !== false && <Icon className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />}
      <div className="flex-1 min-w-0">
        {title && <p className="font-semibold mb-1">{title}</p>}
        <p>{message}</p>
        {onRetry && (
          <Button onClick={onRetry} variant="secondary" size="sm" className="mt-3">
            {retryLabel}
          </Button>
        )}
      </div>
    </div>
  )
}
