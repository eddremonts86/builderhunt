# Specification: Trust & Security Enhancements

## Problem

The BuilderHunt landing page suffers from major trust and clarity gaps that can prevent users from registering or providing credentials:
1. **Contradictory pricing & limits**: Promising free beta access while confusing users about what features (saved searches, team lists, exports) will stay free or become paid.
2. **Missing Token Security Context**: Asking developers to input a GitHub Personal Access Token (PAT) without explaining why it is safe, where it is stored, how it is encrypted, or how to revoke it.
3. **Implicit profile cross-linking concerns**: Failing to explain how identities from different platforms (GitHub, GitLab, Devpost) are merged, which raises privacy and correctness concerns.
4. **Vague Opt-Out / De-indexing policies**: Not showing a clear path for builders to request removal or corrections of their indexation, exposing the app to GDPR/privacy complaints.
5. **Over-promising marketing copy**: Using hyperbolic claims (e.g. "Resumes lie. Git history doesn't.") that hurt credibility.

## Goal

Design clear components, updated copies, and structured privacy features to establish robust trust:
- Implement a clear pricing comparison table outlining beta and future structures.
- Design an educational security tooltip/modal for the GitHub PAT input area.
- Add an "Opt-Out / Profile Removal" pipeline and request page.
- Reword hyperbolic claims in H1, subheadings, and benefit grids to ensure professional credibility.

## User stories

1. **As a visitor**, I want to read a transparent pricing table so I understand what features are free today and what will be paid post-beta.
2. **As a developer**, before entering my GitHub PAT, I want to click a helper link to read a clear security explanation (permissions needed, local encryption, revocation instructions).
3. **As an indexed developer**, I want to see a footer link letting me claim, correct, or request the immediate removal of my profile from the directory.

## Technical details & copies

### 1. Updated Landing Page Claims
- **Hero H1 Headline**:
  - *Old*: "Resumes lie. Git history doesn't."
  - *New*: "Resumes describe experience. Public work adds verified evidence."
- **Search sub-benefit**:
  - *Old*: "Whoever you need to find, BuilderHunt finds first."
  - *New*: "Build a verified shortlist from recent public activity across 12 platforms."
- **Network claim**:
  - *Old*: "The four places builders actually are."
  - *New*: "Four primary high-signal developer networks."

### 2. Pricing Comparison Table
Add a responsive table component in `src/modules/landing/components/PricingTable.tsx`:

| Feature | Public Beta (Now) | Free Tier (Post-Beta) | Team Plan (Paid Future) |
| :--- | :---: | :---: | :---: |
| Search Queries | Unlimited | 50 / month | Unlimited |
| Saved Searches | Unlimited | Max 5 | Unlimited |
| Activity Alerts | Unlimited | 1 active (daily) | Unlimited (hourly/daily) |
| Profile Exports | Unlimited | Locked | PDF, CSV, JSON |
| Team Collaboration | Shared lists | View-only | Full write & share |

### 3. GitHub PAT Security Modal
Add an info drawer/modal `src/modules/landing/components/TokenSecurityModal.tsx`:
- **Scope required**: Recommend a "Fine-grained Token" with read-only access to public repositories.
- **Storage details**: Token is never saved on BuilderHunt servers. It is encrypted in transit and stored locally inside the user's browser localStorage / session cookie, meaning it never leaves their device unless fetching live APIs.
- **Revocation**: Instructions on how to revoke the token inside GitHub Settings -> Developer settings.

### 4. Profile Opt-Out / Removal Pipeline
- Add a route `src/routes/privacy/remove.tsx` containing a simple form:
  - Input: Verified Email address or profile URL.
  - Verification: Sends a confirmation token (similar to builderClaimRequests) to verify ownership.
  - Action: Sets `builders.isClaimed = false` or flags the profile as `deindexed` in the database to prevent re-indexation during search crawls.

## Success metrics

- **Conversion Rate**: PAT submission rates increase by 25% upon displaying the security modal link.
- **Legal Compliance**: 100% of GDPR/privacy removal requests are processed automatically through the new verified opt-out route.
