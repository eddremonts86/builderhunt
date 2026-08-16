import * as React from 'react'
import { Link, type LinkProps } from '@tanstack/react-router'

type Variant = 'primary' | 'secondary' | 'ghost'

interface LinkButtonProps extends LinkProps {
  variant?: Variant
  size?: 'sm' | 'md' | 'lg'
  children: React.ReactNode
  className?: string
  /**
   * `LinkProps` describes the router's own props and carries no DOM handlers, so this had to be
   * named to be passed — the spread below has always forwarded it at runtime. Declared because a CTA
   * that reports a conversion event is the ordinary case for a link styled as a button, and the
   * alternative was every caller dropping down to a bare `<Link>` and re-deriving the button classes.
   */
  onClick?: React.MouseEventHandler<HTMLAnchorElement>
}

const VARIANT_CLASS: Record<Variant, string> = {
  primary: 'btn-primary',
  secondary: 'btn-secondary',
  ghost: 'btn-ghost',
}

const SIZE_CLASS = {
  sm: 'btn-sm',
  md: '',
  lg: 'btn-lg',
} as const

export function LinkButton({
  to,
  variant = 'ghost',
  size = 'md',
  children,
  className = '',
  ...props
}: LinkButtonProps) {
  return (
    <Link
      to={to}
      className={`${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
      {...props}
    >
      {children}
    </Link>
  )
}

export { Link as LinkComponent }
