import postgres from 'postgres'

const migrationUrl = process.env.TEST_MIGRATION_URL
if (!migrationUrl) throw new Error('TEST_MIGRATION_URL is required')
const parsed = new URL(migrationUrl)
const databaseName = parsed.pathname.slice(1)
if (!/^builderhunt_security_test_[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error('RLS fixture refuses to run outside a named builderhunt_security_test database')
}

// Postgres roles are cluster-global. On a shared local instance, ALTERing the
// base application roles' passwords breaks every concurrent session (dev
// servers, E2E runs) mid-flight — observed as sign-up 500s and 28P01 errors.
// CI runs on a throwaway service container AND its later job steps connect as
// the base roles with these fixed passwords, so only there (or under an
// explicit escape hatch) do we keep the legacy global mutation. Everywhere
// else we create per-run dedicated login roles that are members of the base
// roles: table privileges and RLS policies (`TO builderhunt_app` …) apply to
// inheriting members, and nothing shared is ever mutated.
const mutateGlobalRoles = process.env.CI === 'true' || process.env.RLS_ALLOW_GLOBAL_ROLE_MUTATION === '1'
const ROLE_PASSWORDS = {
  builderhunt_app: 'test-app-password',
  builderhunt_auth: 'test-auth-password',
  builderhunt_worker: 'test-worker-password',
  builderhunt_platform: 'test-platform-password',
  // The accountless candidate identity (drizzle/0078). Its policies were never
  // exercised by this fixture, which is how they stayed organization-scoped —
  // and therefore cross-candidate readable — without anyone noticing.
  builderhunt_capability: 'test-capability-password',
}
const roleSuffix = databaseName.replace(/^builderhunt_security_test_/, '')

const owner = postgres(migrationUrl, { max: 1, prepare: false })
try {
  const roles = {}
  const urls = {}
  for (const [baseRole, password] of Object.entries(ROLE_PASSWORDS)) {
    let connectAs = baseRole
    if (mutateGlobalRoles) {
      await owner.unsafe(`alter role ${baseRole} password '${password}'`)
    } else {
      connectAs = `${baseRole}_rls_${roleSuffix}`
      await owner.unsafe(`drop role if exists ${connectAs}`)
      await owner.unsafe(`create role ${connectAs} login inherit password '${password}' in role ${baseRole}`)
    }
    await owner.unsafe(`grant connect on database ${databaseName} to ${connectAs}`)
    roles[baseRole] = connectAs
    const url = new URL(migrationUrl)
    url.username = connectAs
    url.password = password
    urls[baseRole] = url.toString()
  }
  await owner`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values
      ('user-a', 'A', 'a@test.invalid', true, now(), now()),
      ('user-b', 'B', 'b@test.invalid', true, now(), now()),
      ('user-pending-claimant', 'Pending Claimant', 'pending-claimant@test.invalid', true, now(), now())
    on conflict (id) do nothing
  `
  await owner`
    insert into organizations (id, name, slug, metadata, created_at)
    values ('org-a', 'A', 'org-a', '{}', now()), ('org-b', 'B', 'org-b', '{}', now())
    on conflict (id) do nothing
  `
  await owner`
    insert into organization_members (id, organization_id, user_id, role, created_at)
    values ('member-a', 'org-a', 'user-a', 'owner', now()), ('member-b', 'org-b', 'user-b', 'owner', now())
    on conflict (organization_id, user_id) do nothing
  `
  await owner`
    insert into alerts (
      id, organization_id, user_id, name, keywords, enabled, trigger_conditions, delivery_channel, created_at
    ) values
      -- keywords is jsonb declared string[]; '[]' not '{}'. An empty *object* has no length property,
      -- so it slipped past the alerts worker's "no keywords, skip" check and died inside the search
      -- cache key on .sort. These rows exist for the RLS checks to look at, but the worker reads them
      -- too, and a fixture that stores a shape the column does not allow tests the wrong thing.
      ('alert-a', 'org-a', 'user-a', 'A', '[]', true, '{"eventType":"any_activity"}', 'dashboard', now()),
      ('alert-b', 'org-b', 'user-b', 'B', '[]', true, '{"eventType":"any_activity"}', 'dashboard', now())
    on conflict (id) do nothing
  `
  await owner`
    insert into builder_identities (id, source, source_id, username, profile_url, created_at, updated_at)
    values
      ('identity-a', 'github', 'a', 'a', 'https://github.com/a', now(), now()),
      ('identity-b', 'github', 'b', 'b', 'https://github.com/b', now(), now()),
      ('identity-pending', 'github', 'pending-claim', 'pending-claim', 'https://github.com/pending-claim', now(), now())
    on conflict (source, source_id) do nothing
  `
  await owner`
    insert into organization_builders (
      id, organization_id, builder_identity_id, creator_user_id,
      visibility, status, private_metadata, created_at, updated_at
    ) values
      ('tracked-a', 'org-a', 'identity-a', 'user-a', 'private', 'tracked', '{}', now(), now()),
      ('tracked-b', 'org-b', 'identity-b', 'user-b', 'private', 'tracked', '{}', now(), now())
    on conflict (organization_id, builder_identity_id) do nothing
  `
  await owner`
    insert into builder_lists (
      id, organization_id, created_by_user_id, name, description, visibility, version, created_at, updated_at
    ) values
      ('list-a', 'org-a', 'user-a', 'List A', null, 'private', 1, now(), now()),
      ('list-b', 'org-b', 'user-b', 'List B', null, 'private', 1, now(), now())
    on conflict (id) do nothing
  `
  // Saved Solutions briefs and runs (plan 43 Phase 8). Seeded per tenant so the isolation checks in
  // verify-rls-local.mjs have a row on each side — the point of the run rows is the *absence* of an UPDATE
  // grant, which is only checkable against a row that exists.
  await owner`
    insert into solution_briefs (id, organization_id, created_by_user_id, title, brief, created_at, updated_at)
    values
      ('solution-brief-a', 'org-a', 'user-a', 'Brief A', '{"capabilities":["translation"]}'::jsonb, now(), now()),
      ('solution-brief-b', 'org-b', 'user-b', 'Brief B', '{"capabilities":["translation"]}'::jsonb, now(), now())
    on conflict (id) do nothing
  `
  await owner`
    insert into solution_runs (
      id, organization_id, brief_id, created_by_user_id, brief_snapshot, ranking_mode,
      retrieval_query_hash, composition_hash, composer_version, created_at
    ) values
      ('solution-run-a', 'org-a', 'solution-brief-a', 'user-a', '{"capabilities":["translation"]}'::jsonb, 'recommended', 'hash-a', 'comp-a', 'composer-1', now()),
      ('solution-run-b', 'org-b', 'solution-brief-b', 'user-b', '{"capabilities":["translation"]}'::jsonb, 'recommended', 'hash-b', 'comp-b', 'composer-1', now())
    on conflict (id) do nothing
  `
  await owner`
    insert into solution_run_routes (
      run_id, organization_id, route_type, route, status, explanation_provenance, created_at
    ) values
      ('solution-run-a', 'org-a', 'ai', '{"routeType":"ai"}'::jsonb, 'available', 'model', now()),
      ('solution-run-b', 'org-b', 'ai', '{"routeType":"ai"}'::jsonb, 'available', 'model', now())
    on conflict (run_id, route_type) do nothing
  `
  await owner`
    insert into builder_claims (
      id, builder_identity_id, subject_user_id, evidence_source, evidence_reference, status, created_at
    ) values
      ('claim-a', 'identity-a', 'user-a', 'email', 'a@test.invalid', 'verified', now()),
      ('claim-b', 'identity-b', 'user-b', 'email', 'b@test.invalid', 'verified', now()),
      ('claim-pending', 'identity-pending', 'user-pending-claimant', 'email', 'pending@test.invalid', 'pending', now())
    on conflict (id) do nothing
  `
  await owner`
    insert into billing_customers (id, organization_id, livemode, stripe_customer_id, created_at, updated_at)
    values
      ('billing-cust-a', 'org-a', false, 'cus_test_a', now(), now()),
      ('billing-cust-b', 'org-b', false, 'cus_test_b', now(), now())
    on conflict (id) do nothing
  `
  await owner`
    insert into user_devices (id, user_id, device_hash, ua_family, trust_state)
    values
      ('device-a', 'user-a', 'hash-a', 'chrome', 'new'),
      ('device-b', 'user-b', 'hash-b', 'chrome', 'new')
    on conflict (id) do nothing
  `
  await owner`
    insert into account_risk (user_id, risk_score, stage, updated_at)
    values ('user-a', 0, 'observe', now()), ('user-b', 0, 'observe', now())
    on conflict (user_id) do nothing
  `
  await owner`
    insert into seat_usage_daily (id, organization_id, user_id, day, action, count, credit_units)
    values
      ('usage-a', 'org-a', 'user-a', '2026-01-01', 'searches', 1, 0),
      ('usage-b', 'org-b', 'user-b', '2026-01-01', 'searches', 1, 0)
    on conflict (id) do nothing
  `
  // calendar-scheduling-interview-intelligence: org-a's owner (user-a) owns a calendar, an
  // event, and an invitation. user-c is an org-a member who is an access-granted participant on
  // that event; user-d is an org-a admin with no participation at all — the verifier asserts the
  // admin still sees nothing, which is this plan's strictest requirement.
  await owner`
    insert into auth_users (id, name, email, email_verified, created_at, updated_at)
    values
      ('user-c', 'C', 'c@test.invalid', true, now(), now()),
      ('user-d', 'D', 'd@test.invalid', true, now(), now())
    on conflict (id) do nothing
  `
  await owner`
    insert into organization_members (id, organization_id, user_id, role, created_at)
    values ('member-c', 'org-a', 'user-c', 'member', now()), ('member-d', 'org-a', 'user-d', 'admin', now())
    on conflict (organization_id, user_id) do nothing
  `
  await owner`
    insert into user_calendars (id, organization_id, owner_user_id, name, timezone, is_default)
    values
      ('aaaaaaaa-0000-4000-8000-00000000000a', 'org-a', 'user-a', 'Cal A', 'Europe/Copenhagen', true),
      ('aaaaaaaa-0000-4000-8000-00000000000b', 'org-b', 'user-b', 'Cal B', 'UTC', true)
    on conflict (id) do nothing
  `
  await owner`
    insert into calendar_events (id, organization_id, calendar_id, owner_user_id, type, status, title, starts_at, ends_at, timezone)
    values
      ('bbbbbbbb-0000-4000-8000-00000000000a', 'org-a', 'aaaaaaaa-0000-4000-8000-00000000000a', 'user-a', 'interview', 'scheduled', 'Event A', now(), now() + interval '1 hour', 'Europe/Copenhagen'),
      ('bbbbbbbb-0000-4000-8000-00000000000b', 'org-b', 'aaaaaaaa-0000-4000-8000-00000000000b', 'user-b', 'personal', 'scheduled', 'Event B', now(), now() + interval '1 hour', 'UTC')
    on conflict (id) do nothing
  `
  await owner`
    insert into event_participants (id, organization_id, event_id, event_owner_user_id, user_id, role, access_granted)
    values ('cccccccc-0000-4000-8000-00000000000a', 'org-a', 'bbbbbbbb-0000-4000-8000-00000000000a', 'user-a', 'user-c', 'attendee', true)
    on conflict (id) do nothing
  `
  await owner`
    insert into availability_policies (id, organization_id, owner_user_id, default_reminder_offsets, default_reminder_channels, version)
    values
      ('eeeeeeee-0000-4000-8000-00000000000a', 'org-a', 'user-a', '{15}', '{email}', 2),
      ('eeeeeeee-0000-4000-8000-00000000000b', 'org-b', 'user-b', '{60}', '{in_app}', 2)
    on conflict (id) do nothing
  `
  await owner`
    insert into scheduling_invitations (id, organization_id, owner_user_id, role_title, role_context, duration_minutes, timezone, modality, capability_hash, policy_version)
    values ('dddddddd-0000-4000-8000-00000000000a', 'org-a', 'user-a', 'Engineer', 'context', 60, 'Europe/Copenhagen', 'remote_call', 'capability-hash-a', 'v1')
    on conflict (id) do nothing
  `
  await owner`
    insert into candidate_submissions (id, organization_id, invitation_id, display_name, email_normalized, retention_expires_at)
    values ('eeeeeeee-0000-4000-8000-00000000000a', 'org-a', 'dddddddd-0000-4000-8000-00000000000a', 'Candidate', 'cand@test.invalid', now() + interval '180 days')
    on conflict (id) do nothing
  `

  // A second invitation and candidate inside org-a. One candidate's capability
  // link must not reach the other's row; with only one candidate seeded, an
  // organization-scoped policy and an invitation-scoped one are
  // indistinguishable.
  await owner`
    insert into scheduling_invitations (id, organization_id, owner_user_id, role_title, role_context, duration_minutes, timezone, modality, capability_hash, policy_version)
    values ('dddddddd-0000-4000-8000-00000000000b', 'org-a', 'user-a', 'Designer', 'context', 45, 'Europe/Copenhagen', 'remote_call', 'capability-hash-b', 'v1')
    on conflict (id) do nothing
  `
  await owner`
    insert into candidate_submissions (id, organization_id, invitation_id, display_name, email_normalized, retention_expires_at)
    values ('eeeeeeee-0000-4000-8000-00000000000b', 'org-a', 'dddddddd-0000-4000-8000-00000000000b', 'Other Candidate', 'other@test.invalid', now() + interval '180 days')
    on conflict (id) do nothing
  `

  // Phase 6 document tables. Seeded here rather than in the verifier so the
  // ownership chain the policies walk — document → submission → invitation →
  // owner_user_id — exists before any role connects.
  await owner`
    insert into candidate_documents (id, organization_id, submission_id, object_key, original_name, declared_media_type, sha256, bytes, retention_expires_at)
    values ('ffffffff-0000-4000-8000-00000000000a', 'org-a', 'eeeeeeee-0000-4000-8000-00000000000a',
            'org-a/eeeeeeee/cv.pdf', 'cv.pdf', 'application/pdf', repeat('a', 64), 1024, now() + interval '180 days')
    on conflict (id) do nothing
  `
  // A participant who is on the event but was NOT granted access to its preparation material. Without
  // this row, "the granted participant can read the brief" holds whether the policy checks
  // `access_granted` or merely membership — and being added to a calendar invite is not the same act as
  // being handed a candidate assessment.
  await owner`
    insert into event_participants (id, organization_id, event_id, event_owner_user_id, user_id, role, access_granted)
    values ('cccccccc-0000-4000-8000-00000000000d', 'org-a', 'bbbbbbbb-0000-4000-8000-00000000000a', 'user-a', 'user-d', 'attendee', false)
    on conflict (id) do nothing
  `

  // A live session on that event, with one transcript segment: the most sensitive rows in the product,
  // and the ones whose policy shape must be measured rather than assumed.
  await owner`
    insert into interview_sessions (id, organization_id, event_id, owner_user_id, state, capture_mode, language, provider, consent_notice_version, capture_capability, retention_expires_at)
    values ('11111111-2222-4000-8000-00000000000a', 'org-a', 'bbbbbbbb-0000-4000-8000-00000000000a', 'user-a',
            'live', 'in_person', 'en', 'deepgram', 'v1', 'microphone_and_shared_audio_available', now() + interval '90 days')
    on conflict (id) do nothing
  `
  await owner`
    insert into transcript_segments (id, organization_id, session_id, provider_segment_id, sequence, speaker_estimate, text, starts_ms, ends_ms, retention_expires_at)
    values ('22222222-3333-4000-8000-00000000000a', 'org-a', '11111111-2222-4000-8000-00000000000a', 'prov-1', 0,
            'speaker_a', 'what the candidate said', 0, 1000, now() + interval '90 days')
    on conflict (id) do nothing
  `

  // An interview brief on that event: an assessment of a named person, which is why its policy is
  // narrower than any other table here.
  await owner`
    insert into interview_briefs (id, organization_id, event_id, owner_user_id, version, status, content, evidence_manifest, retention_expires_at)
    values ('aaaaaaaa-1111-4000-8000-00000000000a', 'org-a', 'bbbbbbbb-0000-4000-8000-00000000000a', 'user-a', 1, 'active',
            '{"candidateSummary":"s","relevantEvidence":[],"informationGaps":[],"contradictions":[],"questionGroups":[]}'::jsonb,
            '[]'::jsonb, now() + interval '180 days')
    on conflict (id) do nothing
  `

  // One link per candidate, so the invitation-scoped capability policy 0086 applied to
  // `candidate_links` is measured rather than assumed. It had no fixture and no assertion at all
  // until now, which meant the narrowing was shipped unverified.
  await owner`
    insert into candidate_links (id, organization_id, submission_id, url, normalized_url, source_type, acquisition_mode, policy_decision, import_state)
    values ('cccccccc-0000-4000-8000-00000000000a', 'org-a', 'eeeeeeee-0000-4000-8000-00000000000a',
            'https://cand-a.dev/', 'https://cand-a.dev/', 'personal_site', 'user_submitted', 'user_submitted', 'not_requested')
    on conflict (id) do nothing
  `
  await owner`
    insert into candidate_links (id, organization_id, submission_id, url, normalized_url, source_type, acquisition_mode, policy_decision, import_state)
    values ('cccccccc-0000-4000-8000-00000000000b', 'org-a', 'eeeeeeee-0000-4000-8000-00000000000b',
            'https://cand-b.dev/', 'https://cand-b.dev/', 'personal_site', 'user_submitted', 'user_submitted', 'not_requested')
    on conflict (id) do nothing
  `

  // A second candidate's document, in the SAME organization. Without it the capability assertion
  // "saw exactly one document" holds whether the policy is scoped to the organization or to the
  // invitation, so it would certify an isolation it never tested — the same blind spot that hid the
  // organization-wide capability policies until 0086.
  await owner`
    insert into candidate_documents (id, organization_id, submission_id, object_key, original_name, declared_media_type, sha256, bytes, scan_status, retention_expires_at)
    values ('ffffffff-0000-4000-8000-00000000000c', 'org-a', 'eeeeeeee-0000-4000-8000-00000000000b',
            'quarantine/org-a/eeeeeeee-b/other.pdf', 'other.pdf', 'application/pdf', repeat('c', 64), 2048, 'pending', now() + interval '180 days')
    on conflict (id) do nothing
  `
  await owner`
    insert into document_extractions (id, organization_id, document_id, parser, parser_version, content_sha256, retention_expires_at)
    values ('ffffffff-0000-4000-8000-00000000000b', 'org-a', 'ffffffff-0000-4000-8000-00000000000a',
            'pdf', 'v1', repeat('b', 64), now() + interval '180 days')
    on conflict (id) do nothing
  `

  // Stripe billing platform (plan 30) — the audit on 2026-07-31 found 16 of the 19 billing_* tables
  // had no live-role RLS test at all (only billing_customers, billing_checkout_attempts, and
  // billing_credit_reservations were exercised, and the latter two only for their write-permission
  // shape, not ordinary SELECT isolation). Seeded here, in FK dependency order, so the verifier can
  // assert against pre-existing rows the same way it already does for billing_customers.
  await owner`
    insert into billing_subscriptions (
      id, organization_id, customer_id, livemode, catalog_key, tier, "interval", catalog_version,
      stripe_subscription_id, stripe_status
    ) values
      ('sub-a', 'org-a', 'billing-cust-a', false, 'pro_monthly', 'pro', 'monthly', 1, 'sub_test_a', 'active'),
      ('sub-b', 'org-b', 'billing-cust-b', false, 'pro_monthly', 'pro', 'monthly', 1, 'sub_test_b', 'active')
    on conflict (id) do nothing
  `
  await owner`
    insert into billing_credit_grants (
      id, organization_id, source, original_units, remaining_units, state, expires_at
    ) values
      ('grant-a', 'org-a', 'pack', 1000, 1000, 'active', now() + interval '365 days'),
      ('grant-b', 'org-b', 'pack', 1000, 1000, 'active', now() + interval '365 days')
    on conflict (id) do nothing
  `
  // Distinct ids from the ad-hoc 'rls-unelevated'/'rls-elevated'/'rls-cross' rows the verifier
  // inserts itself to prove the 0098 role-elevation write path — these are pre-seeded read fixtures.
  await owner`
    insert into billing_credit_reservations (
      id, organization_id, operation, rate_card_version, idempotency_key, maximum_units, state,
      deadline_at
    ) values
      ('credit-res-a', 'org-a', 'interview_live_transcription', 1, 'fixture-res-a', 10, 'reserved', now() + interval '1 hour'),
      ('credit-res-b', 'org-b', 'interview_live_transcription', 1, 'fixture-res-b', 10, 'reserved', now() + interval '1 hour')
    on conflict (id) do nothing
  `
  await owner`
    insert into billing_credit_allocations (
      id, organization_id, reservation_id, grant_id, allocated_units
    ) values
      ('alloc-a', 'org-a', 'credit-res-a', 'grant-a', 5),
      ('alloc-b', 'org-b', 'credit-res-b', 'grant-b', 5)
    on conflict (id) do nothing
  `
  await owner`
    insert into billing_ledger_entries (
      id, organization_id, entry_type, grant_id, reservation_id, units_delta, source_idempotency_key
    ) values
      ('ledger-a', 'org-a', 'grant', 'grant-a', null, 1000, 'fixture-ledger-a'),
      ('ledger-b', 'org-b', 'grant', 'grant-b', null, 1000, 'fixture-ledger-b')
    on conflict (id) do nothing
  `
  await owner`
    insert into billing_provider_usage (
      id, organization_id, operation, reservation_id, units, estimated_cost_cents
    ) values
      ('provider-usage-a', 'org-a', 'interview_live_transcription', 'credit-res-a', 1, 10),
      ('provider-usage-b', 'org-b', 'interview_live_transcription', 'credit-res-b', 1, 10)
    on conflict (id) do nothing
  `
  // PK is organization_id itself — one row per org, no surrogate id.
  await owner`
    insert into billing_auto_recharge_rules (organization_id, owner_user_id, enabled, state)
    values ('org-a', 'user-a', false, 'inactive'), ('org-b', 'user-b', false, 'inactive')
    on conflict (organization_id) do nothing
  `
  // Seeded as already 'succeeded' with a real stripe_refund_id — a row that would fail the app
  // role's own INSERT `WITH CHECK` (pending + null stripe_refund_id), so the read-isolation fixture
  // cannot be mistaken for proof that the write-shape check works. The verifier proves that
  // separately with its own ad-hoc insert, same pattern as billing_checkout_attempts.
  await owner`
    insert into billing_refunds (
      id, organization_id, requested_by_user_id, idempotency_key, policy_decision, amount_cents,
      stripe_refund_id, state
    ) values
      ('refund-a', 'org-a', 'user-a', 'fixture-refund-a', 'full_unused_pack', 500, 're_test_a', 'succeeded'),
      ('refund-b', 'org-b', 'user-b', 'fixture-refund-b', 'full_unused_pack', 500, 're_test_b', 'succeeded')
    on conflict (id) do nothing
  `
  await owner`
    insert into billing_disputes (
      id, organization_id, grant_id, stripe_dispute_id, stripe_payment_intent_id, amount_cents,
      stripe_status
    ) values
      ('dispute-a', 'org-a', 'grant-a', 'dp_test_a', 'pi_test_a', 500, 'warning_needs_response'),
      ('dispute-b', 'org-b', 'grant-b', 'dp_test_b', 'pi_test_b', 500, 'warning_needs_response')
    on conflict (id) do nothing
  `
  // PK is organization_id itself, same shape as billing_auto_recharge_rules.
  await owner`
    insert into billing_contacts (organization_id, email, status, set_by_user_id)
    values ('org-a', 'billing-a@test.invalid', 'verified', 'user-a'), ('org-b', 'billing-b@test.invalid', 'verified', 'user-b')
    on conflict (organization_id) do nothing
  `
  await owner`
    insert into billing_risk_events (id, organization_id, event_type, detail)
    values
      ('risk-event-a', 'org-a', 'payment_failure', 'fixture'),
      ('risk-event-b', 'org-b', 'payment_failure', 'fixture')
    on conflict (id) do nothing
  `
  await owner`
    insert into billing_risk_exceptions (id, organization_id, reason, issued_by_user_id, expires_at)
    values
      ('risk-exc-a', 'org-a', 'fixture exception', 'user-a', now() + interval '30 days'),
      ('risk-exc-b', 'org-b', 'fixture exception', 'user-b', now() + interval '30 days')
    on conflict (id) do nothing
  `
  // System-operational: no organization_id at all. One row is enough to prove the app role has no
  // grant whatsoever, and that worker/platform see it with no tenant scoping to prove.
  await owner`
    insert into billing_webhook_events (
      id, livemode, stripe_event_id, api_version, object_type, event_type, payload_encrypted
    ) values ('webhook-a', false, 'evt_test_a', '2024-01-01', 'invoice', 'invoice.paid', 'encrypted-fixture')
    on conflict (id) do nothing
  `
  await owner`
    insert into billing_reconciliation_runs (id, window_start, window_end, counts_checked)
    values ('recon-a', now() - interval '1 day', now(), '{}')
    on conflict (id) do nothing
  `
  // No FK on organization_id — 'platform' is the documented cross-organization sentinel, not a real
  // organizations.id. One row scoped to org-a, one using the sentinel, so the verifier can pin the
  // policy's `org = current_setting(...) OR org = 'platform'` OR-branch precisely.
  await owner`
    insert into billing_notification_log (id, organization_id, notification_type, window_key)
    values
      ('notif-org-a', 'org-a', 'credit_expiry_30', 'fixture-window-org-a'),
      ('notif-platform', 'platform', 'reconciliation_mismatch', 'fixture-window-platform')
    on conflict (id) do nothing
  `
  // Platform-private, no organization scope at all — the app and worker roles have zero grant here.
  await owner`
    insert into billing_seller_profiles (
      version, legal_name, public_business_address, establishment_country, support_email,
      statement_descriptor, effective_at, created_by_user_id
    ) values (999999, 'Fixture Seller', 'Fixture Address', 'US', 'support@test.invalid', 'FIXTURE', now(), 'user-a')
    on conflict (version) do nothing
  `
  await owner`
    insert into billing_terms_acceptances (id, organization_id, actor_user_id, terms_version, privacy_version, commercial_action)
    values
      ('terms-a', 'org-a', 'user-a', 'v1', 'v1', 'checkout_subscription'),
      ('terms-b', 'org-b', 'user-b', 'v1', 'v1', 'checkout_subscription')
    on conflict (id) do nothing
  `
  // Deliberately not FK'd to organizations — by the time this row exists the organization it
  // describes has already been hard-deleted, which is why the id is a plain string that was never a
  // real org.
  await owner`
    insert into organization_deletion_financial_records (
      id, organization_id, organization_name, deletion_type, livemode
    ) values ('financial-record-a', 'org-deleted-a', 'Deleted Org A', 'scheduled', false)
    on conflict (id) do nothing
  `

  // `roles`/`urls` tell the caller which login roles to use for the verifier
  // (`scripts/db/verify-rls-local.mjs` reads RLS_TEST_*_URL): the base roles
  // themselves in CI, per-run dedicated members everywhere else.
  console.log(JSON.stringify({ prepared: true, database: databaseName, mutatedGlobalRoles: mutateGlobalRoles, roles, urls }))
} finally {
  await owner.end({ timeout: 5 })
}
