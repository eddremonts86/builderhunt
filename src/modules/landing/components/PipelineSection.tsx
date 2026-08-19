import { LandingSection } from '~/modules/landing/components/LandingSection'
import { PIPELINE_SECTION } from '~/modules/landing/content/landing-sections'

/** The three shipped surfaces that turn a search into recurring work. */
export function PipelineSection() {
  return <LandingSection {...PIPELINE_SECTION} />
}
