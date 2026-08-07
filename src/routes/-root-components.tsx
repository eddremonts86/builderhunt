import * as React from 'react'
import { HeadContent, Scripts } from '@tanstack/react-router'
import { CookieBanner } from '~/shared/components/CookieBanner'
import { HydrationSignal } from '~/shared/components/HydrationSignal'
import { TosModal } from '~/shared/components/TosModal'

export function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning className="bg-app min-h-screen">
        <a href="#main-content" className="skip-link">Skip to main content</a>
        {/* The one universal skip-link target for the whole app — routed
            layouts (landing, dashboard, onboarding) must not declare their
            own `id="main-content"`; this is the sole owner so activating the
            skip link always moves focus here, regardless of which layout is
            mounted. */}
        <div id="main-content" tabIndex={-1} className="outline-none">
          {children}
        </div>
        <CookieBanner />
        <TosModal />
        <HydrationSignal />
        <Scripts />
      </body>
    </html>
  )
}

export function RootErrorBoundary({ error }: { error: Error }) {
  // The router supplies `shellComponent: RootDocument` for every render, including
  // the error branch. Wrapping the error UI in another `RootDocument` here would
  // nest a second `<html><body>…` inside the outer shell's `<div id="main-content">`,
  // which React rejects as "div cannot be a child of <html>" — and which React 19
  // logs as a hydration warning on every page in the app (saas-review F1+F3).
  // Render the inner error markup directly; the shell stays the router's job.
  return (
    <div className="flex min-h-screen flex-col items-center justify-center p-8 text-center bg-app text-bh-text">
      <h1 className="text-4xl font-bold mb-2">Something went wrong</h1>
      <p className="text-bh-text-muted mb-6 max-w-md">
        {error?.message ?? 'An unknown error occurred while loading this page.'}
      </p>
      <a href="/" className="btn-primary">Back to home</a>
    </div>
  )
}
