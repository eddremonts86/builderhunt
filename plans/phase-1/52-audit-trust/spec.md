# Trust, Claims, and Profile Removal Audit

> **Status**: `implemented`
> **Depends on**: [`audit-performance-qa`](../49-audit-performance-qa/spec.md), [`pricing-and-billing`](../31-pricing-and-billing/spec.md), [`legal-and-compliance`](../04-legal-and-compliance/spec.md), [`claimable-profiles`](../36-claimable-profiles/spec.md)
> **Blocks**: [`waitlist-launch`](../54-waitlist-launch/spec.md)
> **Reality check**: Pricing, legal pages, consent/export/account-deletion routes, public builder
> profiles, and email-based profile claims already exist. The landing FAQ and root JSON-LD wrongly
> imply users can supply a GitHub PAT, the root publishes an unsupported 4.8/124 aggregate rating,
> the newsletter-looking form has no submit handler, and email ownership alone currently marks any
> builder claim verified. No cross-user de-index suppression exists.

## Problem

Trust is harmed by claims that do not match runtime behavior and by an unsafe identity/removal
model. `GITHUB_TOKEN` is an operator-side server environment variable, but public copy describes a
user-supplied token. `PLAN_LIMITS` enforces 3 free saved searches and 50 saved builders while parts
of the landing page promise unlimited beta use. The public JSON-LD contains an unsubstantiated
rating and some future features. The final “Join Alerts” form collects an email in the browser but
does not submit it anywhere.

Profile privacy cannot be solved with `builders.isDeindexed`: `builders` is a per-user cache and
live federated results in `src/lib/search.ts` can recreate a removed person. Worse, the current
claim flow verifies only that the requester controls the email they entered, not the referenced
public profile.

## Outcome

Make every public trust statement derivable from shipped behavior, publish an accurate security
page, replace unsafe claim verification, and provide a durable verified suppression mechanism
that applies to live search, caches, tracking, and public builder routes across all users.

## Scope and non-goals

In scope: landing/FAQ/JSON-LD/pricing/footer copy, server-token disclosure, claim proof,
profile-removal request/verification, global suppression, audit logging, and privacy-safe metrics.

Out of scope: automatic GDPR account hard deletion (owned by `legal-and-compliance`), a payment
processor, collecting user PATs, scraping private profiles, guaranteeing identity linking across
platforms, or inventing testimonials/ratings. Unsupported sources receive a documented manual
privacy-review path; they are never auto-approved from email ownership alone.

## Trust-source contract

Create `src/shared/lib/product-claims.ts` as the client-safe source for plan limits, supported
sources, export formats, beta/payment wording, and feature availability. It imports
`PLAN_LIMITS`/`PLAN_PRICING` rather than copying numbers. `HomePage.tsx`, `FAQSection.tsx`,
`_landing/pricing.tsx`, `__root.tsx` JSON-LD, and `_landing/security.tsx` consume or test against
this contract. Remove unsupported aggregate ratings, fictional scale/count claims, unactionable
forms, and future features presented as live.

The security page must state: source credentials are optional operator-managed server secrets;
users cannot submit PATs; HTTPS protects transit; secrets are never rendered or logged; public
source data may be cached per user; deletion and removal are different operations; and current
subprocessors match the privacy policy. Do not claim encryption at rest unless runtime evidence
exists.

## Verified ownership and suppression design

### Data shapes

Add forward-only migration tables in `src/shared/lib/db/schema.ts`:

```ts
profileRemovalRequests = {
  id: text PK,
  source: SourceName,
  sourceId: text,
  normalizedProfileUrl: text,
  requesterEmailHash: text | null,
  challengeHash: text,
  status: 'pending' | 'verified' | 'rejected' | 'expired',
  expiresAt: timestamptz,
  verifiedAt: timestamptz | null,
  createdAt: timestamptz,
}

profileSuppressions = {
  id: text PK,
  source: SourceName,
  sourceId: text,
  normalizedProfileUrlHash: text,
  reason: 'verified-removal' | 'legal' | 'abuse',
  createdAt: timestamptz,
  revokedAt: timestamptz | null,
}
```

