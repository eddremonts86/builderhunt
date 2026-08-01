import { createFileRoute } from '@tanstack/react-router'
import { SearchPage } from '~/modules/search/components/SearchPage'
import { z } from 'zod'

const SearchSchema = z.object({
  q: z.string().optional().default(''),
  mode: z.enum(['keyword', 'semantic']).optional().default('keyword'),
  /** Comma-separated `SourceName`s — a deep link (e.g. from Admin Integrations) that pre-selects
   * just that source instead of the default pill set. Invalid/unknown names are dropped silently. */
  sources: z.string().optional(),
})

export const Route = createFileRoute('/_dashboard/search/')({
  validateSearch: SearchSchema,
  component: SearchPage,
})
