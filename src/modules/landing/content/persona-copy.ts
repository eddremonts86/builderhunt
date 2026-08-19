/**
 * The home page's three persona-varied text blocks (plan: phase-2/08-homing-page-content-and-sections).
 *
 * ## Four personas, and they are not new
 *
 * `hiring`, `investing`, `building` and `other` are `USER_SEGMENTS` from `user-segments.ts` — the same
 * four the onboarding goal step writes and the dashboard presets read. A fifth here would be a
 * taxonomy nothing else in the product honours.
 *
 * ## `hiring` is the shipped page, word for word
 *
 * Not a coincidence and not a default chosen for convenience: the switch has to be invisible until
 * somebody asks for it, so a visitor arriving with no `?persona=` must see exactly what shipped.
 * Every string in the `hiring` column was copied out of `HomePage.tsx`, and
 * `persona-copy.test.ts` re-reads that file to prove it still matches.
 *
 * ## Three blocks, and no more
 *
 * The hero sub-paragraph, the use-cases headline and the closing CTA headline. The paragraph beneath
 * the CTA is deliberately absent: `ACCESS_ALLOWLIST_ENABLED` gates sign-up behind an approval queue,
 * so any wording promising immediate access is false whenever that flag is on — and it is on, in
 * production. `trust-claims.test.ts` matches the raw component source, which makes that a build-time
 * constraint rather than a preference.
 */
import { parseUserSegment, USER_SEGMENTS, type UserSegment } from '~/shared/lib/user-segments'

export interface PersonaCopy {
  /** The sentence under the hero headline. */
  heroSubheading: string
  /** The headline above the persona tabs. */
  useCasesHeading: string
  /** The closing call to action's headline. */
  closingHeading: string
}

export const PERSONA_COPY: Record<UserSegment, PersonaCopy> = {
  hiring: {
    heroSubheading: 'Activity scored for recency, so the top of your results are the people shipping right now.',
    useCasesHeading: 'Whoever you need to find, we surface them first.',
    closingHeading: 'Start hunting the right builders.',
  },
  investing: {
    heroSubheading: 'Activity scored for recency, so you see what is being built while it is still being built.',
    useCasesHeading: 'Whatever you are watching for, we surface it first.',
    closingHeading: 'Start watching the right builders.',
  },
  building: {
    heroSubheading: 'Activity scored for recency, so the work you shipped this week is the work people find.',
    useCasesHeading: 'Whoever is looking for work like yours, we surface you first.',
    closingHeading: 'Start with the profile we already built.',
  },
  /**
   * Deliberately identical to `hiring`.
   *
   * It is what the rest of the product does with `other` — `resolveSegmentPreset` maps it to the
   * general experience — and copy written for somebody who declined to say is copy addressed to
   * nobody.
   */
  other: {
    heroSubheading: 'Activity scored for recency, so the top of your results are the people shipping right now.',
    useCasesHeading: 'Whoever you need to find, we surface them first.',
    closingHeading: 'Start hunting the right builders.',
  },
}

/** The default. Anything unrecognised lands here, so a hand-edited URL is indistinguishable from none. */
export const DEFAULT_PERSONA: UserSegment = 'hiring'

/**
 * Narrows a `?persona=` value, or returns the default.
 *
 * Total, like `parseSegmentHint`: the URL is attacker-controlled, and an unrecognised value must be
 * indistinguishable from an absent one or the parameter becomes a way to probe the enum.
 */
export function personaFromSearch(raw: unknown): UserSegment {
  return parseUserSegment(raw) ?? DEFAULT_PERSONA
}

export function copyForPersona(raw: unknown): PersonaCopy {
  return PERSONA_COPY[personaFromSearch(raw)]
}

export { USER_SEGMENTS }
