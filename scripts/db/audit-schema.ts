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
  options: Pick<Classification, 'tenantRoot' | 'organizationColumn' | 'transitionFinding'> = {},
): Classification {
  return {
    table,
    class: 'tenant-private',
    ownerKey,
    publicDtoFields: [],
    retention: 'organization lifetime plus documented legal/operational window',
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
