# Claimable Builder Profiles — Delivery Plan

> **Status**: `partially-implemented`
> **Depends on**: nothing
> **Blocks**: [`portfolio-builder`](../37-portfolio-builder/spec.md)
> **Reality check**: `src/shared/lib/db/schema.ts`, `src/routes/api/builders/$builderId/claim.ts`, `src/routes/api/builders/claim/verify.ts`, `src/routes/builders/$builderId.tsx`, `src/modules/builder-profile/components/BuilderProfilePage.tsx`, and `src/routes/_dashboard/me/index.tsx` deliver a working but row-scoped email claim flow. The email is requester-supplied and therefore cannot justify the current verified badge.

## Delivery sequence

### Phase 0 — Preserve and characterize the shipped baseline

Add route-level tests around the current claim, public profile, and owner-edit behavior
before changing persistence. Record the legacy security behavior as a failing regression
case: an arbitrary mailbox must not be able to verify an unrelated identity.

### Phase 1 — Canonical claim migration

Create `builder_claims`, extend claim requests, and backfill non-conflicting legacy state by
`(source, sourceId)`. Invalidate plaintext outstanding tokens. Keep builder claim columns as
compatibility mirrors for one release, but move all reads to the canonical join. The
migration is forward-only; rollback is application compatibility, not destructive DDL.

### Phase 2 — Source-bound proof library

Implement pure challenge/hash/state-transition helpers and source adapters. Initial source
challenge coverage is GitHub, GitLab, Codeberg, and DEV.to; trusted-source-email is enabled
only per adapter when the upstream response includes an address for the stable source ID.
Unsupported sources remain unclaimable rather than weakly verified.

### Phase 3 — Secure claim routes

Require a session to start and finish claims, switch verification to POST, hash every
secret, apply per-IP/per-user/per-request limits, and perform consume + canonical upsert in
one transaction with row locking. Do not create auth accounts inside verification. Add an
admin revocation endpoint with reason and audit logging.

### Phase 4 — Public DTO and owner surfaces

Replace full-row public serialization with a zod-validated allowlist. Update public badge,
claim instructions, `/me` queries, and owner PATCH authorization to use active canonical
claims. Preserve current topic/open-to UX. Gate profile-view writes on analytics consent
and expose aggregate counts only.

### Phase 5 — Verification, rollout, and cleanup

Run unit, route, migration, authorization, and browser smoke tests. Deploy behind
`CLAIMABLE_PROFILES_ENABLED`; first disable new legacy claims, migrate/read canonical state,
then enable source-bound claims. Monitor proof failures/conflicts for one release before a
later cleanup migration removes compatibility columns.

## Risks

| Risk                                         | Impact | Mitigation                                                                         |
| -------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| Legacy arbitrary-email claims are fraudulent | High   | Do not auto-backfill conflicts; require reverification before portfolio publishing |
| Duplicate per-user rows disagree             | High   | Canonical unique `(source, sourceId)` claim plus conflict report                   |
| Upstream profile APIs change or rate-limit   | Medium | Adapter contract, timeout, typed unavailable state, per-request attempt cap        |
| Concurrent verification transfers ownership  | High   | Transaction, row lock, active-claim uniqueness, replay tests                       |
| Public API leaks per-user metadata           | High   | Explicit select + zod DTO snapshot tests                                           |
| Migration rollback loses claims              | High   | Additive schema, dual-write compatibility window, no down migration in production  |

## Rollout and rollback

1. Ship schema and canonical reads with claims disabled.
2. Backfill only unambiguous verified groups; export conflict counts, never claim emails.
3. Enable source-challenge starts for supported sources, then trusted-source-email adapters.
4. Roll back by setting `CLAIMABLE_PROFILES_ENABLED=false` and reverting reads to legacy
   columns during the compatibility window. Leave additive tables/data in place.
5. Admin revocation is recoverable: it timestamps the claim; it never deletes evidence.

## Exit criteria

- All checked baseline tasks remain green.
- Every unchecked task in `tasks.md` is complete with runtime evidence.
- An arbitrary email cannot create a verified claim.
- Duplicate rows share canonical state; public responses contain no private fields.
- Owner, unrelated user, anonymous, and admin boundaries pass for every affected route.
