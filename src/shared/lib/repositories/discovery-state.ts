// Read-only accessor for the proactive-discovery worker's cursor/stats row
// (plan: proactive-discovery). Global, non-tenant table — read via
// `publicDb`, never `withTenantContext`.
import { eq } from 'drizzle-orm'
import { publicDb } from '../db/client'
import { discoveryState } from '../db/schema'

export async function getDiscoveryState() {
  const [row] = await publicDb.select().from(discoveryState).where(eq(discoveryState.id, 'default')).limit(1)
  return row ?? null
}
