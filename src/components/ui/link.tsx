import * as React from 'react'
import { Link, type LinkProps } from '@tanstack/react-router'

export function LinkComponent({
  to,
  children,
  className = '',
  ...props
}: LinkProps & { className?: string }) {
  return (
    <Link to={to} className={`btn-ghost text-sm ${className}`} {...props}>
      {children}
    </Link>
  )
}

interface LinkButtonProps extends LinkProps {
  variant?: 'default' | 'ghost'
  children: React.ReactNode
  className?: string
}

export function LinkButton({
  to,
  variant = 'ghost',
  children,
  className = '',
  ...props
}: LinkButtonProps) {
  return (
    <Link
      to={to}
      className={variant === 'default' ? `btn-primary text-sm ${className}` : `btn-ghost text-sm ${className}`}
      {...props}
    >
      {children}
    </Link>
  )
}