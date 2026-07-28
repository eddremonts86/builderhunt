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
  account('plans', 'user_id (legacy)', ['pricing-and-billing', 'security-and-multitenancy'], 'compatibility window; migrate to organization entitlement'),
  operational('plan_changes', 'affected user + admin actor', ['pricing-and-billing', 'security-and-multitenancy']),
  account('plan_requests', 'user_id (legacy)', ['pricing-and-billing', 'security-and-multitenancy'], 'support retention; migrate to organization ownership'),
  tenant('organization_entitlements', 'organization_id', ['security-and-multitenancy', 'pricing-and-billing'], { organizationColumn: true }),
  tenant('organization_plan_changes', 'organization_id', ['security-and-multitenancy', 'pricing-and-billing'], { organizationColumn: true }),
  global('builder_identities', ['id', 'source', 'source_id', 'username', 'display_name', 'avatar_url', 'bio', 'profile_url'], ['security-and-multitenancy', 'shared-resources']),
  operational('builder_source_snapshots', 'builder_identity_id', ['security-and-multitenancy']),
  tenant('organization_builders', 'organization_id', ['security-and-multitenancy', 'shared-resources'], { organizationColumn: true }),
  account('builder_claims', 'subject_user_id', ['security-and-multitenancy', 'claimable-profiles']),
  global('published_builder_profiles', ['builder_identity_id', 'display_name', 'bio', 'open_to_status', 'topics', 'published_at'], ['security-and-multitenancy', 'claimable-profiles']),
  operational('migration_backfill_runs', 'migration owner', ['security-and-multitenancy']),
  operational('migration_backfill_conflicts', 'migration run', ['security-and-multitenancy']),

  // Calendar and scheduling (plans/phase-1/calendar-scheduling-interview-intelligence).
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
for (const entry of classifications) {
  if (!schemaTables.includes(entry.table)) findings.push(`${entry.table}: classification has no schema table`)
  if (entry.class === 'tenant-private' && !entry.tenantRoot && !entry.organizationColumn) {
    findings.push(`${entry.table}: ${entry.transitionFinding ?? 'tenant-private table missing organization_id'}`)
  } else if (entry.transitionFinding) {
    findings.push(`${entry.table}: ${entry.transitionFinding}`)
  }
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
