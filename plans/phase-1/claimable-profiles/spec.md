# Claimable Builder Profiles — Specification

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`portfolio-builder`](../portfolio-builder/spec.md)
> **Reality check**: Claim columns and request/view tables exist in `src/shared/lib/db/schema.ts` and `drizzle/0000_tranquil_hemingway.sql`; public profile, claim, verification, email, and owner-edit surfaces exist in `src/routes/builders/$builderId.tsx`, `src/routes/api/builders/`, `src/shared/lib/email.ts`, and `src/routes/_dashboard/me/index.tsx`. The current email flow accepts an arbitrary address and then sets `isVerified = true`, so it proves mailbox access but not ownership of the indexed source identity. `builders` is also a per-user cache, so one external identity may have several rows with inconsistent claim state.

## Problem

Builders can discover, claim, and edit a tracked profile today, but the trust boundary is
not sound. `POST /api/builders/$builderId/claim` sends a link to the address supplied by the
requester; `GET /api/builders/claim/verify` then marks the row verified. Nothing binds that
address to `builders.source` and `builders.sourceId`. In addition, claim state is stored on
one per-user cache row rather than on the external identity shared by duplicate rows.

Public reads currently return the complete builder row. A production claim surface needs a
public DTO, auditable proof, transactional one-time verification, revocation, and tests.

## Goal

Deliver a trustworthy two-sided profile surface in which:

- a claim belongs to the canonical external identity `(source, sourceId)`, not to one
  hunter's cached row;
- `verified` means BuilderHunt checked proof controlled by that source identity;
- a verified owner can curate public topics and availability without mutating scraped data;
- anonymous readers receive only an explicit public-field allowlist;
- duplicate `builders` rows resolve to the same active claim;
- operators can revoke a disputed claim without deleting tracked builder data.

## Non-goals

- Endorsements, messaging, team ownership, a public directory, or reputation scoring.
- Treating verification as an assessment of ability or seniority.
- Editing source-owned bio/avatar fields in v1.
- Fabricated “saved by” or search-keyword analytics. Only measured aggregates may ship.
- Portfolio publishing; that is owned by [`portfolio-builder`](../portfolio-builder/spec.md).

## Delivered scope

- Claim-related builder columns, `builder_claim_requests`, and `builder_profile_views` exist.
- `/builders/$builderId` renders publicly with SEO metadata and a claim CTA.
- Claim request rate limiting, Resend delivery with a development fallback, expiring
  one-time links, account creation/reuse, verified badge rendering, and the `/me` editor
  exist.
- `PATCH /api/me/builder/$builderId` validates topics/availability and enforces
  `claimedByUserId` ownership.

These are useful foundations, but they do not satisfy the identity, privacy, atomicity, or
test gates below.

## Canonical data model

Add `builder_claims` as the source of truth:

```ts
builderClaims = {
  id: string,
  source: string,
  sourceId: string,
  claimedByUserId: string,
  verificationMethod: 'source-challenge' | 'trusted-source-email',
  verifiedAt: Date,
  revokedAt: Date | null,
  revokedReason: string | null,
  metadata: {
    claim?: { schemaVersion: 1, lastReverifiedAt: string },
    portfolio?: unknown // owned exclusively by portfolio-builder
  },
  createdAt: Date,
  updatedAt: Date
}
```

Constraints: unique `(source, sourceId)` among all rows; indexes on
`claimedByUserId` and `(source, sourceId)`; an active claim has `revokedAt = null`.
`builders.isClaimed`, `claimedByUserId`, `isVerified`, and timestamps remain temporary
compatibility mirrors until all readers use `builder_claims`. Backfill groups duplicate
rows by `(source, sourceId)` and refuses conflicting verified owners for manual review.

Extend `builder_claim_requests` with `requesterUserId`, `method`, `tokenHash`,
`challengeHash`, `attemptCount`, and `supersededAt`. New secrets are stored only as SHA-256
hashes. Existing plaintext `token` values are invalidated during migration, not copied.

## Verification policy

Claim initiation requires an authenticated account. The server reads `source`, `sourceId`,
and `username` from the builder row; the client cannot choose the identity being verified.

