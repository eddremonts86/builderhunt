import { createFileRoute } from '@tanstack/react-router'
import { methodNotAllowed } from '~/shared/lib/http/method-not-allowed'
import { platformAdminErrorResponse, requirePlatformAdminPrincipal } from '~/shared/lib/auth/platform-admin'
import { getAccountingExport, type AccountingExportResult } from '~/shared/lib/billing/accounting-export'

/**
 * Monthly accounting and margin export (plans/phase-1/30-stripe-billing-platform/tasks.md §10 "Create
 * accounting and margin export"). Platform-admin only, read-only — no per-organization detail, no
 * bank/payout credentials (this app never even receives any), no raw payloads. `?month=YYYY-MM`
 * selects a specific UTC calendar month (defaults to the previous full month); `?format=csv` returns
 * a flat metric/value/unit/note table instead of the nested JSON shape, for spreadsheet import.
 */
function parseMonthParam(month: string | null): { windowStart: Date; windowEnd: Date } | null {
  if (!month) return null
  const match = /^(\d{4})-(\d{2})$/.exec(month)
  if (!match) return null
  const year = Number(match[1])
  const monthIndex = Number(match[2]) - 1
  return {
    windowStart: new Date(Date.UTC(year, monthIndex, 1)),
    windowEnd: new Date(Date.UTC(year, monthIndex + 1, 1)),
  }
}

function csvRow(cells: Array<string | number>): string {
  return cells.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',') + '\n'
}

function toCsv(result: AccountingExportResult): string {
  let csv = csvRow(['metric', 'value', 'unit', 'note'])
  csv += csvRow(['window_start', result.windowStart, '', ''])
  csv += csvRow(['window_end', result.windowEnd, '', ''])
  csv += csvRow(['organizations_scanned', result.organizationsScanned, 'count', ''])
  csv += csvRow(['gross_revenue_subscription', result.grossRevenue.subscriptionCents, 'usd_cents', `basis: ${result.grossRevenue.basis}, count: ${result.grossRevenue.subscriptionCount}`])
  csv += csvRow(['gross_revenue_pack', result.grossRevenue.packCents, 'usd_cents', `basis: ${result.grossRevenue.basis}, count: ${result.grossRevenue.packCount}`])
  csv += csvRow(['gross_revenue_total', result.grossRevenue.totalCents, 'usd_cents', ''])
  csv += csvRow(['discounts', 'unavailable', '', result.discounts.reason])
  csv += csvRow(['tax', 'unavailable', '', result.tax.reason])
  csv += csvRow(['refunds', result.refunds.amountCents, 'usd_cents', `count: ${result.refunds.count}`])
  csv += csvRow(['disputes', result.disputes.amountCents, 'usd_cents', `count: ${result.disputes.count}; ${result.disputes.scopeNote}`])
  csv += csvRow(['stripe_fees', 'unavailable', '', result.stripeFees.reason])
  csv += csvRow(['payout', 'unavailable', '', result.payout.reason])
  csv += csvRow(['outstanding_invoices', 'unavailable', '', result.outstandingInvoices.reason])
  csv += csvRow(['unexpired_credit_liability', result.unexpiredCreditLiability.units, 'credit_units', ''])
  csv += csvRow(['provider_cost_by_tier_feature', 'unavailable', '', result.providerCostByTierFeature.reason])
  return csv
}

export const Route = createFileRoute('/api/admin/billing/accounting-export')({
  component: () => null,
  server: {
    handlers: {
      // Every other method answers 405, not a 200 HTML page. See http/method-not-allowed.ts.
      ANY: methodNotAllowed(['GET']),

      GET: async ({ request }) => {
        try {
          await requirePlatformAdminPrincipal(request)
          const url = new URL(request.url)
          const window = parseMonthParam(url.searchParams.get('month'))
          const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json'

          const result = await getAccountingExport(window ? { windowStart: window.windowStart, windowEnd: window.windowEnd } : {})

          if (format === 'csv') {
            return new Response(toCsv(result), { headers: { 'content-type': 'text/csv; charset=utf-8' } })
          }
          return Response.json(result)
        } catch (err) {
          const response = platformAdminErrorResponse(err)
          if (response) return response
          console.error('admin accounting export error:', err)
          return Response.json({ error: 'Failed to generate accounting export' }, { status: 500 })
        }
      },
    },
  },
})
