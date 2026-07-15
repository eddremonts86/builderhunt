import * as React from 'react'
import { HeadContent, Scripts } from '@tanstack/react-router'

export function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning className="bg-app min-h-screen">
        <a href="#main-content" className="skip-link">Skip to main content</a>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

export function RootErrorBoundary({ error }: { error: Error }) {
  return (
    <RootDocument>
      <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center bg-app text-bh-text">
        <h1 className="text-4xl font-bold mb-2">Something went wrong</h1>
        <p className="text-bh-text-muted mb-6 max-w-md">
          {error?.message ?? 'An unknown error occurred while loading this page.'}
        </p>
        <a href="/" className="btn-primary">Back to home</a>
      </div>
    </RootDocument>
  )
}
