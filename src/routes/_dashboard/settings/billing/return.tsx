import { createFileRoute } from '@tanstack/react-router'
import { CheckoutReturn } from '~/modules/billing/CheckoutReturn'

export const Route = createFileRoute('/_dashboard/settings/billing/return')({
  // Auth is enforced by the parent layout (settings/billing.tsx).
  component: CheckoutReturn,
})
