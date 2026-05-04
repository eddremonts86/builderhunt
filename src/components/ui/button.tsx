import * as React from 'react'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'ghost' | 'outline'
  size?: 'sm' | 'md' | 'lg'
  asChild?: boolean
}

export function Button({
  variant = 'default',
  size = 'md',
  className = '',
  children,
  ...props
}: ButtonProps) {
  const base = variant === 'ghost' ? 'btn-ghost' : 'btn-primary'
  const sizeClass = size === 'sm' ? 'text-sm px-3 py-1.5' : size === 'lg' ? 'text-lg px-6 py-3' : ''
  return (
    <button className={`${base} ${sizeClass} ${className}`} {...props}>
      {children}
    </button>
  )
}