import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDisposableTestDatabase } from '~/shared/lib/db/create-disposable-test-database'
import { authUsers, organizations } from '~/shared/lib/db/schema'
import { getSeatUsage } from '~/shared/lib/repositories/seat-usage'
import {
  checkConcurrentDistinctIpAndEmit,
  checkCrossTenantDenialAndEmit,
  checkImpossibleTravelAndEmit,
  checkMidSessionUaChangeAndEmit,
  checkSeatOveruseAndEmit,
  detectConcurrentDistinctIp,
  detectDenialCluster,
  detectImpossibleTravel,
  detectMidSessionUaChange,
  detectSeatOveruse,
  isAllowlistedAsn,
  meterSeatActionAndEmit,
} from '~/shared/lib/abuse/anomalies'

const NYC = { lat: 40.7128, lng: -74.006 }
const LONDON = { lat: 51.5074, lng: -0.1278 }
const NEWARK_NJ = { lat: 40.7357, lng: -74.1724 } // ~13km from NYC — same metro area

describe('detectImpossibleTravel', () => {
  it('does not flag the same location at any elapsed time', () => {
    const at = new Date('2026-01-01T00:00:00Z')
    expect(detectImpossibleTravel({ previous: { ...NYC, at }, current: { ...NYC, at } })).toBe(false)
    expect(detectImpossibleTravel({
      previous: { ...NYC, at: new Date('2026-01-01T00:00:00Z') },
      current: { ...NYC, at: new Date('2026-01-01T00:00:01Z') },
    })).toBe(false)
  })

  it('flags NYC to London in 1 hour (impossible — no flight is that fast)', () => {
    const flagged = detectImpossibleTravel({
      previous: { ...NYC, at: new Date('2026-01-01T00:00:00Z') },
      current: { ...LONDON, at: new Date('2026-01-01T01:00:00Z') },
    })
    expect(flagged).toBe(true)
  })

  it('does not flag NYC to London across a realistic 8-hour flight', () => {
    const flagged = detectImpossibleTravel({
      previous: { ...NYC, at: new Date('2026-01-01T00:00:00Z') },
      current: { ...LONDON, at: new Date('2026-01-01T08:00:00Z') },
    })
    expect(flagged).toBe(false)
  })

  it('does not flag a short local hop (NAT/roaming within a metro area) given a plausible commute time', () => {
    const flagged = detectImpossibleTravel({
      previous: { ...NYC, at: new Date('2026-01-01T00:00:00Z') },
      current: { ...NEWARK_NJ, at: new Date('2026-01-01T00:05:00Z') },
    })
    expect(flagged).toBe(false)
  })

  it('flags simultaneous logins from two distant locations (elapsed time is zero)', () => {
    const at = new Date('2026-01-01T00:00:00Z')
    expect(detectImpossibleTravel({ previous: { ...NYC, at }, current: { ...LONDON, at } })).toBe(true)
  })

  it('respects a custom maxPlausibleSpeedKmh override', () => {
    const input = {
      previous: { ...NYC, at: new Date('2026-01-01T00:00:00Z') },
      current: { ...LONDON, at: new Date('2026-01-01T08:00:00Z') },
    }
    // ~5570km / 8h ≈ 696 km/h — flagged only once the bound drops below that
    expect(detectImpossibleTravel({ ...input, maxPlausibleSpeedKmh: 500 })).toBe(true)
    expect(detectImpossibleTravel({ ...input, maxPlausibleSpeedKmh: 1000 })).toBe(false)
  })
})

describe('detectMidSessionUaChange', () => {
  it.each([
    ['chrome', 'firefox', true],
    ['chrome', 'chrome', false],
    [null, 'chrome', false],
    ['chrome', null, false],
    ['unknown', 'chrome', false],
    ['chrome', 'unknown', false],
    [undefined, undefined, false],
  ] as const)('detectMidSessionUaChange(%s, %s) -> %s', (original, current, expected) => {
    expect(detectMidSessionUaChange(original, current)).toBe(expected)
  })
})

describe('detectConcurrentDistinctIp', () => {
  it('does not flag a single distinct identifier shared across sessions (NAT: many users, one corporate egress)', () => {
    expect(detectConcurrentDistinctIp(['asn-1', 'asn-1', 'asn-1'])).toBe(false)
  })

  it('flags two or more distinct identifiers', () => {
    expect(detectConcurrentDistinctIp(['asn-1', 'asn-2'])).toBe(true)
  })

  it('ignores unresolved (null/undefined) identifiers', () => {
    expect(detectConcurrentDistinctIp([null, undefined, 'asn-1'])).toBe(false)
  })

  it('does not flag an empty or single-entry list', () => {
    expect(detectConcurrentDistinctIp([])).toBe(false)
    expect(detectConcurrentDistinctIp(['asn-1'])).toBe(false)
  })
})

