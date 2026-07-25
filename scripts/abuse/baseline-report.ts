/**
 * Observe-window baseline report (abuse-and-usage-integrity Phase 6 task 1).
 *
 * Read-only. Queries `user_devices`, `auth_sessions`, `seat_usage_daily`, `abuse_signals`,
 * `session_signals`, and `account_risk` for real per-tier medians while `ABUSE_ENFORCEMENT_MODE`
 * is still `observe` — this data is what Phase 6's "Staged enforce rollout" task should use to
 * pick real threshold values before flipping enforcement on for real, rather than trusting the
 * placeholder defaults in `env.ts` (`SESSION_MAX_CONCURRENT_*`, `SEAT_DAILY_*`, etc.), which were
 * never calibrated against production usage.
 *
 * `user_devices`/`account_risk`/`seat_usage_daily` are RLS-protected, scoped to a single
 * `app.user_id`/`app.organization_id` per transaction — an unscoped connection sees zero rows, not
 * all rows (see drizzle/0044's policies). A genuine cross-user/cross-org aggregate therefore needs
 * `DATABASE_MIGRATION_URL` (the real Postgres superuser), the same connection
 * `scripts/db/backfills/organizations.ts` uses for its cross-tenant backfill — this script only
 * reads, never writes.
 *
 * Usage:
 *   pnpm abuse:baseline-report                    # 30-day window
 *   pnpm abuse:baseline-report --window-days=90
 */
import postgres from 'postgres'

function parseWindowDays(argv: string[]): number {
  const flag = argv.find((arg) => arg.startsWith('--window-days='))
  const value = Number(flag?.split('=')[1] ?? 30)
  return Number.isSafeInteger(value) && value > 0 && value <= 365 ? value : 30
}

const windowDays = parseWindowDays(process.argv)

const connectionUrl = process.env.DATABASE_MIGRATION_URL
  ?? (process.env.NODE_ENV === 'production' ? undefined : process.env.DATABASE_URL)
if (!connectionUrl) throw new Error('DATABASE_MIGRATION_URL is required')

const sql = postgres(connectionUrl, { max: 1, prepare: false })

interface TierMedianRow {
  tier: string
  median_devices: string | null
  user_count: string
}

interface TierIpRow {
  tier: string
  median_distinct_ips: string | null
  user_count: string
}

interface SeatActionRow {
  tier: string
  action: string
  median_count: string | null
  p95_count: string | null
  row_count: string
}

interface SignalTypeRow {
  type: string
  severity: string
  signal_count: string
}

interface StageRow {
  stage: string
  account_count: string
}

interface SessionFlagRow {
  total: string
  concurrent_distinct_ip_count: string
  impossible_travel_count: string
  mid_session_ua_change_count: string
  new_device_count: string
}

async function main() {
  const [
    deviceMedians,
    ipMedians,
    seatActionMedians,
    signalCounts,
    stageDistribution,
    sessionFlagRates,
  ] = await Promise.all([
    sql<TierMedianRow[]>`
      with user_tier as (
        select
          au.id as user_id,
          coalesce((
            select oe.tier
            from organization_members om
            join organization_entitlements oe on oe.organization_id = om.organization_id
            where om.user_id = au.id
            order by om.created_at asc
            limit 1
          ), 'free') as tier
        from auth_users au
      ),
      device_counts as (
        select user_id, count(*) as device_count from user_devices group by user_id
      )
      select
        ut.tier,
        percentile_cont(0.5) within group (order by coalesce(dc.device_count, 0)) as median_devices,
        count(*) as user_count
      from user_tier ut
      left join device_counts dc on dc.user_id = ut.user_id
      group by ut.tier
      order by ut.tier
    `,
    sql<TierIpRow[]>`
      with sess as (
        select user_id, active_organization_id, ip_address
        from auth_sessions
        where created_at >= now() - (${windowDays}::text || ' days')::interval
          and ip_address is not null
      ),
      tiered as (
        select
          s.user_id,
          coalesce(oe.tier, 'free') as tier,
          count(distinct s.ip_address) as distinct_ips
        from sess s
        left join organization_entitlements oe on oe.organization_id = s.active_organization_id
        group by s.user_id, oe.tier
      )
      select
        tier,
        percentile_cont(0.5) within group (order by distinct_ips) as median_distinct_ips,
        count(*) as user_count
      from tiered
      group by tier
      order by tier
    `,
    sql<SeatActionRow[]>`
      select
        oe.tier,
        sud.action,
        percentile_cont(0.5) within group (order by sud.count) as median_count,
        percentile_cont(0.95) within group (order by sud.count) as p95_count,
        count(*) as row_count
      from seat_usage_daily sud
      join organization_entitlements oe on oe.organization_id = sud.organization_id
      where sud.day >= to_char(now() - (${windowDays}::text || ' days')::interval, 'YYYY-MM-DD')
      group by oe.tier, sud.action
      order by oe.tier, sud.action
    `,
    sql<SignalTypeRow[]>`
      select type, severity, count(*) as signal_count
      from abuse_signals
      where created_at >= now() - (${windowDays}::text || ' days')::interval
      group by type, severity
      order by signal_count desc
    `,
    sql<StageRow[]>`
      select stage, count(*) as account_count
      from account_risk
      group by stage
      order by stage
    `,
    sql<SessionFlagRow[]>`
      select
        count(*) as total,
        sum(case when concurrent_distinct_ip then 1 else 0 end) as concurrent_distinct_ip_count,
        sum(case when impossible_travel then 1 else 0 end) as impossible_travel_count,
        sum(case when mid_session_ua_change then 1 else 0 end) as mid_session_ua_change_count,
        sum(case when new_device then 1 else 0 end) as new_device_count
      from session_signals
      where created_at >= now() - (${windowDays}::text || ' days')::interval
    `,
  ])

  console.log(JSON.stringify({
    windowDays,
    deviceMediansByTier: deviceMedians,
    distinctIpMediansByTier: ipMedians,
    seatActionMediansByTier: seatActionMedians,
    abuseSignalCounts: signalCounts,
    accountRiskStageDistribution: stageDistribution,
    sessionSignalFlagRates: sessionFlagRates[0] ?? null,
    asnAllowlist: {
      populated: false,
      reason: 'No IP→ASN resolution capability exists in this codebase (no geo-IP dependency installed) — ABUSE_ALLOWLIST_ASNS cannot be populated with real data yet. Adding ASN-based allowlisting requires a separate decision to add a geo-IP/ASN dependency first.',
    },
  }, null, 2))
}

main()
  .catch((err) => {
    console.error('❌  baseline-report failed:', err)
    process.exitCode = 1
  })
  .finally(() => sql.end({ timeout: 5 }))
