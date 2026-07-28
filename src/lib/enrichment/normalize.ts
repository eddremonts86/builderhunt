/**
 * Public Profile Enrichment — deterministic normalization.
 * Spec reference: plans/phase-1/41-stealth-scraping/spec.md §9. Pure functions, no I/O.
 */

const TRACKING_PARAM_PREFIXES = ['utm_', 'ref', 'ref_src', 'igshid', 'fbclid', 'gclid', 'mc_cid', 'mc_eid']

const LEGAL_SUFFIX_DICTIONARY: Array<[RegExp, string]> = [
  [/\binc\.?$/i, 'inc'],
  [/\bincorporated$/i, 'inc'],
  [/\bllc\.?$/i, 'llc'],
  [/\bltd\.?$/i, 'ltd'],
  [/\blimited$/i, 'ltd'],
  [/\bgmbh$/i, 'gmbh'],
  [/\bcorp\.?$/i, 'corp'],
  [/\bcorporation$/i, 'corp'],
  [/\bco\.?$/i, 'co'],
  [/\bcompany$/i, 'co'],
  [/\bs\.a\.?$/i, 'sa'],
  [/\bplc$/i, 'plc'],
]

function nfkcTrim(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

export function normalizeUsername(input: string | null | undefined): string {
  if (!input) return ''
  return nfkcTrim(input).replace(/^@/, '').toLowerCase()
}

export function normalizeFullName(input: string | null | undefined): string {
  if (!input) return ''
  return nfkcTrim(input).toLowerCase()
}

export function normalizeUrl(input: string | null | undefined): string {
  if (!input) return ''
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return ''
  }
  const host = url.hostname.toLowerCase()
  const params = new URLSearchParams(url.search)
  for (const key of Array.from(params.keys())) {
    if (TRACKING_PARAM_PREFIXES.some((prefix) => key.toLowerCase().startsWith(prefix))) {
      params.delete(key)
    }
  }
  const search = params.toString()
  const path = url.pathname.replace(/\/+$/, '') || '/'
  return `https://${host}${path}${search ? `?${search}` : ''}`
}

export function normalizeOrganization(input: string | null | undefined): string {
  if (!input) return ''
  let value = nfkcTrim(input).toLowerCase().replace(/[.,]/g, '')
  for (const [pattern, canonical] of LEGAL_SUFFIX_DICTIONARY) {
    if (pattern.test(value)) {
      value = value.replace(pattern, '').trim()
      value = value ? `${value} ${canonical}` : canonical
      break
    }
  }
  return value.trim()
}

/** Compares coarse country/region only — never geocodes an exact address (spec §9). */
export function normalizeLocation(input: string | null | undefined): string {
  if (!input) return ''
  return nfkcTrim(input).toLowerCase().replace(/[.,]/g, '')
}

export function normalizeTopic(input: string): string {
  return nfkcTrim(input).toLowerCase()
}
