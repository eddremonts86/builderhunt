import * as React from 'react'
import { Building2, History, Save } from 'lucide-react'
import { Button, Input, Label, Textarea } from '~/components/ui'

interface TaxRegistration {
  country: string
  registrationId: string
  effectiveAt: string
}

interface SellerProfile {
  id: string
  version: number
  legalName: string
  publicBusinessAddress: string
  establishmentCountry: string
  approvedTaxIds: string[]
  supportEmail: string
  statementDescriptor: string
  countryAllowlist: string[]
  taxRegistrations: TaxRegistration[]
  effectiveAt: string
  createdByUserId: string
  createdAt: string
}

interface ConfigurationResponse {
  current: SellerProfile | null
  history: SellerProfile[]
}

interface FormState {
  legalName: string
  publicBusinessAddress: string
  establishmentCountry: string
  approvedTaxIds: string
  supportEmail: string
  statementDescriptor: string
  countryAllowlist: string
  taxRegistrations: string
  effectiveAt: string
}

const EMPTY_FORM: FormState = {
  legalName: '',
  publicBusinessAddress: '',
  establishmentCountry: '',
  approvedTaxIds: '',
  supportEmail: '',
  statementDescriptor: '',
  countryAllowlist: '',
  taxRegistrations: '[]',
  effectiveAt: '',
}

function toFormState(profile: SellerProfile): FormState {
  return {
    legalName: profile.legalName,
    publicBusinessAddress: profile.publicBusinessAddress,
    establishmentCountry: profile.establishmentCountry,
    approvedTaxIds: profile.approvedTaxIds.join(', '),
    supportEmail: profile.supportEmail,
    statementDescriptor: profile.statementDescriptor,
    countryAllowlist: profile.countryAllowlist.join(', '),
    taxRegistrations: JSON.stringify(profile.taxRegistrations, null, 2),
    effectiveAt: profile.effectiveAt.slice(0, 16),
  }
}

/**
 * Platform-admin-only. Every submitted version is a new, insert-only row
 * (`billing_seller_profiles` has no UPDATE grant for any role — see
 * drizzle/0028_billing_rls_grants.sql) — this form always creates the NEXT
 * version, it never edits history in place. `taxRegistrations` is a raw JSON
 * textarea rather than a dynamic row editor: this configuration changes
 * rarely (new country/VAT registration), and a hand-rolled array editor for
 * a 3-field-per-row shape isn't worth the added complexity for an admin-only
 * surface used a handful of times a year.
 */
