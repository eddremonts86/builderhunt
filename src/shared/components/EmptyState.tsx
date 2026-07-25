import * as React from 'react'
import { type LucideIcon } from 'lucide-react'
import { cn } from '~/shared/lib/utils'

interface EmptyStateProps {
  /** Optional icon rendered inside a rounded box above the title. */
  icon?: LucideIcon
  title: React.ReactNode
  description?: React.ReactNode
  /** Pass a pre-built `<Button>`/`<LinkButton>` (or any node) for the CTA. */
  action?: React.ReactNode
  className?: string
  testId?: string
}

/**
 * Centered "nothing here" card — icon + title + optional description/action.
 * Matches the `card text-center py-12/16` shape repeated across
 * billing/search/profile modules for zero-result and not-found states.
 */
export function EmptyState({ icon: Icon, title, description, action, className, testId }: EmptyStateProps) {
  return (
    <div className={cn('card text-center py-12', className)} data-testid={testId}>
      {Icon && (
        <div className="inline-flex w-12 h-12 rounded-xl bg-bh-surface-2 border border-bh-border items-center justify-center mb-3">
          <Icon className="w-6 h-6 text-bh-text-muted" aria-hidden="true" />
        </div>
      )}
      <p className="font-semibold text-bh-text mb-1">{title}</p>
      {description && (
        <p className="text-sm text-bh-text-muted max-w-sm mx-auto">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
