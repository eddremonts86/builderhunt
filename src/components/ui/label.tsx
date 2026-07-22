import * as React from 'react'
import * as LabelPrimitive from '@radix-ui/react-label'
import { cn } from '~/shared/lib/utils'

export function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'text-xs font-medium text-bh-text-dim select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}
