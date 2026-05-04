import { createFileRoute } from '@tanstack/react-router'
import { HomePage } from '~/modules/landing/components/HomePage'

export const Route = createFileRoute('/_landing/')({
  component: HomePage,
})