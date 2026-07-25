import { listRecentSessionIps } from '../repositories/auth-sessions-worker'
import { listRecentDeviceHashesAcrossUsers } from '../repositories/user-devices'

/**
 * Linked-account clustering (abuse-and-usage-integrity plan, Phase 3 "Device/ASN sign-up velocity
 * + linked-account clustering"). Clusters accounts that share a device hash or an IP address —
 * ASN is deliberately out of scope here: no IP→ASN resolution capability exists yet in this
 * codebase (would require a new external geo-IP/ASN dependency, a separate decision), matching the
 * same deferral already documented in `anomalies.ts`/`session-hooks.ts`. Read model for admin
 * review only — never influences authorization or enforcement on its own.
 */

export interface AccountIdentifierInput {
  userId: string
  deviceHash?: string | null
  ipAddress?: string | null
}

export interface AccountCluster {
  userIds: string[]
  sharedDeviceHashes: string[]
  sharedIpAddresses: string[]
}

/**
 * Union-find over (userId, identifier) associations: two accounts land in the same cluster if
 * they share ANY device hash or IP, transitively (A~B via a device, B~C via an IP, puts A/B/C in
 * one cluster) — the standard shape for Sybil/multi-accounting detection. Singleton "clusters" (an
 * account that shares nothing with anyone) are dropped; a lone account isn't linked to anything.
 */
export function clusterLinkedAccounts(inputs: AccountIdentifierInput[]): AccountCluster[] {
  const parent = new Map<string, string>()

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x)
    let root = x
    while (parent.get(root)! !== root) root = parent.get(root)!
    let cur = x
    while (parent.get(cur)! !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }

  function union(a: string, b: string): void {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }

  for (const input of inputs) find(input.userId)

  const usersByDevice = new Map<string, Set<string>>()
  const usersByIp = new Map<string, Set<string>>()
  for (const input of inputs) {
    if (input.deviceHash) {
      if (!usersByDevice.has(input.deviceHash)) usersByDevice.set(input.deviceHash, new Set())
      usersByDevice.get(input.deviceHash)!.add(input.userId)
    }
    if (input.ipAddress) {
      if (!usersByIp.has(input.ipAddress)) usersByIp.set(input.ipAddress, new Set())
      usersByIp.get(input.ipAddress)!.add(input.userId)
    }
  }

  for (const users of usersByDevice.values()) {
    const list = [...users]
    for (let i = 1; i < list.length; i++) union(list[0], list[i])
  }
  for (const users of usersByIp.values()) {
    const list = [...users]
    for (let i = 1; i < list.length; i++) union(list[0], list[i])
  }

  const groups = new Map<string, Set<string>>()
  for (const input of inputs) {
    const root = find(input.userId)
    if (!groups.has(root)) groups.set(root, new Set())
    groups.get(root)!.add(input.userId)
  }

  const clusters: AccountCluster[] = []
  for (const userIdSet of groups.values()) {
    if (userIdSet.size < 2) continue
    const sharedDeviceHashes = [...usersByDevice.entries()]
      .filter(([, users]) => [...users].filter((u) => userIdSet.has(u)).length > 1)
      .map(([hash]) => hash)
      .sort()
    const sharedIpAddresses = [...usersByIp.entries()]
      .filter(([, users]) => [...users].filter((u) => userIdSet.has(u)).length > 1)
      .map(([ip]) => ip)
      .sort()
    clusters.push({ userIds: [...userIdSet].sort(), sharedDeviceHashes, sharedIpAddresses })
  }

  return clusters.sort((a, b) => b.userIds.length - a.userIds.length)
}

/**
 * Bridges a user-keyed `AccountCluster` (this file clusters by shared device/IP, not by
 * organization) to the set of organizations its members belong to — the input the G1 promo/trial
 * grant cap (`abuse/credit-abuse.ts`) needs to count grants across a whole identity cluster. Takes
 * the user→organization lookup as a plain `Map` rather than querying it here: resolving every
 * cluster member's organizations is itself a cross-user read with its own RLS shape, left to
 * whatever future promo/trial-issuing feature wires this in for real (see `credit-abuse.ts`'s G1
 * header comment for why this whole feature is unwired today).
 */
export function organizationIdsForCluster(
  cluster: Pick<AccountCluster, 'userIds'>,
  organizationIdsByUser: Map<string, string[]>,
): string[] {
  const organizationIds = new Set<string>()
  for (const userId of cluster.userIds) {
    for (const organizationId of organizationIdsByUser.get(userId) ?? []) {
      organizationIds.add(organizationId)
    }
  }
  return [...organizationIds].sort()
}

export interface FindLinkedAccountClustersDeps {
  listDeviceHashes?: typeof listRecentDeviceHashesAcrossUsers
  listSessionIps?: typeof listRecentSessionIps
}

/** Composes the two cross-user read models into `clusterLinkedAccounts`'s flat input shape. */
export async function findLinkedAccountClusters(
  sinceDate: Date,
  deps: FindLinkedAccountClustersDeps = {},
): Promise<AccountCluster[]> {
  const listDeviceHashes = deps.listDeviceHashes ?? listRecentDeviceHashesAcrossUsers
  const listSessionIps = deps.listSessionIps ?? listRecentSessionIps

  const [devices, sessions] = await Promise.all([
    listDeviceHashes(sinceDate),
    listSessionIps(sinceDate),
  ])

  const inputs: AccountIdentifierInput[] = [
    ...devices.map((device) => ({ userId: device.userId, deviceHash: device.deviceHash })),
    ...sessions.map((session) => ({ userId: session.userId, ipAddress: session.ipAddress })),
  ]

  return clusterLinkedAccounts(inputs)
}
