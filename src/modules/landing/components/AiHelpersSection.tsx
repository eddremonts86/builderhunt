import { LandingSection } from '~/modules/landing/components/LandingSection'
import { AI_HELPERS_SECTION } from '~/modules/landing/content/landing-sections'

/** Where AI shows up, with the one tile that has not shipped badged from its plan path. */
export function AiHelpersSection() {
  return <LandingSection {...AI_HELPERS_SECTION} />
}
