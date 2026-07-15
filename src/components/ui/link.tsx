import * as React from 'react'
import { Link, type LinkProps } from '@tanstack/react-router'

type Variant = 'primary' | 'secondary' | 'ghost'

interface LinkButtonProps extends LinkProps {
  variant?: Variant
  size?: 'sm' | 'md' | 'lg'
  children: React.ReactNode
  className?: string
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
