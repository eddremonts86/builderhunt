/**
 * Seeds one interview invitation in the local development database and prints the candidate URL.
 *
 * Development only. It exists because the candidate portal cannot be exercised by hand otherwise:
 * the capability secret is never stored, so there is no way to recover a link after the fact — the
 * only way to get a working one is to be the code that issued it.
 *
 * Run with: pnpm exec tsx --env-file=.env --env-file=.env.local scripts/dev/seed-scheduling-invitation.ts
 *
 * `--env-file` rather than calling dotenv in the module body: `env.ts` validates on import, and ESM
 * evaluates every import before any statement here runs, so anything this file does to `process.env`
 * happens too late. `VITE_APP_URL` is normally injected by vite, so pass it in the environment too.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { issueCapability } from '../../src/lib/scheduling/capability'
import { authUsers, organizations } from '../../src/shared/lib/db/schema'
import { insertCalendar } from '../../src/shared/lib/repositories/calendar'
import {
  insertInvitation,
  replaceAvailabilityPolicy,
  updateInvitationStateWithVersion,
  upsertAvailabilityPolicyWithVersion,
} from '../../src/shared/lib/repositories/scheduling'

const ORG = 'dev-scheduling-org'
const OWNER = 'dev-scheduling-owner'

async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL is required')

  const client = postgres(url, { max: 1, prepare: false })
  const db = drizzle(client)

  await db.insert(organizations).values({ id: ORG, name: 'Dev Scheduling', slug: ORG }).onConflictDoNothing()
  await db.insert(authUsers).values({
    id: OWNER,
    name: 'Dev Organizer',
    email: 'dev-organizer@builderhunt.invalid',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing()

  const calendar = await db.transaction(async (tx) => {
    const existing = await tx.execute(
      `select id from user_calendars where organization_id = '${ORG}' and owner_user_id = '${OWNER}' limit 1`,
    ) as unknown as { id: string }[]
    if (existing[0]) return existing[0]
    return insertCalendar(tx, {
      organizationId: ORG, ownerUserId: OWNER, name: 'Dev', timezone: 'Europe/Copenhagen', isDefault: true,
    })
  })

  // Weekdays 09:00-17:00 in Copenhagen, 30-minute slots, no notice period so today is bookable.
  await db.transaction(async (tx) => {
    const header = await upsertAvailabilityPolicyWithVersion(tx, ORG, OWNER, 1, {
      defaultReminderOffsets: [60], defaultReminderChannels: ['email'],
    })
    if (!header) {
      // Already seeded once; the rules below are replaced wholesale either way.
    }
    await replaceAvailabilityPolicy(tx, ORG, OWNER, {
      rules: [{
        timezone: 'Europe/Copenhagen',
        weekdays: [1, 2, 3, 4, 5],
        localStart: '09:00',
        localEnd: '17:00',
        slotMinutes: 30,
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        minNoticeMinutes: 0,
        horizonDays: 60,
        enabled: true,
      }],
      overrides: [],
    })
  })

  const { secret, hash } = issueCapability()
  const invitation = await db.transaction(async (tx) => {
    const row = await insertInvitation(tx, {
      organizationId: ORG,
      ownerUserId: OWNER,
      roleTitle: 'Staff Platform Engineer',
      roleContext: 'You would work on the scheduling and interview-intelligence surface: Postgres, TypeScript, and a lot of care about consent.',
      durationMinutes: 45,
      timezone: 'Europe/Copenhagen',
      modality: 'remote_call',
      meetingUrl: 'https://meet.example.invalid/dev-interview',
      candidateEmailNormalized: 'dev-candidate@builderhunt.invalid',
      capabilityHash: hash,
      policyVersion: '2',
    })
    // draft -> sent, which is the state a candidate's link is issued in.
    return updateInvitationStateWithVersion(tx, ORG, OWNER, row.id, row.version, { status: 'sent' })
  })

  if (!invitation) throw new Error('could not mark the invitation sent')

  const port = process.env.DEV_PORT ?? '3010'
  console.log('\nSeeded invitation')
  console.log(`  calendar:   ${calendar.id}`)
  console.log(`  invitation: ${invitation.id}`)
  console.log(`\nCandidate URL:\n  http://localhost:${port}/schedule/${invitation.id}#capability=${secret}\n`)

  await client.end({ timeout: 5 })
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
