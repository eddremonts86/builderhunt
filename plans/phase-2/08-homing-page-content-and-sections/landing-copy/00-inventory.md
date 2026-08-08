# Inventory — Home page claims and evidence

Every claim the home page is allowed to make, mapped to ground truth.

## Currently shipping (no "Coming soon" badge)

| Claim | Evidence | Plan |
|---|---|---|
| 12 sources indexed live | `src/lib/sources/index.ts` (12 adapters: github, hn, devto, reddit, lobsters, stackoverflow, npm, huggingface, gitlab, codeberg, hashnode, sourcehut) | `phase-1/22-semantic-search` complete |
| Semantic search | `src/routes/api/search/semantic.ts`, `src/lib/semantic/` | `phase-1/22-semantic-search` complete |
| Recency-weighted scoring | `src/lib/score.ts` | `phase-1/21-ai-expansion` complete |
| Keyword alerts | `src/routes/api/alerts/*`, `src/lib/alerts/worker.ts` | `phase-1/34-smart-alerts` partially-implemented (v1 ships; v2 deferred) |
| Private notes per builder | `src/shared/lib/repositories/organization-builders.ts` `listOrganizationBuilderNotes` | `phase-1/01-security-and-multitenancy` partially-implemented (table exists) |
| CSV / JSON export | `src/routes/api/export/builders.ts`, `src/modules/dashboard/components/ExportsPage.tsx` | `phase-1/01-security-and-multitenancy` partially-implemented |
| Personal workspace | `src/shared/lib/auth/personal-organization.ts`, every signup gets one | `phase-1/01-security-and-multitenancy` partially-implemented |
| Team workspaces | `src/routes/api/organizations/*`, `/settings/team`, `OrganizationSwitcher` | `phase-1/27-team-accounts` implemented |
| AI sourcing sprints | `src/lib/sprints/`, `sourcing_sprints`/`sprint_results` | `phase-1/41-ai-sourcing-sprints` implemented |
| Outreach copilot | `src/modules/builder-profile/components/OutreachCopilot.tsx` | `phase-1/26-outreach-generator` complete |
| AI profile enrichment | `src/routes/api/builders/$builderId/enrichment.ts` (claim-gated) | `phase-1/24-ai-profile-enrichment` partially-implemented |
| Public profile pages | `published_builder_profiles`, `builder_claims` | `phase-1/36-claimable-profiles` partially-implemented |
| RSS feeds per saved search | `src/routes/api/feeds/$searchId.xml` | `phase-1/35-rss-feeds` partially-implemented |
| Stripe billing (code ships, off by default) | `src/shared/lib/billing/` (~60 modules), `STRIPE_BILLING_ENABLED=false` | `phase-1/30-stripe-billing-platform` partially-implemented (~29/40 sections) |
| Status page | `src/routes/_landing/status.tsx` | `phase-1/47-status-and-trust` implemented |
| Changelog | `/changelog` (file-based posts) | `phase-1/46-content-marketing` partially-implemented |
| Roadmap (public) | `/roadmap` with votes | `phase-1/46-content-marketing` partially-implemented |
| Multi-tenant security | RLS on every tenant table, non-owner roles, `requireTenantPrincipal` | `phase-1/01-security-and-multitenancy` partially-implemented (17/19) |
| AI CV generation | `phase-4/ai-cv-generation-and-tailoring` pending | NOT shipped |
| AI delegation | `phase-4/delegated-job-applications` pending | NOT shipped |
| Hiring pipeline kanban | `phase-4/hiring-pipeline-kanban` pending | NOT shipped |
| Why-this-match evidence panel | `phase-4/match-evidence-panel` pending | NOT shipped |
| Look-alike sourcing | `phase-4/look-alike-sourcing` pending | NOT shipped |
| Availability signals | `phase-4/availability-signals` pending | NOT shipped |
| Saved search health | `phase-4/saved-search-health` pending | NOT shipped |
| Solutions intelligence | `phase-1/43-solutions-intelligence` in progress (authorized 2026-08-01) | NOT shipped |
| Collaboration graph | `phase-4/collaboration-graph` pending | NOT shipped |
| ATS integrations | `phase-4/ats-integrations` pending | NOT shipped |
| Browser extension | `phase-4/browser-extension-overlay` pending | NOT shipped |
| Talent market intelligence | `phase-4/talent-market-intelligence` pending | NOT shipped |
| Job opportunities workspace | `phase-4/job-opportunities-workspace` pending | NOT shipped |
| JD-to-candidates matching | `phase-4/jd-to-candidates-matching` pending | NOT shipped |

## Claims to remove or rewrite

- "13 sources" in the existing Sources strip → replace with "12 sources + semantic search".
  The actual live count is 12 (see `src/lib/sources/index.ts`); `app-reality.md` confirms 12.
  The "+1" semantic search is a search method, not a source, and earns its own line.
- "Track GitHub stars, Hacker News comments, and Reddit velocity from one clean dashboard."
  in the existing footer paragraph → keep but add "...plus alerts, notes, and team
  shortlists". The current copy under-sells what the dashboard actually has.
- Persona tab labels are generic ("Open-source maintainers", "Founders sourcing hires",
  "Recruiters & talent partners", "DevRel & community teams"). Phase-2 `06-landing-segmentada`
  is the right owner of persona routes; this plan only adds the `?persona=` switch.
