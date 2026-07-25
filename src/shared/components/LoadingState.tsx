import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '~/shared/lib/utils'

interface LoadingStateProps {
  /** Message shown next to the spinner. Defaults to "Loading…". */
  message?: React.ReactNode
  className?: string
  testId?: string
}

/**
 * Small inline spinner + message, for a section/card that's mid-fetch.
 * Not a full-page skeleton — call sites with a bespoke skeleton shape
 * (e.g. SearchPage's SearchSkeleton) should keep their own markup.
 */
export function LoadingState({ message = 'Loading…', className, testId }: LoadingStateProps) {
  return (
    <div
      className={cn('flex items-center gap-2 text-sm text-bh-text-muted', className)}
      role="status"
      aria-live="polite"
      data-testid={testId}
    >
      <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
      {message}
    </div>
  )
}