1. Prefer a **source challenge**: generate `builderhunt-verify-<random>`, return it once,
   and ask the requester to place it temporarily in the canonical public source profile.
   The server adapter fetches that profile directly and confirms both stable source ID and
   challenge. Initial adapters: GitHub, GitLab, Codeberg, and DEV.to. Unsupported sources
   show an honest unavailable state.
2. `trusted-source-email` is allowed only when the source API itself exposes an email for
   that exact stable source ID. Compare normalized addresses server-side, send the link to
   the source-provided address, and return the same generic response for match/mismatch.
3. Email ownership alone never sets `verified` unless step 2 bound it to source data.
4. Verification locks the request row, consumes it, and upserts the canonical claim in one
   DB transaction. Concurrent requests cannot transfer an active claim.
5. Limits: 5 starts/IP/day, 5 starts/user/day, 10 proof checks/request, 24-hour expiry;
   superseding a request invalidates earlier requests for the same canonical identity.

## API and authorization

- `GET /api/builders/$builderId`: public, returns `PublicBuilderProfileSchema` only. It
  joins active canonical claim state by `(source, sourceId)` and never returns `userId`,
  `claimedByUserId`, raw `metadata`, emails, notes, or claim-request data.
- `POST /api/builders/$builderId/claim`: authenticated; creates a proof request and returns
  the challenge once or a generic email-delivery acknowledgement.
- `POST /api/builders/claim/verify`: authenticated; verifies source-bound proof and returns
  a typed result. State-changing verification must not use GET.
- `GET /api/me/builder` and `PATCH /api/me/builder/$builderId`: active verified owner only;
  an admin may inspect/revoke through a separate admin route but cannot silently edit the
  owner's public fields.
- `POST /api/admin/builder-claims/$claimId/revoke`: admin only, requires a reason and emits
  an audit log.

Authorization tests cover anonymous, unrelated authenticated user, verified owner, and
admin for every route.

## Public fields and privacy

The public DTO may contain: id, source, sourceId, username, displayName, avatarUrl, bio,
profileUrl, follower count, language, country, scraped topics, claimed topics, open-to
status, last-seen timestamp, and boolean/dated verification state. Claimed owner IDs,
request emails, tokens/challenges, per-user row ownership, raw metadata, notes, and viewer
identity are private.

Profile views are recorded only after the product's analytics consent policy permits it.
Anonymous views contain no IP or fingerprint. Owner analytics are aggregates with a
minimum cohort threshold; raw viewer IDs are never exposed. A revoked claim hides
owner-curated fields until ownership is re-established.

## UX

- Public profile: verified badge explains “source identity verified”, claimed topics and
  availability are clearly builder-curated, and unsupported claim methods explain the
  limitation without promising email verification.
- `/me`: lists all canonical claims for the session user, supports topic/availability
  editing, links to the public profile, and shows verification age/reverification state.
- Claim flow: sign in → receive source-specific proof instructions → verify → manage. No
  account with an unknown password is created as a side effect of an anonymous GET.
- Disputed/revoked profiles retain scraped public data but lose badge and owner controls.

## Success and release gates

- 100% of newly verified claims have source-bound proof and an audit trail.
- Duplicate builder rows resolve to one canonical owner in integration tests.
- No private column appears in the public DTO snapshot.
- Replay, expiry, concurrent verification, ownership, and revocation tests pass.
- Claim start-to-verified conversion and verification failures are observable by method;
  emails and proof secrets are never logged.
- Runtime smoke: complete one source-challenge claim, edit topics, view the public page
  anonymously, then revoke it and confirm the badge/owner fields disappear.

## Resolved edge cases

- Conflicting legacy owners: migration records the group for admin review and creates no
  canonical active claim.
- Deleted/renamed source account: stable source-ID mismatch fails verification without
  consuming the request.
- Existing active claim: return conflict; only admin revocation/dispute can transfer it.
- Builder row deleted during verification: canonical identity can still be checked, but
  verification fails unless at least one current builder row references it.
- Existing account: attach the claim to the authenticated user; never create a duplicate.
