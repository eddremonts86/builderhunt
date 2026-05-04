import { createFileRoute } from '@tanstack/react-router'
import { BuilderProfilePage } from '~/modules/builder-profile/components/BuilderProfilePage'

export const Route = createFileRoute('/_dashboard/builder/$builderId/')({
  component: BuilderProfilePage,
})