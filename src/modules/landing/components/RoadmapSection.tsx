import { LandingSection } from '~/modules/landing/components/LandingSection'
import { ROADMAP_SECTION } from '~/modules/landing/content/landing-sections'

/** What is coming. Every item links to its specification, which is the only honest destination. */
export function RoadmapSection() {
  return <LandingSection {...ROADMAP_SECTION} linkPlans />
}
