import { readFile } from 'node:fs/promises'

type DataClass = 'global-public' | 'account-subject' | 'tenant-private' | 'system-operational'

interface Classification {
  table: string
  class: DataClass
  ownerKey: string
  publicDtoFields: string[]
  retention: string
  plans: string[]
  tenantRoot?: boolean
  organizationColumn?: boolean
  transitionFinding?: string
}

const classifications: Classification[] = [
  account('auth_users', 'id', ['security-and-multitenancy']),
  account('auth_sessions', 'user_id', ['security-and-multitenancy']),
  account('auth_accounts', 'user_id', ['security-and-multitenancy']),
  account('auth_verifications', 'identifier', ['security-and-multitenancy']),
  tenant('organizations', 'id', ['security-and-multitenancy', 'team-accounts'], { tenantRoot: true }),
  tenant('organization_members', 'organization_id', ['security-and-multitenancy', 'team-accounts']),
  tenant('organization_invitations', 'organization_id', ['security-and-multitenancy', 'team-accounts']),
  tenant('builders', 'organization_id (nullable expand)', ['security-and-multitenancy', 'shared-resources'], { organizationColumn: true, transitionFinding: 'mixed global identity and private tracking remain pending split' }),
  tenant('saved_queries', 'organization_id (nullable expand)', ['security-and-multitenancy', 'shared-resources'], { organizationColumn: true }),
  tenant('alerts', 'organization_id (nullable expand)', ['security-and-multitenancy', 'smart-alerts'], { organizationColumn: true }),
  tenant('alert_triggers', 'organization_id (nullable expand)', ['security-and-multitenancy', 'smart-alerts'], { organizationColumn: true }),
  tenant('builder_notes', 'organization_id (nullable expand)', ['security-and-multitenancy', 'shared-resources'], { organizationColumn: true }),
  account('builder_claim_requests', 'email/source subject', ['claimable-profiles', 'security-and-multitenancy']),
  operational('builder_profile_views', 'builder_id', ['claimable-profiles']),
  tenant('onboarding_progress', 'organization_id (nullable expand)', ['onboarding-flow', 'security-and-multitenancy'], { organizationColumn: true, transitionFinding: 'relationship IDs remain stored in JSON' }),
  global('incidents', ['id', 'title', 'description', 'status', 'severity', 'affected_components', 'started_at', 'identified_at', 'resolved_at'], ['status-and-trust']),
  global('changelog', ['title', 'content', 'slug', 'tags', 'published_at'], ['status-and-trust']),
  global('roadmap_items', ['id', 'title', 'description', 'status', 'ship_estimate', 'category', 'sort_order', 'shipped_at'], ['status-and-trust']),
  account('roadmap_votes', 'user_id', ['status-and-trust']),
  account('user_consents', 'user_id', ['legal-and-compliance']),
  account('data_export_requests', 'user_id', ['legal-and-compliance', 'security-and-multitenancy']),
  account('deletion_requests', 'user_id', ['legal-and-compliance', 'security-and-multitenancy']),
  /*
   * `plans`, `plan_changes` and `plan_requests` were classified here and are gone (2026-08-03), removed from
   * `schema.ts` with the rest of the legacy per-user plan surface. This audit is generated *from* `schema.ts`,
   * so a classification for a table it no longer declares fails the run — which is how this list stays honest
   * in both directions.
   *
   * The tables themselves still exist in the database until the contraction migration drops them. Nothing reads
   * or writes them: all three held zero rows, `plan_changes` never had a writer, and `plan_requests` refused
   * every new request while billing was enabled. Entitlement lives on `organization_entitlements` below.
   */
  tenant('organization_entitlements', 'organization_id', ['security-and-multitenancy', 'pricing-and-billing'], { organizationColumn: true }),
  tenant('organization_plan_changes', 'organization_id', ['security-and-multitenancy', 'pricing-and-billing'], { organizationColumn: true }),
  global('builder_identities', ['id', 'source', 'source_id', 'username', 'display_name', 'avatar_url', 'bio', 'profile_url'], ['security-and-multitenancy', 'shared-resources']),
  operational('builder_source_snapshots', 'builder_identity_id', ['security-and-multitenancy']),
  // Cross-links an account declares about itself. Global-public for the same reason as
  // `builder_identities`: a profile saying "my site is example.com" is a public statement by that account,
  // and no organization owns it. It is the raw material identity resolution runs on.
  global('identity_declared_links', ['builder_identity_id', 'link_kind', 'normalized_value', 'verification_state'], ['solutions-intelligence', 'security-and-multitenancy']),
  // Canonical humans (plan 43 Phase 3). Global-public for the same reason as `builder_identities`:
  // a person and the accounts they hold are public facts, and no organization owns them. The
  // per-organization opinion about that person stays in `organization_builders.private_metadata`.
  // `human_merge_events` is operational — an append-only audit of merges, so an unmerge has
  // something to restore from.
  // Solutions catalog (plan 43 Phase 4). Global-public for the same reason as `builder_identities`:
  // "this model can translate" is a public fact about a public thing, and no organization owns it. The
  // per-organization judgement about whether to use it is not stored here at all. `solution_sources` is
  // operational — it is the ingestion register and kill switch, not content, and its `enabled` column
  // is an operator control rather than anything a reader consumes.
  operational('solution_sources', 'platform operator', ['solutions-intelligence']),
  // The people-search register (migration 0126). Operational for the same reason: it is the ingestion
  // kill switch, not content — nothing reads it to learn about a builder, and its `enabled` column is
  // an operator control.
  operational('search_sources', 'platform operator', ['solutions-intelligence', 'stealth-scraping']),
  global('solution_capabilities', ['key', 'label', 'description'], ['solutions-intelligence']),
  global('solution_components', ['id', 'kind', 'slug', 'display_name', 'lifecycle_state', 'homepage_url'], ['solutions-intelligence']),
  // Derived retrieval index, not content: rebuilt from versions by `pnpm solutions:project` and safe to
  // delete wholesale. Operational rather than global because nothing reads it to learn about a component —
  // it exists so a query can *find* one.
  operational('solution_component_projections', 'platform operator', ['solutions-intelligence']),
  global('solution_component_versions', ['component_id', 'version', 'metadata', 'observed_at', 'valid_from', 'valid_until'], ['solutions-intelligence']),
  global('solution_component_capabilities', ['component_id', 'component_version', 'capability_key', 'evidence_level'], ['solutions-intelligence']),
  global('solution_evidence', ['id', 'source_key', 'component_id', 'kind', 'source_url', 'observed_at', 'expires_at'], ['solutions-intelligence']),
  global('solution_compatibility_edges', ['id', 'version', 'edge_type', 'from_component_id', 'to_component_id', 'status', 'valid_from', 'valid_until'], ['solutions-intelligence']),
  // Saved briefs, runs, and feedback (plan 43 Phase 8). The first tenant-private tables in this module, and the
  // line is the one the rest of the module draws: the catalog is a public fact about a public thing, while what
  // an organization asked for and what it was told belongs to that organization. `solution_runs` and
  // `solution_run_routes` carry no UPDATE grant — a stored recommendation is a record, not a document.
  tenant('solution_briefs', 'organization_id + created_by_user_id', ['solutions-intelligence'], { organizationColumn: true }),
  tenant('solution_runs', 'organization_id (immutable: SELECT/INSERT/DELETE only)', ['solutions-intelligence'], { organizationColumn: true }),
  tenant('solution_run_routes', 'organization_id + run_id (immutable: SELECT/INSERT/DELETE only)', ['solutions-intelligence'], { organizationColumn: true }),
  tenant('solution_run_feedback', 'organization_id + run_id + created_by_user_id', ['solutions-intelligence'], { organizationColumn: true }),
  // The human half of the evaluation corpus (plan 43 Phase 0). System-operational: it is a platform artifact
  // about the product's own quality, owned by whoever curates it, and granted to the platform role only —
  // `builderhunt_app` has no grant, so a tenant request cannot reach the corpus even by mistake.
  operational('solution_gold_briefs', 'platform curator', ['solutions-intelligence']),
  global('canonical_humans', ['id', 'display_name', 'headline', 'country', 'language'], ['solutions-intelligence']),
  global('human_source_links', ['canonical_human_id', 'builder_identity_id', 'link_method', 'review_state', 'valid_from', 'valid_until'], ['solutions-intelligence']),
  operational('human_merge_events', 'target_canonical_human_id', ['solutions-intelligence']),
  tenant('organization_builders', 'organization_id', ['security-and-multitenancy', 'shared-resources'], { organizationColumn: true }),
  account('builder_claims', 'subject_user_id', ['security-and-multitenancy', 'claimable-profiles']),
  global('published_builder_profiles', ['builder_identity_id', 'display_name', 'bio', 'open_to_status', 'topics', 'published_at'], ['security-and-multitenancy', 'claimable-profiles']),
  operational('migration_backfill_runs', 'migration owner', ['security-and-multitenancy']),
  operational('migration_backfill_conflicts', 'migration run', ['security-and-multitenancy']),

  // Shared resources and activity feed (plans 28-shared-resources, 29-activity-feed).
  //
  // `builder_lists`/`builder_list_items` are tenant-private, same composite-FK shape as
  // `organization_builders`: a list item cannot name a builder identity the organization has not
  // tracked. `feed_capabilities` is tenant-private too — `capability_hash` (SHA-256 of the bearer
  // token) is the only secret, never the row id, so listing/expiring a capability does not require
  // handing back anything an attacker could replay. `organization_activity` is the append-only
  // event log the dashboard's Team Activity widget reads.
  tenant('builder_lists', 'organization_id + created_by_user_id', ['shared-resources'], { organizationColumn: true }),
  tenant('builder_list_items', 'organization_id (composite FK to organization_builders); list_id -> builder_lists', ['shared-resources'], { organizationColumn: true }),
  tenant('feed_capabilities', 'organization_id + query_id (capability_hash is the only bearer secret, never the id)', ['shared-resources'], { organizationColumn: true }),
  tenant('organization_activity', 'organization_id + actor_user_id (append-only event log)', ['activity-feed'], { organizationColumn: true }),

  // `dashboard_preferences` is tenant-private and keyed on the (organization, user) pair rather than
  // on either alone: a layout belongs to a person *in a workspace*, which is the whole reason it
  // moved off a browser-wide `localStorage` key. It holds no subject data at all — a density string
  // and a list of widget ids — so its retention is the membership's, and deleting either the
  // organization or the user cascades it away.
  tenant('dashboard_preferences', 'organization_id + user_id (composite primary key)', ['ui-dashboard'], { organizationColumn: true }),

  // Status subscribers (plan 47-status-and-trust, Phase 2). System-operational, no owning subject —
  // same anti-enumeration shape as `feed_capabilities`: the row is keyed by the SHA-256 of a random
  // unsubscribe token, the raw token only ever appears once, in the unsubscribe URL.
  operational('status_subscribers', 'email_lower (unsubscribe_token_hash is the only bearer secret)', ['status-and-trust']),

  // Calendar and scheduling (plans/phase-1/44-calendar-scheduling-interview-intelligence).
  //
  // Classified ahead of the rest of the unclassified set — roughly fifty tables across billing,
  // enrichment, sprints and abuse still have no entry — because these ten already carry RLS and
  // per-role grants (drizzle/0069, 0071, 0078), so what the manifest says about them is checkable
  // today rather than a placeholder for the contract phase.
  //
  // All ten are tenant-private, including the two that read as delivery plumbing. `reminders` is a
  // fire schedule with attempt counters and `notification_deliveries` is a per-recipient send log,
  // which invites `operational()` — but the manifest derives its RLS column from the class, and
  // `system-operational` renders as "not-applicable-or-role-restricted". Both tables have RLS enabled
  // with owner, recipient, worker and capability policies, so calling them operational would make this
  // manifest wrong about the one property a reader consults it for.
  //
  // `ownerKey` records the path a policy actually takes, and `organizationColumn` is set explicitly
  // wherever that text is not the bare column name, since the tenant-private check reads the flag and
  // not the prose.
  tenant('user_calendars', 'organization_id + owner_user_id', ['calendar-scheduling-interview-intelligence'], { organizationColumn: true }),
  tenant('calendar_events', 'organization_id + owner_user_id', ['calendar-scheduling-interview-intelligence'], { organizationColumn: true }),
  tenant('calendar_event_occurrences', 'organization_id (via calendar_events)', ['calendar-scheduling-interview-intelligence'], { organizationColumn: true }),
  // The durable record that one occurrence of a series was removed. Separate from the occurrences
  // table because those rows are a rebuildable cache of a pure expansion, and the worker's upsert
  // overwrites any status written onto them.
  tenant('calendar_event_exceptions', 'organization_id (via calendar_events)', ['calendar-scheduling-interview-intelligence'], { organizationColumn: true }),
  // `event_owner_user_id` is denormalized from calendar_events and held true by a composite FK, so
  // this table's policies read only its own columns — see the schema comment for the policy-recursion
  // reason. Rows may name an external candidate by address rather than by user id.
  tenant('event_participants', 'organization_id (via calendar_events; event_owner_user_id denormalized)', ['calendar-scheduling-interview-intelligence'], { organizationColumn: true }),
  tenant('calendar_event_reminders', 'organization_id (via calendar_events)', ['calendar-scheduling-interview-intelligence'], { organizationColumn: true }),
  // Stores `external_recipient_hash` rather than an external address, so a delivery log for someone
  // who never held an account does not accumulate their email.
  tenant('calendar_notification_deliveries', 'organization_id (via calendar_events; recipient_user_id or external_recipient_hash)', ['calendar-scheduling-interview-intelligence'], { organizationColumn: true }),
  tenant('availability_policies', 'organization_id + owner_user_id', ['calendar-scheduling-interview-intelligence'], { organizationColumn: true }),
  tenant('availability_rules', 'organization_id + owner_user_id', ['calendar-scheduling-interview-intelligence'], { organizationColumn: true }),
  tenant('availability_overrides', 'organization_id + owner_user_id', ['calendar-scheduling-interview-intelligence'], { organizationColumn: true }),
  // Retention is stated rather than defaulted. This row holds `capability_hash` — the only stored
  // trace of the secret that authorizes an unauthenticated public route — and
  // `candidate_email_normalized`, the address of someone who may never hold an account here. Neither
  // has a reason to outlive the invitation. The spec gives `retention_expires_at` to the later
  // content tables (submissions, documents, briefs, transcripts) and deliberately not to this one, and
  // Phase 11 "Privacy, retention, export, and deletion" is what will enforce a window, so this string
  // names the binding constraint instead of implying a purge already runs.
  tenant('scheduling_invitations', 'organization_id + owner_user_id', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'bounded by invitation terminal state (booked/declined/expired/revoked) plus a support window; capability_hash and candidate_email_normalized must not outlive it — enforcement pending the Phase 11 retention worker',
  }),

  // Candidate submissions, documents and briefs (Phase 5, 6 and 8). Added on the same criterion the
  // block above states: these all carry RLS with per-role grants today (0078, 0085, 0086, 0089, 0091),
  // so what this manifest claims about them is checkable rather than a placeholder.
  //
  // Every one of them is tenant-private *and narrower than the tenant*. The capability policies are
  // scoped to a single pinned invitation, not to the organization — 0086 and 0089 closed exactly that
  // gap — and `interview_briefs` is narrower still. `ownerKey` records the path each policy actually
  // takes, since the tenant-private check reads `organizationColumn` and not this prose.
  tenant('candidate_submissions', 'organization_id + invitation owner; capability scoped to app.invitation_id', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'retention_expires_at, 180 days by default (INTERVIEW_DOCUMENT_RETENTION_DAYS); holds email_normalized for someone who may never hold an account — enforcement pending the Phase 11 retention worker',
  }),
  tenant('candidate_links', 'organization_id + invitation owner; capability scoped to app.invitation_id', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'inherits the submission it hangs off by cascade; holds a candidate-supplied URL and a versioned ownership attestation',
  }),
  // `object_key` is the only handle to the bytes and there is deliberately no public-URL column: a URL
  // that exists is a URL that leaks. The file itself lives in MinIO, so a row deletion is not by itself
  // a deletion of the document.
  tenant('candidate_documents', 'organization_id + invitation owner; capability scoped to app.invitation_id (0089)', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'retention_expires_at, 180 days by default; the object in MinIO must be deleted with the row — enforcement pending the Phase 11 retention worker',
  }),
  // Holds extracted CV text: the same personal data as the document, in a form that is trivially
  // searchable. No candidate policy at all — they upload bytes, they do not read what a parser made of
  // them.
  tenant('document_extractions', 'organization_id (via candidate_documents → submission → invitation owner)', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'retention_expires_at, inherited from the document it parsed',
  }),
  // Stores `robots_result` and both the requested and final URL rather than inferring them later:
  // "we were allowed to fetch this" must stay auditable after the site's robots.txt changes. The raw
  // response body is deliberately not stored.
  tenant('candidate_web_imports', 'organization_id (via candidate_links → submission → invitation owner)', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'retention_expires_at, 180 days by default; holds extracted visible text from a third-party site',
  }),
  // The narrowest policy in the schema (0091): owner, or a colleague *explicitly granted* access to that
  // interview. No organization-admin path and no capability grant — an admin manages seats without
  // reading a colleague's evaluation of a candidate, and a candidate's route to what was written about
  // them is a GDPR access request, not an endpoint.
  tenant('interview_briefs', 'organization_id + owner_user_id, or event_participants.access_granted = true', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'retention_expires_at; an assessment of a named person, and it stores no model prompt or response envelope',
  }),
  // Append-only by privilege, not by convention: 0075 gives the app role no DELETE and only permits
  // writing `withdrawn_at` on UPDATE, so a withdrawal supersedes rather than erases. That is what makes
  // the ledger evidence — a consent record that can be deleted proves nothing about what was agreed.
  tenant('privacy_consents', 'organization_id + invitation owner (via scheduling_invitations)', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'INTERVIEW_CONSENT_RETENTION_MONTHS, 24 by default and deliberately longer than the documents it authorizes: the record of what was agreed must outlive the processing it permitted',
  }),

  // Live interview (Phase 9, 0092/0093). The most sensitive rows in the product: what a named candidate
  // actually said, what a model inferred from it, and the assessment written afterwards. Same policy
  // shape as `interview_briefs` — owner, or a colleague with `access_granted` — and no audio column
  // anywhere, which the loop above asserts rather than merely documenting here.
  tenant('interview_sessions', 'organization_id + owner_user_id, or event_participants.access_granted = true', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'retention_expires_at, bounded by INTERVIEW_TRANSCRIPT_RETENTION_DAYS (90 max); provider_billed_seconds is a settlement figure, not a pointer to a recording',
  }),
  tenant('transcript_segments', 'organization_id (via interview_sessions → owner or granted participant)', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'retention_expires_at, inherited from the session; holds a candidate\'s own words, and only final segments — interim text is never persisted',
  }),
  tenant('interview_suggestions', 'organization_id (via interview_sessions → owner)', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'retention_expires_at, inherited from the session; a row exists only once an organizer saved or used the suggestion, since the rest are ephemeral',
  }),
  tenant('interview_reports', 'organization_id + owner_user_id, or event_participants.access_granted = true', ['calendar-scheduling-interview-intelligence'], {
    organizationColumn: true,
    retention: 'retention_expires_at; keyed to the event rather than the session so a report survives its session being reclaimed',
  }),

  // Semantic search and proactive discovery (plans/phase-1/22-semantic-search, 23-proactive-discovery).
  //
  // `builder_embeddings` is the global pgvector index, written by the write-through path that fires
  // after every search/track request and by the proactive-discovery worker. The data inside is a
  // public profile, not a DTO — consumers go through `/api/search/semantic`, not the table — so this
  // is system-operational, the same shape as `builder_source_snapshots` above. `discovery_state` is
  // the single-row worker cursor (Postgres, not Redis, so it survives restarts).
  operational('builder_embeddings', 'global external-profile index', ['semantic-search', 'proactive-discovery']),
  operational('discovery_state', 'worker cursor (singleton)', ['proactive-discovery']),

  // Devpost integration (plan 19). Devpost has no API and bot-challenges plain server-side fetch,
  // so a headless-browser worker scrapes profiles into `devpost_profiles` and reads the row, never
  // the live site, inside a search request. State cursor mirrors `discovery_state`. Both are
  // system-operational: no owning subject, no RLS — access is by per-role GRANT only.
  operational('devpost_profiles', 'global scraped profile cache', ['devpost-integration']),
  operational('devpost_ingestion_state', 'worker cursor (singleton)', ['devpost-integration']),

  // AI sourcing sprints (plan 41). Both tables are tenant-private: `organization_id` is NOT NULL
  // with a composite FK convention to make a result row impossible to scope to a different
  // organization than its sprint. This is the exact same shape as `enrichment_jobs`/`enrichment_evidence`
  // below — the same `organization_id` + `sprint_id` / `job_id` composite FK.
  tenant('sourcing_sprints', 'organization_id + creator_user_id', ['ai-sourcing-sprints'], { organizationColumn: true }),
  tenant('sprint_results', 'organization_id (via sourcing_sprints)', ['ai-sourcing-sprints'], { organizationColumn: true }),

  // Public profile enrichment (plan 42). `enrichment_jobs` and `enrichment_evidence` are
  // tenant-private and reuse the organization_builders composite FK so a job/evidence row can
  // never name a builder identity the org has not tracked. `builder_processing_restrictions` is
  // platform-scoped (one row per `builderIdentityId`, never joined per-organization) and is the
  // subject-rights opt-out — a deleted/withdrawn record keeps the identity filtered from every
  // surface. Same RLS-exception rationale as `status_checks`/`public_surface_indexing` below.
  tenant('enrichment_jobs', 'organization_id (composite FK to organization_builders)', ['stealth-scraping'], { organizationColumn: true }),
  tenant('enrichment_evidence', 'organization_id (composite FK to enrichment_jobs + organization_builders)', ['stealth-scraping'], { organizationColumn: true }),
  operational('builder_processing_restrictions', 'builder_identity_id (platform-scoped subject restriction)', ['stealth-scraping']),

  // Stripe billing platform (plan 30). All `billing_*` tables are tenant-private except those the
  // schema docstring explicitly says are platform/worker-only: `billing_webhook_events` (one row
  // per Stripe event, no organization scope), `billing_reconciliation_runs` (window-spanning
  // platform audit), `billing_seller_profiles` (versioned seller configuration, no CPR/card/bank
  // data), and `billing_notification_log` (the `'platform'` sentinel is documented for
  // cross-organization notification types, so the `organization_id` column is denormalized
  // correlation, not a real FK — mirroring `organization_deletion_financial_records`).
  //
  // `billing_auto_recharge_rules` and `billing_contacts` are PK'd directly on `organization_id`
  // (no surrogate id): mutable current-state, not append-only. `billing_terms_acceptances` is
  // append-only legal record of consent versions, the same shape as `privacy_consents` above.
  tenant('billing_customers', 'organization_id', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_subscriptions', 'organization_id + customer_id', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_checkout_attempts', 'organization_id + actor_user_id', ['stripe-billing-platform'], { organizationColumn: true }),
  operational('billing_webhook_events', 'stripe event id (platform/worker only)', ['stripe-billing-platform']),
  tenant('billing_credit_grants', 'organization_id', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_credit_reservations', 'organization_id + idempotency_key', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_credit_allocations', 'organization_id (composite FK to reservation + grant)', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_ledger_entries', 'organization_id (append-only, single-writer-per-event-type)', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_provider_usage', 'organization_id', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_auto_recharge_rules', 'organization_id (mutable current state)', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_refunds', 'organization_id + requested_by_user_id', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_disputes', 'organization_id + grant_id', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_contacts', 'organization_id (mutable current state)', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_risk_events', 'organization_id (append-only velocity signal)', ['stripe-billing-platform'], { organizationColumn: true }),
  tenant('billing_risk_exceptions', 'organization_id + issued_by_user_id', ['stripe-billing-platform'], { organizationColumn: true }),
  operational('billing_reconciliation_runs', 'window (platform audit, no organization scope)', ['stripe-billing-platform']),
  operational('billing_notification_log', 'organization_id (denormalized; the \'platform\' sentinel covers cross-org types)', ['stripe-billing-platform']),
  operational('billing_seller_profiles', 'versioned seller configuration (platform-private)', ['stripe-billing-platform']),
  tenant('billing_terms_acceptances', 'organization_id + actor_user_id (append-only consent record)', ['stripe-billing-platform'], { organizationColumn: true }),

  // Abuse and usage integrity (plan 32). `abuse_signals` is append-only, never updated or deleted,
  // and the user_id/organization_id columns are correlation only with NO foreign key — an abuse
  // signal must outlive the account or organization it names (compliance/investigation trail).
  // `account_risk` is per-user rolling state, RLS by `app.user_id`. `session_signals` correlates
  // to a session via a salted session-id hash and a device via deviceId — neither is a real FK
  // to a session/device row, both are one-way lookups an operator can join on. `user_devices`
  // is per-user state. `seat_usage_daily` is per-(org, user, day) enforcement counters.
  operational('abuse_signals', 'append-only correlation (no FK; outlives subjects)', ['abuse-and-usage-integrity']),
  account('account_risk', 'user_id', ['abuse-and-usage-integrity']),
  operational('session_signals', 'session_id_hash (salted, no raw session token)', ['abuse-and-usage-integrity']),
  account('user_devices', 'user_id', ['abuse-and-usage-integrity']),
  tenant('seat_usage_daily', 'organization_id + user_id + day', ['abuse-and-usage-integrity'], { organizationColumn: true }),

  // Onboarding (plan 8). `onboarding_selected_builders` is keyed by organization AND user, with a
  // composite FK back to `onboarding_progress(organization_id, user_id)` — same shape as the
  // tenant-private tables above. The `builder_ref` is deliberately source-opaque (no FK to
  // `organization_builders`), since onboarding picks are frequently never tracked.
  tenant('onboarding_selected_builders', 'organization_id + user_id', ['onboarding-flow'], { organizationColumn: true }),

  // Operational scheduling and run history. Platform-owned jobs, not tenant rows — no
  // `organization_id`, no RLS, access by per-role GRANT. The schema docstring for both tables
  // names this shape explicitly. `operational_schedules` is a CRON-style registry; `job_runs`
  // is the append-only history. `OPERATIONAL_SCHEDULES` registry
  // (`src/shared/lib/operational-schedules.ts`) is the binding contract for `jobKey` uniqueness.
  operational('operational_schedules', 'job_key (globally unique, platform-owned)', ['exhaustive-local-e2e-design']),
  operational('job_runs', 'job_key + scheduled_for (append-only history)', ['exhaustive-local-e2e-design']),

  // Organization deletion (plan 1). `organization_deletion_requests` is the requester-owned
  // record of a pending/immediate delete — `requestedByUserId` is the owning user, the org row
  // is the subject. `organization_deletion_financial_records` is the durable compliance
  // snapshot written just before the org row is hard-deleted; deliberately no FK to
  // organizations and no RLS, since by the time anyone reads it back the org no longer exists.
  account('organization_deletion_requests', 'requested_by_user_id + organization_id (no FK; outlives the org)', ['security-and-multitenancy']),
  operational('organization_deletion_financial_records', 'organization_id (no FK; pre-deletion compliance snapshot)', ['stripe-billing-platform', 'security-and-multitenancy']),

  // Profile removal / trust audit (plan 52). `profile_removal_requests` and `profile_suppressions`
  // are platform-owned subject-rights records, deliberately without user or organization scope:
  // a removal is initiated by a person who may not have a BuilderHunt account, and a suppression
  // is enforced across every consumer surface. Hashes only — no plaintext email or URL is stored.
  // Invite-gated access (plan 54). `access_requests` is platform-owned and deliberately outside any
  // organization: someone asking for access has no tenant yet, and an approved row IS the allowlist
  // the sign-up gate reads.
  //
  // Unlike every other table in this block, it holds a **plaintext email**. That is not an oversight
  // and it cannot be hashed: an operator has to read the address to decide, and approval sends mail
  // to it. The consequence is that this is the one system-operational table containing unhashed
  // personal data about non-users, so it owes a retention rule, a privacy-export entry and a line in
  // /legal/privacy — none of which exists yet (tracked in the plan-54 task list, and this comment is
  // deliberately blunt so the gap cannot be mistaken for a decision).
  operational('access_requests', 'email (plaintext, platform-owned; no tenant scope)', ['waitlist-launch']),

  operational('profile_removal_requests', 'source + source_id (hashed challenge, no PII)', ['audit-trust']),
  operational('profile_suppressions', 'source + source_id (revoked/active, audited admin action)', ['audit-trust']),

  // Public surfaces (plan 45). `public_radars` is a tenant-private link between a saved query and
  // a public landing URL — it is owned by the organization that owns the query, and the URL is
  // a derived DTO, not a free-form text column. `public_surface_indexing` is the per-surface
  // search-engine directive set by a platform admin — same shape as `status_checks`: a platform
  // setting, not tenant or user data, so no RLS is possible or needed.
  tenant('public_radars', 'organization_id + saved_query_id (composite FK to saved_queries)', ['public-landing-pages'], { organizationColumn: true }),
  operational('public_surface_indexing', 'surface (platform setting, no owning subject)', ['public-landing-pages']),

  // Conversion audit (plan 51). Append-only, privacy-minimized landing-funnel events — no user
  // id, email, IP, query text, referrer, or user agent, only a closed set of (name, surface,
  // variant) for a session id. `system-operational` rather than `account-subject` because there
  // is no per-user row to scope to; the `session_id` is correlation only.
  operational('conversion_events', 'session_id (closed funnel schema, no PII)', ['audit-conversion']),

  // Status & trust (plan 47). `status_checks` is the platform's uptime observation history —
  // a system row, no owning subject, no RLS, access by per-role GRANT only. Surfaced read-only
  // through `/api/status`.
  operational('status_checks', 'checked_at (platform uptime history)', ['status-and-trust']),

  // Security audit (plan 32 named this table while working around its absence). Append-only evidence of who did
  // what: no owning subject to scope to, and deliberately no FK to organizations or auth_users — a cascade would
  // delete the record of an organization's actions exactly when the record matters most. Access is by per-role
  // GRANT only: app INSERT (never SELECT — a trail the request path can read is a trail it can leak), platform-admin
  // SELECT, worker DELETE for retention, UPDATE to nobody.
  operational('security_audit_events', 'created_at + action (append-only, redacted details)', ['abuse-and-usage-integrity']),

  // Work sample analysis (plan 38). Per-user analysis result of a URL the user submitted — an
  // AI-generated assessment of a public artifact, owned by the submitting user. No tenant scope
  // because the surface is not yet org-scoped.
  account('work_sample_analyses', 'user_id + sample_url', ['work-sample']),
]