describe('detectSeatOveruse', () => {
  it.each([
    [10, 20, false],
    [20, 20, false],
    [21, 20, true],
  ])('detectSeatOveruse(count=%d, cap=%d) -> %s', (count, cap, expected) => {
    expect(detectSeatOveruse({ count, cap })).toBe(expected)
  })
})

describe('isAllowlistedAsn', () => {
  it('matches an ASN present in the comma-separated allowlist', () => {
    expect(isAllowlistedAsn('AS15169', 'AS15169,AS8075')).toBe(true)
  })

  it('does not match an ASN absent from the allowlist', () => {
    expect(isAllowlistedAsn('AS64512', 'AS15169,AS8075')).toBe(false)
  })

  it('tolerates whitespace around entries', () => {
    expect(isAllowlistedAsn('AS8075', ' AS15169 , AS8075 ')).toBe(true)
  })

  it('never matches a null/undefined ASN, even against an empty allowlist', () => {
    expect(isAllowlistedAsn(null, '')).toBe(false)
    expect(isAllowlistedAsn(undefined, 'AS15169')).toBe(false)
  })

  it('treats an empty allowlist as matching nothing', () => {
    expect(isAllowlistedAsn('AS15169', '')).toBe(false)
  })
})

describe('detectDenialCluster', () => {
  it.each([
    [{ allowed: true }, false],
    [{ allowed: false }, true],
  ])('detectDenialCluster(%o) -> %s', (gateResult, expected) => {
    expect(detectDenialCluster(gateResult)).toBe(expected)
  })
})

describe('check*AndEmit wrappers', () => {
  it('checkImpossibleTravelAndEmit suppresses emission for an allowlisted ASN (VPN provider) even when travel is impossible', async () => {
    const sink = { write: vi.fn() }
    const insert = vi.fn()
    const flagged = await checkImpossibleTravelAndEmit(
      { previous: { ...NYC, at: new Date('2026-01-01T00:00:00Z') }, current: { ...LONDON, at: new Date('2026-01-01T01:00:00Z') } },
      { userId: 'user-1', requestId: 'req-1' },
      'AS-VPN-TRUSTED',
      'AS-VPN-TRUSTED',
      { sink, insert },
    )
    expect(flagged).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('checkImpossibleTravelAndEmit emits when travel is impossible and the ASN is not allowlisted', async () => {
    const sink = { write: vi.fn() }
    const insert = vi.fn()
    const flagged = await checkImpossibleTravelAndEmit(
      { previous: { ...NYC, at: new Date('2026-01-01T00:00:00Z') }, current: { ...LONDON, at: new Date('2026-01-01T01:00:00Z') } },
      { userId: 'user-1', requestId: 'req-1' },
      'AS-UNKNOWN',
      'AS-VPN-TRUSTED',
      { sink, insert },
    )
    expect(flagged).toBe(true)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ type: 'impossible_travel', severity: 'high', userId: 'user-1' }))
  })

  it('checkMidSessionUaChangeAndEmit emits on a genuine change', async () => {
    const insert = vi.fn()
    const flagged = await checkMidSessionUaChangeAndEmit('chrome', 'firefox', { userId: 'user-1', requestId: 'req-1' }, { insert, sink: { write: vi.fn() } })
    expect(flagged).toBe(true)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ type: 'ua_change' }))
  })

  it('checkConcurrentDistinctIpAndEmit ignores allowlisted identifiers before checking distinctness', async () => {
    const insert = vi.fn()
    const flagged = await checkConcurrentDistinctIpAndEmit(
      ['AS-TRUSTED', 'AS-TRUSTED', 'asn-real'],
      { userId: 'user-1', requestId: 'req-1' },
      'AS-TRUSTED',
      { insert, sink: { write: vi.fn() } },
    )
    // one non-allowlisted distinct identifier remains -> not >1 distinct -> not flagged
    expect(flagged).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('checkSeatOveruseAndEmit emits with the action name in details', async () => {
    const insert = vi.fn()
    const flagged = await checkSeatOveruseAndEmit(
      { count: 250, cap: 200, action: 'searches' },
      { userId: 'user-1', requestId: 'req-1' },
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(true)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ type: 'seat_overuse', details: expect.objectContaining({ action: 'searches' }) }))
  })

  it('checkCrossTenantDenialAndEmit does not emit while the denial-cluster gate still allows (below threshold)', async () => {
    const insert = vi.fn()
    const gate = { gate: vi.fn().mockResolvedValue({ allowed: true }) }
    const flagged = await checkCrossTenantDenialAndEmit(
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      gate,
      { insert, sink: { write: vi.fn() } },
    )
    expect(gate.gate).toHaveBeenCalledWith('user-1')
    expect(flagged).toBe(false)
    expect(insert).not.toHaveBeenCalled()
  })

  it('checkCrossTenantDenialAndEmit emits cross_tenant_denied once the gate reports the cluster threshold exceeded', async () => {
    const insert = vi.fn()
    const gate = { gate: vi.fn().mockResolvedValue({ allowed: false }) }
    const flagged = await checkCrossTenantDenialAndEmit(
      { userId: 'user-1', organizationId: 'org-1', requestId: 'req-1' },
      gate,
      { insert, sink: { write: vi.fn() } },
    )
    expect(flagged).toBe(true)
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ type: 'cross_tenant_denied', severity: 'medium', userId: 'user-1', organizationId: 'org-1' }))
  })
})

