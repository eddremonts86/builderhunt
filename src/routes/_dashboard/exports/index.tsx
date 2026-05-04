import { createFileRoute } from '@tanstack/react-router'
import { ExportsPage } from '~/modules/dashboard/components/ExportsPage'

export const Route = createFileRoute('/_dashboard/exports/')({
  component: ExportsPage,
})