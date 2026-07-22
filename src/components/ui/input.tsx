import * as React from 'react'
import { cn } from '~/shared/lib/utils'

export function Input({ className, ...props }: React.ComponentProps<'input'>) {
  return <input data-slot="input" className={cn('input-field', className)} {...props} />
}

export function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return <textarea data-slot="textarea" className={cn('input-field resize-y min-h-[100px]', className)} {...props} />
}
