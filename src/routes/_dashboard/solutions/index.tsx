import { createFileRoute } from '@tanstack/react-router'
import { SolutionsPage } from '~/modules/solutions/components/SolutionsPage'

export const Route = createFileRoute('/_dashboard/solutions/')({
  component: SolutionsPage,
})