describe('meterSeatActionAndEmit', () => {
  let db: PostgresJsDatabase
  let drop: () => Promise<void>

  beforeAll(async () => {
    const disposable = await createDisposableTestDatabase('abuse_meter_seat')
    db = disposable.db
    drop = disposable.drop
    await db.insert(organizations).values([
      { id: 'meter-org-a', name: 'A', slug: 'meter-org-a', createdAt: new Date() },
    ])
    await db.insert(authUsers).values([
      { id: 'meter-user-a', name: 'A', email: 'meter-a@test.invalid', emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    ])
  }, 60_000)

  afterAll(async () => {
    await drop()
  })

  it('increments the real seat_usage_daily counter and does not emit while under the cap', async () => {
    const insert = vi.fn()
    const record = await db.transaction((tx) => meterSeatActionAndEmit(tx, {
      organizationId: 'meter-org-a',
      userId: 'meter-user-a',
      action: 'searches',
      cap: 5,
      requestId: 'req-meter-1',
    }, { insert, sink: { write: vi.fn() } }))

    expect(record.count).toBe(1)
    expect(insert).not.toHaveBeenCalled()

    const today = new Date().toISOString().slice(0, 10)
    const stored = await db.transaction((tx) => getSeatUsage(tx, 'meter-org-a', 'meter-user-a', today, 'searches'))
    expect(stored?.count).toBe(1)
  })

  it('emits seat_overuse once accumulated real usage exceeds the cap', async () => {
    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    for (let i = 1; i <= 3; i++) {
      await db.transaction((tx) => meterSeatActionAndEmit(tx, {
        organizationId: 'meter-org-a',
        userId: 'meter-user-a',
        action: 'exports',
        cap: 2,
        requestId: `req-meter-${i}`,
      }, deps))
    }

    expect(insert).toHaveBeenCalledTimes(1) // only the 3rd call (count=3 > cap=2) flags
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      type: 'seat_overuse',
      details: expect.objectContaining({ action: 'exports', count: 3, cap: 2 }),
    }))
  })

  it('tracks distinct actions for the same org/user/day independently', async () => {
    const insert = vi.fn()
    const deps = { insert, sink: { write: vi.fn() } }
    await db.transaction((tx) => meterSeatActionAndEmit(tx, {
      organizationId: 'meter-org-a',
      userId: 'meter-user-a',
      action: 'reveals',
      cap: 100,
      requestId: 'req-meter-reveals',
    }, deps))
    await db.transaction((tx) => meterSeatActionAndEmit(tx, {
      organizationId: 'meter-org-a',
      userId: 'meter-user-a',
      action: 'messages',
      cap: 100,
      requestId: 'req-meter-messages',
    }, deps))

    const today = new Date().toISOString().slice(0, 10)
    const reveals = await db.transaction((tx) => getSeatUsage(tx, 'meter-org-a', 'meter-user-a', today, 'reveals'))
    const messages = await db.transaction((tx) => getSeatUsage(tx, 'meter-org-a', 'meter-user-a', today, 'messages'))
    expect(reveals?.count).toBe(1)
    expect(messages?.count).toBe(1)
  })
})
