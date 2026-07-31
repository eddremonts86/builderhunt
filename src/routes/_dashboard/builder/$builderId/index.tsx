import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { BuilderProfilePage } from '~/modules/builder-profile/components/BuilderProfilePage'

// `from` is re-validated against the safe-origin allowlist on read (safe-next.ts's
// `resolveSafeBuilderFrom`) — this schema only shapes it as an optional string.
const BuilderWorkspaceSearchSchema = z.object({
  from: z.string().optional(),
})

export const Route = createFileRoute('/_dashboard/builder/$builderId/')({
  validateSearch: BuilderWorkspaceSearchSchema,
  component: BuilderProfilePage,
})