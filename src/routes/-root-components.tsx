import * as React from 'react'
import { HeadContent, Scripts } from '@tanstack/react-router'

export function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

export function RootErrorBoundary({ error }: { error: Error }) {
  return (
    <RootDocument>
      <div className="flex flex-col items-center justify-center h-screen bg-bh-bg text-white">
        <h1 className="text-2xl font-bold mb-2">Something went wrong</h1>
        <p className="text-bh-text-muted mb-6">{error?.message ?? 'Unknown error'}</p>
      </div>
    </RootDocument>
  )
}