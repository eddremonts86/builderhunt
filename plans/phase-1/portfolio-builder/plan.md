# Verified Portfolio Builder — Delivery Plan

> **Status**: `pending`
> **Depends on**: [`claimable-profiles`](../claimable-profiles/spec.md) (canonical, source-verified claims)
> **Blocks**: nothing
> **Reality check**: Portfolio code does not exist. Reuse the public builder presentation in `src/modules/builder-profile/components/BuilderProfilePage.tsx` and the existing claimed-owner screen in `src/routes/_dashboard/me/index.tsx`; do not assume `builders.username` or a builder row is globally unique. AI enrichment and unified timeline are optional adapters, not delivery blockers.

## Delivery sequence

### Phase 1 — Pure contract and namespace

Define settings/public DTO schemas, safe defaults, namespace-preserving JSONB updates,
deterministic representative-row selection, and project normalization. Test malformed and
future-version metadata before adding routes.

### Phase 2 — Owner draft API

Add verified-owner draft read/write endpoints using canonical claim authorization. Return
allowlisted project candidates and optional-integration capabilities. Saving creates or
updates only `builder_claims.metadata.portfolio` and never publishes implicitly.

### Phase 3 — Explicit publication state machine

Add idempotent publish/unpublish endpoints, audit events, response-cache invalidation, and
claim-revocation behavior. First publication requires explicit confirmation and current
source verification. Deploy initially with `PORTFOLIOS_ENABLED=false`.

### Phase 4 — Public DTO, route, and SEO

Build the public API and SSR route at `/portfolio/$claimId`. Select only public columns,
return 404 for private/revoked state, add canonical/OG metadata, and include published
portfolio URLs in sitemap output. Keep unpublished previews owner-authenticated and
`noindex`.

### Phase 5 — Owner settings and public layout

Embed `PortfolioSettings` into existing `/me`, with preview, explicit project selection,
section toggles, theme, publish/unpublish, and copy-link. Build accessible responsive public
sections with independent empty/error states.

### Phase 6 — Optional integrations

Add adapters only when their plans are implemented. Persona reads a pre-existing validated
artifact and never triggers MiniMax from a public view. Timeline remains non-AI by default;
its optional summary preserves Chrome local-first behavior and the authenticated MiniMax
fallback defined by the timeline plan. Either adapter can be removed without affecting core
publishing.

### Phase 7 — Runtime and rollout

Run domain, authorization, API, browser, accessibility, SEO, build, lint, and type checks.
Enable for internal verified claims, then a small owner cohort, then all verified owners.
Monitor public 404/5xx, publish transitions, invalid metadata, and cache purge failures.

## Risks

| Risk                                              | Impact | Mitigation                                                                  |
| ------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| Per-user duplicate rows publish inconsistent data | High   | Canonical claim owns settings; deterministic representative selection       |
| Draft/private data leaks publicly                 | High   | Fail-closed public schema, explicit selects, snapshot and auth matrix tests |
| Save accidentally publishes                       | High   | Separate PATCH and POST state transitions; default unpublished              |
| Revoked profile remains cached                    | High   | Purge on revoke/publish/unpublish; short TTL; runtime revocation test       |
| Optional AI/timeline delays core page             | Medium | Independent lazy slots; never trigger enrichment on public view             |
| Selected upstream project disappears              | Low    | Omit safely and retain stable selection ID in private draft                 |

## Rollout and rollback

- `PORTFOLIOS_ENABLED=false` makes public routes 404 and hides settings without deleting
  drafts.
- Roll out after canonical claim migration and reverification of legacy claims.
- Roll back UI/routes with the flag; `metadata.portfolio` remains namespaced and inert.
- Unpublish is the owner-level rollback; claim revocation is the trust-level rollback.
- Optional integrations roll back independently by disabling their section adapters.

## Exit criteria

- Core portfolio works with AI enrichment and timeline absent.
- Anonymous/public, owner, unrelated user, revoked owner, and admin boundaries pass.
- Public DTO snapshots contain only allowlisted fields and selected projects.
- Publish/unpublish/revoke invalidates cache and changes runtime visibility immediately.
- Lighthouse and full repository verification commands in `tasks.md` pass.
