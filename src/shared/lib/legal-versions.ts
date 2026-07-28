/**
 * The one place a consent-document version is written down.
 *
 * Extracted from `legal.ts` so `consent-notice.ts` can derive `PRIVACY_POLICY_VERSION` from it instead of
 * restating the string. Two literals for the same fact is how a consent receipt ends up pointing at text
 * nobody rendered — and `legal.ts` reaches the account repositories, so a candidate-facing module cannot
 * import it without dragging the database layer into places it does not belong.
 */

export const CURRENT_CONSENT_VERSIONS = {
  /**
   * v1.1 (2026-07-28): section 11, "Interview features". New obligations on the customer — they are the
   * controller of candidate data, they need their own lawful basis, they must not transcribe without the
   * candidate having agreed in the portal, and they must not present AI output as a decision.
   *
   * **Minor, and the reasoning is not symmetry with the privacy bump.** The privacy policy went to v2.0
   * because it added categories of personal data about a *third party* — a candidate's CV, their recorded
   * words — and nobody may be held to text about their own data that they never saw, so the major bump
   * forces a fresh prompt. This change adds terms binding the *contracting customer*, whom section 12
   * already notifies of changes and whose continued use constitutes acceptance. A major bump here would
   * put every existing organization behind a blocking modal for a change they are contractually notified
   * of, which is disproportionate.
   *
   * It is still a bump: the page prints this string next to the text, and leaving it at v1.0 while the
   * text gained a section means the version no longer identifies what a reader accepted. That is the same
   * defect the privacy version had, at a smaller scale.
   *
   * This split — minor for terms, major for privacy — is a legal judgement, not a technical one, and it is
   * recorded as an open item for review in `docs/compliance/interview-ai-act-classification.md`.
   */
  tos: 'v1.1',
  /**
   * v1.1 (2026-07-25): added the "Device recognition data" disclosure (abuse-and-usage-integrity Phase 6) —
   * a clarification of processing already covered by section 2(c)'s existing "prevent abuse" purpose, not a
   * new category, so a minor bump: existing acceptances of v1.0 remain valid.
   *
   * v2.0 (2026-07-28): interview intelligence. Candidate documents, approved public-web import, transient
   * live audio, stored transcripts, and sensitive AI processing of all four.
   *
   * **The major part, not the minor.** `isMaterialVersionChange` compares only the major, so a v1.2 would
   * have let every existing v1.x acceptance carry — holding people to text about their CV and their recorded
   * words that they never saw. New categories of personal data need fresh consent, and this is the one
   * mechanism that forces the re-prompt. A first draft of this change used v1.2 and its own comment claimed
   * acceptances would not carry; they would have.
   */
  privacy: 'v2.0',
  cookies: 'v1.0',
} as const

export type ConsentDocument = keyof typeof CURRENT_CONSENT_VERSIONS