Enforce unique active suppression by `(source, sourceId)`, index request status/expiry, hash email
and challenge values with server-side keyed HMAC, and never store the plaintext challenge after
response. A suppression retains only the minimum stable identifiers required to prevent
re-indexing; deleting it is an audited admin/legal action, not request expiry.

### Proof and request flow

`POST /api/privacy/profile-removal` accepts a Zod-validated allowlisted profile URL, resolves the
canonical `source/sourceId`, rate-limits by IP plus profile key, returns a one-time challenge, and
instructs the requester to place it temporarily in the source profile bio. It returns the same
202 response for existing/pending/unknown identities to limit enumeration.

`POST /api/privacy/profile-removal/verify` refetches only through
`src/lib/sources/profile-proof.ts`, whose adapters have fixed API hosts, timeouts, response-size
limits, and no redirect to arbitrary hosts. Initially automate only sources with an authenticated
official public profile endpoint and stable bio field; all others show the privacy contact/manual
review path. Comparison is constant-time against the stored challenge hash. A verified transaction
inserts the suppression, marks the request verified, and deletes every `builders` row matching
`source/sourceId`; dependent rows follow declared FK behavior.

The same proof helper replaces email-only verification in the claim flow. Until that ships,
`PROFILE_CLAIMS_ENABLED=false` hides the claim CTA and prevents new “verified” badges. Email may
confirm contact after source ownership proof, but is not ownership evidence by itself.

### Enforcement surfaces

`src/shared/lib/profile-suppression.ts` filters by `(source, sourceId)` after every memory/Redis
cache read and before every cache write. Fresh federated results, `/api/builders/track`, public
`GET /api/builders/$builderId`, recent/recommendation endpoints, exports, feeds, and alert workers
must all refuse suppressed profiles. Verification explicitly evicts affected search cache keys or
increments a suppression-version namespace; dynamic filtering remains the correctness backstop.

Public `/privacy/remove` explains claim, correction, account deletion, and profile suppression as
distinct actions. Successful verification promises removal from BuilderHunt surfaces, not deletion
from upstream public platforms.

## AI, security, and privacy policy

This plan introduces no model call. Public copy must not claim AI enrichment, semantic search, or
provider privacy until the corresponding plan is implemented. When `ai-expansion` ships, the
security/privacy pages must disclose MiniMax for server-side processing, distinguish local Chrome
AI, and link task-level data handling; no private note, auth data, email, removal challenge, or
suppression record may be sent to either tier. Trust E2E runs with `AI_DISABLED=true`.

Tokens use 256 bits of entropy, expire after 30 minutes, are single-use, never appear in logs, and
are redacted from telemetry. Request payloads are capped, URLs are normalized before lookup,
external fetches are SSRF-safe, and all state changes emit structured events without email,
challenge, bio, or full profile URL. `PROFILE_REMOVAL_HMAC_KEY` is a dedicated required 32-byte
secret whenever `PROFILE_REMOVAL_ENABLED=true`; it must not reuse `BETTER_AUTH_SECRET`. Rotation
accepts current and previous key IDs until pending requests expire, while suppressions remain
matchable through their plaintext stable `source/sourceId` key.

## Acceptance criteria

- Every visible price, limit, source count, export format, credential statement, rating, and
  availability claim matches code or is removed; contract tests prevent drift.
- A random email cannot claim or suppress a profile. Supported-source proof succeeds once, expires,
  and rejects wrong-profile/replay/redirect/oversized responses.
- Within five minutes of verified removal, `(source, sourceId)` is absent from fresh and cached
  search, tracking, public profile, recent/recommendations, exports, feeds, and alert candidates.
- Removal never deletes another user account, notes unrelated to the suppressed identity, or the
  upstream profile; the retained suppression record contains no plaintext email/challenge.
- `/security`, `/privacy/remove`, footer links, privacy copy, and JSON-LD pass browser tests at
  mobile and desktop sizes with no unsupported statement.

## Success measures

- Zero verified claims based solely on requester-entered email after rollout.
- 100% of automated removals have valid source proof and cross-surface suppression tests.
- p95 verification-to-suppression latency ≤5 minutes; request API p95 ≤300 ms excluding the
  bounded upstream proof fetch; proof fetch timeout ≤5 seconds.
- Removal request telemetry records counts/status/source only and passes a quarterly sample audit
  for absence of plaintext identifiers.
