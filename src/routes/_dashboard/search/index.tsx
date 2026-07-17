import { createFileRoute } from '@tanstack/react-router'
import { SearchPage } from '~/modules/search/components/SearchPage'
import { z } from 'zod'

const SearchSchema = z.object({
  q: z.string().optional().default(''),
})

export const Route = createFileRoute('/_dashboard/search/')({
  validateSearch: SearchSchema,
  component: SearchPage,
})
