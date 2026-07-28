import { CURRENT_CONSENT_VERSIONS } from './legal-versions'

/**
 * The versions of the documents a candidate consents to (spec.md §"Consent, privacy, and
 * retention": "The server records the rendered notice version").
 *
 * These are constants in one module rather than strings typed into a page, because a consent receipt
 * is only meaningful if the version it records is the version the candidate actually read. If the
 * portal renders `v1` from a JSX literal and the server stores `v2` from somewhere else, every
 * receipt in the ledger is evidence of nothing.
 *
 * **Changing a version here invalidates existing consent for that notice.** That is the intended
 * behaviour: `verifyRequiredConsents` will not accept a receipt issued against a different version,
 * so candidates are re-prompted rather than silently held to text they never saw. Bump these only
 * when the text materially changes, and never retroactively.
 */

/**
 * The candidate-facing processing notice shown in the booking portal. Distinct from the general
 * privacy policy: it covers the four booking purposes, the transient-audio statement, and the
 * no-training statement, which the site-wide policy states in less specific terms.
 */
export const CANDIDATE_NOTICE_VERSION = '2026-07-28'

/**
 * The site-wide privacy policy, rendered at `/legal/privacy`.
 *
 * **Derived, not restated.** This was a second literal `'v1.1'` sitting beside `legal.ts`'s own
 * `privacy: 'v1.1'`, with nothing tying them together — and a consent receipt is only evidence if the
 * version it records is the version the reader saw. Bumping one and forgetting the other would leave every
 * receipt pointing at text that was never rendered, and nothing in the suite would have noticed.
 */
export const PRIVACY_POLICY_VERSION = CURRENT_CONSENT_VERSIONS.privacy
