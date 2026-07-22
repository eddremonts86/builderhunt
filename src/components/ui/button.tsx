import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '~/shared/lib/utils'

// Variant classes point at the existing .btn-* CSS (globals.css) rather than
// reimplementing gradient/border/shadow tokens here — those are already
// theme- and accent-aware (light/dark, brand/neon), so this stays a thin,
// swappable cva wrapper instead of a second source of truth for button look.
const buttonVariants = cva('', {
  variants: {
    variant: {
      primary: 'btn-primary',
      secondary: 'btn-secondary',
      ghost: 'btn-ghost',
      danger: 'btn-danger',
      'danger-outline': 'btn-danger-outline',
    },
    size: {
      sm: 'btn-sm',
      md: '',
      lg: 'btn-lg',
    },
  },
  defaultVariants: { variant: 'primary', size: 'md' },
})

interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

export function Button({
  variant,
  size,
  asChild = false,
  loading = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <>
          <span className="spinner" aria-hidden="true" />
          <span>{children}</span>
          <span className="sr-only">Loading</span>
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

export { buttonVariants }
