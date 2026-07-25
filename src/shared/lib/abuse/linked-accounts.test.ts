import { describe, expect, it, vi } from 'vitest'
import { clusterLinkedAccounts, findLinkedAccountClusters, organizationIdsForCluster, type AccountIdentifierInput } from './linked-accounts'

describe('clusterLinkedAccounts', () => {
  it('returns no clusters for an empty input', () => {
    expect(clusterLinkedAccounts([])).toEqual([])
  })

  it('does not cluster a lone account that shares nothing with anyone', () => {
    const inputs: AccountIdentifierInput[] = [
      { userId: 'user-1', deviceHash: 'device-a' },
    ]
    expect(clusterLinkedAccounts(inputs)).toEqual([])
  })

  it('does not cluster two accounts with entirely distinct identifiers', () => {
    const inputs: AccountIdentifierInput[] = [
      { userId: 'user-1', deviceHash: 'device-a', ipAddress: '1.1.1.1' },
      { userId: 'user-2', deviceHash: 'device-b', ipAddress: '2.2.2.2' },
    ]
    expect(clusterLinkedAccounts(inputs)).toEqual([])
  })

  it('clusters two accounts sharing a device hash', () => {
    const inputs: AccountIdentifierInput[] = [
      { userId: 'user-1', deviceHash: 'device-shared' },
      { userId: 'user-2', deviceHash: 'device-shared' },
    ]
    const clusters = clusterLinkedAccounts(inputs)
    expect(clusters).toEqual([
      { userIds: ['user-1', 'user-2'], sharedDeviceHashes: ['device-shared'], sharedIpAddresses: [] },
    ])
  })

  it('clusters two accounts sharing only an IP address', () => {
    const inputs: AccountIdentifierInput[] = [
      { userId: 'user-1', ipAddress: '9.9.9.9' },
      { userId: 'user-2', ipAddress: '9.9.9.9' },
    ]
    const clusters = clusterLinkedAccounts(inputs)
    expect(clusters).toEqual([
      { userIds: ['user-1', 'user-2'], sharedDeviceHashes: [], sharedIpAddresses: ['9.9.9.9'] },
    ])
  })

  it('transitively clusters three accounts linked through different identifiers (A~B via device, B~C via IP)', () => {
    const inputs: AccountIdentifierInput[] = [
      { userId: 'user-a', deviceHash: 'device-1' },
      { userId: 'user-b', deviceHash: 'device-1' },
      { userId: 'user-b', ipAddress: '5.5.5.5' },
      { userId: 'user-c', ipAddress: '5.5.5.5' },
    ]
    const clusters = clusterLinkedAccounts(inputs)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].userIds).toEqual(['user-a', 'user-b', 'user-c'])
  })

  it('does not merge two independent clusters that share nothing with each other', () => {
    const inputs: AccountIdentifierInput[] = [
      { userId: 'user-1', deviceHash: 'device-x' },
      { userId: 'user-2', deviceHash: 'device-x' },
      { userId: 'user-3', ipAddress: '8.8.8.8' },
      { userId: 'user-4', ipAddress: '8.8.8.8' },
    ]
    const clusters = clusterLinkedAccounts(inputs)
    expect(clusters).toHaveLength(2)
    const userIdSets = clusters.map((c) => c.userIds).sort()
    expect(userIdSets).toEqual([['user-1', 'user-2'], ['user-3', 'user-4']])
  })

  it('ignores null/undefined identifiers rather than treating them as a shared value', () => {
    const inputs: AccountIdentifierInput[] = [
      { userId: 'user-1', deviceHash: null, ipAddress: undefined },
      { userId: 'user-2', deviceHash: null, ipAddress: undefined },
    ]
    expect(clusterLinkedAccounts(inputs)).toEqual([])
  })

  it('reports a shared identifier only when 2+ users in the final cluster actually share it', () => {
    // user-3 shares device-1 with user-1/user-2, but device-2 is unique to user-1 alone.
    const inputs: AccountIdentifierInput[] = [
      { userId: 'user-1', deviceHash: 'device-1' },
      { userId: 'user-1', deviceHash: 'device-2' },
      { userId: 'user-2', deviceHash: 'device-1' },
    ]
    const clusters = clusterLinkedAccounts(inputs)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].sharedDeviceHashes).toEqual(['device-1'])
  })

  it('sorts clusters by size, largest first', () => {
    const inputs: AccountIdentifierInput[] = [
      { userId: 'pair-1', deviceHash: 'device-pair' },
      { userId: 'pair-2', deviceHash: 'device-pair' },
      { userId: 'trio-1', ipAddress: '3.3.3.3' },
      { userId: 'trio-2', ipAddress: '3.3.3.3' },
      { userId: 'trio-3', ipAddress: '3.3.3.3' },
    ]
    const clusters = clusterLinkedAccounts(inputs)
    expect(clusters.map((c) => c.userIds.length)).toEqual([3, 2])
  })
})

describe('findLinkedAccountClusters', () => {
  it('composes device-hash and session-IP read models into one flat clustering input', async () => {
    const listDeviceHashes = vi.fn().mockResolvedValue([
      { id: 'd1', userId: 'user-1', deviceHash: 'shared-device', uaFamily: 'chrome', firstSeenAt: new Date(), lastSeenAt: new Date(), lastIpAsn: null, lastCountry: null, trustState: 'new' },
      { id: 'd2', userId: 'user-2', deviceHash: 'shared-device', uaFamily: 'chrome', firstSeenAt: new Date(), lastSeenAt: new Date(), lastIpAsn: null, lastCountry: null, trustState: 'new' },
    ])
    const listSessionIps = vi.fn().mockResolvedValue([])
    const sinceDate = new Date('2026-01-01T00:00:00Z')

    const clusters = await findLinkedAccountClusters(sinceDate, { listDeviceHashes, listSessionIps })

    expect(listDeviceHashes).toHaveBeenCalledWith(sinceDate)
    expect(listSessionIps).toHaveBeenCalledWith(sinceDate)
    expect(clusters).toEqual([
      { userIds: ['user-1', 'user-2'], sharedDeviceHashes: ['shared-device'], sharedIpAddresses: [] },
    ])
  })
})

describe('organizationIdsForCluster', () => {
  it('returns an empty list when no cluster member maps to an organization', () => {
    const result = organizationIdsForCluster({ userIds: ['user-1', 'user-2'] }, new Map())
    expect(result).toEqual([])
  })

  it('dedupes and sorts organization ids across every cluster member', () => {
    const lookup = new Map([
      ['user-1', ['org-b', 'org-a']],
      ['user-2', ['org-a']],
      ['user-3', ['org-c']],
    ])
    const result = organizationIdsForCluster({ userIds: ['user-1', 'user-2', 'user-3'] }, lookup)
    expect(result).toEqual(['org-a', 'org-b', 'org-c'])
  })

  it('ignores a cluster member absent from the lookup map', () => {
    const lookup = new Map([['user-1', ['org-a']]])
    const result = organizationIdsForCluster({ userIds: ['user-1', 'user-unknown'] }, lookup)
    expect(result).toEqual(['org-a'])
  })
})