const schemaSource = await readFile(new URL('../../src/shared/lib/db/schema.ts', import.meta.url), 'utf8')
const schemaTables = [...schemaSource.matchAll(/pgTable\(\s*['"]([^'"]+)['"]/g)]
  .map((match) => match[1])
  .sort()
const classified = new Map(classifications.map((entry) => [entry.table, entry]))

const findings: string[] = []
for (const table of schemaTables) {
  if (!classified.has(table)) findings.push(`${table}: unclassified table`)
}

/**
 * The live-interview tables must never gain a column that could hold or point at audio.
 *
 * spec.md calls the audio transient, and the consent a candidate gives is for transient live
 * transcription — not for a recording. A `recording_key` added in good faith by someone wiring up
 * "just a debug copy" would make that consent inaccurate the moment it was used, and nothing else in
 * this repository would notice. So it is asserted here rather than trusted to review, and it is
 * asserted by *pattern* rather than by an exact column list: the point is to catch a name nobody has
 * thought of yet.
 */
const NO_AUDIO_TABLES = ['interview_sessions', 'transcript_segments', 'interview_suggestions', 'interview_reports']
const AUDIO_LIKE_COLUMN = /audio|blob|bytea|recording|waveform|object_key|storage_key|media_url|file_path/i

/**
 * Column names of one `pgTable` definition.
 *
 * Plain string slicing rather than a constructed `RegExp`. The regex version looked right, matched in
 * isolation, and silently found nothing here — so the assertion below reported clean while a planted
 * `recordingObjectKey` sat in the schema. A check that cannot fail is worse than no check, so this is
 * written to be obviously correct instead of cleverly short, and `columns.length === 0` is itself a
 * finding so a future rename cannot turn it back into a no-op.
 */
function tableColumnNames(source: string, table: string): string[] {
  const marker = `pgTable(\n  '${table}',`
  const at = source.indexOf(marker)
  if (at < 0) return []
  const bodyStart = source.indexOf('{', at + marker.length)
  const bodyEnd = source.indexOf('\n  },', bodyStart)
  if (bodyStart < 0 || bodyEnd < 0) return []
  return source
    .slice(bodyStart, bodyEnd)
    .split('\n')
    .map((line) => /^\s{4}(\w+)\s*:/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
}

for (const table of NO_AUDIO_TABLES) {
  const columns = tableColumnNames(schemaSource, table)
  if (columns.length === 0) {
    findings.push(`${table}: no columns found — the no-audio assertion cannot run and must be repaired`)
    continue
  }
  for (const column of columns) {
    if (AUDIO_LIKE_COLUMN.test(column)) {
      findings.push(`${table}.${column}: audio-like column on a table that must never hold or reference audio`)
    }
  }
}


for (const entry of classifications) {
  if (!schemaTables.includes(entry.table)) findings.push(`${entry.table}: classification has no schema table`)
  if (entry.class === 'tenant-private' && !entry.tenantRoot && !entry.organizationColumn) {
    findings.push(`${entry.table}: ${entry.transitionFinding ?? 'tenant-private table missing organization_id'}`)
  }
  // `transitionFinding` on a non-tenant table (e.g. `builders`, `onboarding_progress`) is a known,
  // documented migration in flight — surfaced as a property on the table entry, not as a finding,
  // so the gate fails on a *new* unclassified table and stays quiet on the one that is mid-split.
}

const manifest = {
  version: 1,
  generatedFrom: 'src/shared/lib/db/schema.ts',
  tables: classifications
    .filter((entry) => schemaTables.includes(entry.table))
    .sort((left, right) => left.table.localeCompare(right.table))
    .map((entry) => ({
      ...entry,
      rowCountQuery: `select count(*)::bigint as row_count from "${entry.table}"`,
      rls: entry.class === 'tenant-private' ? 'required-before-cutover' : 'not-applicable-or-role-restricted',
    })),
  findings: findings.sort(),
}

if (process.argv.includes('--markdown')) {
  console.log('| Table | Class | Owner | RLS |')
  console.log('| --- | --- | --- | --- |')
  for (const table of manifest.tables) {
    console.log(`| ${table.table} | ${table.class} | ${table.ownerKey} | ${table.rls} |`)
  }
} else {
  console.log(JSON.stringify(manifest, null, 2))
}

if (findings.length > 0 && !process.argv.includes('--allow-findings')) process.exitCode = 1

function account(
  table: string,
  ownerKey: string,
  plans: string[],
  retention = 'account lifetime plus documented legal/operational window',
): Classification {
  return { table, class: 'account-subject', ownerKey, publicDtoFields: [], retention, plans }
}

function tenant(
  table: string,
  ownerKey: string,
  plans: string[],
  options: Pick<Classification, 'tenantRoot' | 'organizationColumn' | 'transitionFinding' | 'retention'> = {},
): Classification {
  return {
    table,
    class: 'tenant-private',
    ownerKey,
    publicDtoFields: [],
    // Overridable, because the organization-lifetime default is a claim about ordinary tenant content
    // and some tenant rows carry something narrower — a credential hash, a third party's address —
    // whose window is set by what it holds rather than by how long the organization lives.
    retention: options.retention ?? 'organization lifetime plus documented legal/operational window',
    plans,
    tenantRoot: options.tenantRoot,
    organizationColumn: options.organizationColumn ?? (options.tenantRoot || ownerKey === 'organization_id'),
    transitionFinding: options.transitionFinding,
  }
}

function global(table: string, publicDtoFields: string[], plans: string[]): Classification {
  return { table, class: 'global-public', ownerKey: 'platform', publicDtoFields, retention: 'published history', plans }
}

function operational(table: string, ownerKey: string, plans: string[]): Classification {
  return { table, class: 'system-operational', ownerKey, publicDtoFields: [], retention: 'bounded operational/audit schedule', plans }
}
