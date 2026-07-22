import { createFileRoute, Outlet } from '@tanstack/react-router'
import { ThemeProvider } from '~/shared/lib/theme/ThemeProvider'

export const Route = createFileRoute('/auth')({
  component: () => (
    <ThemeProvider>
      <Outlet />
    </ThemeProvider>
  ),
})