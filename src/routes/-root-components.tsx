import * as React from 'react'
import { HeadContent, Scripts } from '@tanstack/react-router'
import { MotionConfig } from 'motion/react'
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
          {/*
            One place where `prefers-reduced-motion` is honoured, because the
            per-component way of honouring it did not work and could not.

            `Bento.tsx` used to branch on `useReducedMotion()` to drop its entrance
            variants. That hook snapshots a module global with `useState` and never
            updates it, and on the server that global is its default `false` — so the
            server rendered the `hidden` keyframe inline (`opacity: 0`,
            `translateY(12px)`) and the client, now told to reduce motion, dropped the
            very variants that would have animated it to `opacity: 1`. Nothing was left
            to clear the inline style.

            Measured, not inferred: nine dashboard widgets — the action queue, all three
            headline tiles, activity, sprints, recommendations, alerts and source mix —
            sat at `opacity: 0` twenty seconds after the page reported ready, for any
            viewer with the preference set. Respecting a motion preference by hiding the
            content is the most expensive way to respect it, and
            `tests/e2e/dashboard-entrance.spec.ts` now fails if it comes back.

            `reducedMotion="user"` is read when an animation runs rather than when a
            component mounts, so it is immune to that first-render problem, and it
            applies to every `motion` element in the app instead of the two that
            remembered to ask. It disables transform and layout animations — the ones
            that actually cause motion sickness — while letting opacity settle at its
            resting value, which is what makes the content appear at all.
          */}
          <MotionConfig reducedMotion="user">
            {children}
          </MotionConfig>
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