export function SellerConfiguration() {
  const [current, setCurrent] = React.useState<SellerProfile | null>(null)
  const [history, setHistory] = React.useState<SellerProfile[]>([])
  const [loading, setLoading] = React.useState(true)
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      const res = await fetch('/api/admin/billing/configuration', { credentials: 'include' })
      if (!res.ok) {
        setError(`Failed to load: ${res.status}`)
        return
      }
      const data: ConfigurationResponse = await res.json()
      setCurrent(data.current)
      setHistory(data.history ?? [])
      setForm(data.current ? toFormState(data.current) : EMPTY_FORM)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    load()
  }, [load])

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    let taxRegistrations: TaxRegistration[]
    try {
      taxRegistrations = JSON.parse(form.taxRegistrations)
    } catch {
      setError('Tax registrations must be valid JSON — an array of {country, registrationId, effectiveAt}.')
      return
    }

    setSaving(true)
    try {
      const res = await fetch('/api/admin/billing/configuration', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          legalName: form.legalName,
          publicBusinessAddress: form.publicBusinessAddress,
          establishmentCountry: form.establishmentCountry,
          approvedTaxIds: form.approvedTaxIds.split(',').map((value) => value.trim()).filter(Boolean),
          supportEmail: form.supportEmail,
          statementDescriptor: form.statementDescriptor,
          countryAllowlist: form.countryAllowlist.split(',').map((value) => value.trim()).filter(Boolean),
          taxRegistrations,
          effectiveAt: new Date(form.effectiveAt).toISOString(),
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `Failed: ${res.status}`)
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="text-sm text-bh-text-muted">Loading…</p>

  return (
    <div data-testid="admin-billing-configuration">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Building2 className="w-6 h-6 text-bh-accent" aria-hidden="true" />
          Seller configuration
        </h1>
        <p className="text-sm text-bh-text-muted mt-1">
          Versioned public seller identity and tax registrations. Every save creates a new version —
          prior versions remain readable for historical invoices.
        </p>
      </header>

      {error && (
        <div className="card border-bh-danger/30 bg-bh-danger/5 p-3 mb-4 text-sm text-bh-danger">
          {error}
        </div>
      )}

      <form onSubmit={submit} className="card p-5 mb-6 space-y-3" data-testid="seller-configuration-form">
        <h2 className="font-semibold">
          {current ? `New version (currently v${current.version})` : 'Record the first version'}
        </h2>

        <div>
          <Label htmlFor="legalName" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Legal name</Label>
          <Input id="legalName" value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} className="w-full" required />
        </div>
        <div>
          <Label htmlFor="publicBusinessAddress" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Public business address</Label>
          <Textarea id="publicBusinessAddress" value={form.publicBusinessAddress} onChange={(e) => setForm({ ...form, publicBusinessAddress: e.target.value })} className="w-full" required />
        </div>
        <div>
          <Label htmlFor="establishmentCountry" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Establishment country</Label>
          <Input id="establishmentCountry" value={form.establishmentCountry} onChange={(e) => setForm({ ...form, establishmentCountry: e.target.value })} className="w-full" placeholder="DK" required />
        </div>
        <div>
          <Label htmlFor="approvedTaxIds" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Approved business/VAT IDs (comma-separated)</Label>
          <Input id="approvedTaxIds" value={form.approvedTaxIds} onChange={(e) => setForm({ ...form, approvedTaxIds: e.target.value })} className="w-full" placeholder="DK12345678" />
        </div>
        <div>
          <Label htmlFor="supportEmail" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Support email</Label>
          <Input id="supportEmail" type="email" value={form.supportEmail} onChange={(e) => setForm({ ...form, supportEmail: e.target.value })} className="w-full" required />
        </div>
        <div>
          <Label htmlFor="statementDescriptor" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Statement descriptor (max 22 chars)</Label>
          <Input id="statementDescriptor" value={form.statementDescriptor} onChange={(e) => setForm({ ...form, statementDescriptor: e.target.value })} className="w-full" maxLength={22} required />
        </div>
        <div>
          <Label htmlFor="countryAllowlist" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Production customer-country allowlist (comma-separated)</Label>
          <Input id="countryAllowlist" value={form.countryAllowlist} onChange={(e) => setForm({ ...form, countryAllowlist: e.target.value })} className="w-full" placeholder="DK" />
        </div>
        <div>
          <Label htmlFor="taxRegistrations" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Tax registrations (JSON array of {'{'}country, registrationId, effectiveAt{'}'})</Label>
          <Textarea id="taxRegistrations" value={form.taxRegistrations} onChange={(e) => setForm({ ...form, taxRegistrations: e.target.value })} className="w-full min-h-[100px] font-mono text-xs" />
        </div>
        <div>
          <Label htmlFor="effectiveAt" className="text-xs font-semibold uppercase tracking-wider text-bh-text-dim">Effective at</Label>
          <Input id="effectiveAt" type="datetime-local" value={form.effectiveAt} onChange={(e) => setForm({ ...form, effectiveAt: e.target.value })} className="w-full" required />
        </div>

        <Button type="submit" variant="primary" disabled={saving} data-testid="seller-configuration-save">
          <Save className="w-4 h-4" aria-hidden="true" />
          {saving ? 'Saving…' : 'Save new version'}
        </Button>
      </form>

      <section className="card p-5" data-testid="seller-configuration-history">
        <h2 className="font-semibold flex items-center gap-2 mb-3">
          <History className="w-4 h-4" aria-hidden="true" />
          Version history
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-bh-text-muted">No version recorded yet.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((profile) => (
              <li key={profile.id} className="text-sm border-t border-bh-border pt-2 first:border-t-0 first:pt-0">
                <span className="font-semibold">v{profile.version}</span> — {profile.legalName} ({profile.establishmentCountry})
                <span className="text-bh-text-muted"> · effective {new Date(profile.effectiveAt).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
