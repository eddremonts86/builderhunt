import { createFileRoute } from '@tanstack/react-router'
import { SearchPage } from '~/modules/search/components/SearchPage'

export const Route = createFileRoute('/_dashboard/search/')({
  component: SearchPage,
})