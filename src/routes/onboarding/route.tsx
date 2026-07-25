import { createFileRoute, Outlet } from '@tanstack/react-router'
import { ThemeProvider } from '~/shared/lib/theme/ThemeProvider'

/**
 * Layout for every /onboarding/* step. These pages already use the bh-*
 * token classes throughout (no hardcoded colors), so the only thing missing
 * for dark theme was a ThemeProvider actually mounted here — without it,
 * `.dark` never reaches `<html>` on this route tree the way it does inside
 * `_dashboard` (see DashboardLayout/ThemeProvider).
 */
export const Route = createFileRoute('/onboarding')({
  component: OnboardingLayout,
})

function OnboardingLayout() {
  return (
    <ThemeProvider>
      <div className="min-h-screen bg-app">
        <Outlet />
      </div>
    </ThemeProvider>
  )
}
