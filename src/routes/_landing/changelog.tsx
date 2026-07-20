import * as React from 'react'
import { Outlet, createFileRoute } from '@tanstack/react-router'

// Layout for /changelog and /changelog/$slug.
// The actual list/detail UIs are in /changelog/index.tsx and /changelog/$slug.tsx.
export const Route = createFileRoute('/_landing/changelog')({
  component: () => <Outlet />,
})
