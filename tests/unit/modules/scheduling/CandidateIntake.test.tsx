/**
 * The assertions that matter here are about what the UI *refuses* to offer.
 *
 * A blocked platform must not get an import control, and an unattested site must not get an enabled
 * one. Both are enforced server-side too — that is where the real boundary is — but a UI that offers
 * a button the server will refuse teaches candidates that the product is broken, and a UI that offers
 * an import for LinkedIn implies we will do something we must not.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CandidateIntake, type CandidateLinkView } from '~/modules/scheduling/components/CandidateIntake'
import type { CandidateDocumentView } from '~/modules/scheduling/components/DocumentUploader'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
  vi.unstubAllGlobals()
})

const ATTESTATION_VERSION = '2026-07-28.1'

function render(props: {
  links?: CandidateLinkView[]
  documents?: CandidateDocumentView[]
}) {
  act(() => {
    root?.render(
      <CandidateIntake
        invitationId="inv-1"
        attestationVersion={ATTESTATION_VERSION}
        documents={props.documents ?? []}
        links={props.links ?? []}
        onChanged={() => undefined}
      />,
    )
  })
}

const link = (overrides: Partial<CandidateLinkView> = {}): CandidateLinkView => ({
  id: 'link-1',
  url: 'https://someone.dev/',
  policyDecision: 'authorized_crawl',
  importState: 'not_requested',
  attested: false,
  ...overrides,
})

const text = () => container?.textContent ?? ''
const buttons = () => [...(container?.querySelectorAll('button') ?? [])]
const checkboxes = () => [...(container?.querySelectorAll('[role="checkbox"], input[type="checkbox"]') ?? [])]

describe('a platform we may not fetch', () => {
  it('offers no import control and explains whose restriction it is', () => {
    render({ links: [link({ url: 'https://linkedin.com/in/someone', policyDecision: 'user_submitted' })] })

    expect(buttons().some((button) => /import this site/i.test(button.textContent ?? ''))).toBe(false)
    expect(checkboxes()).toHaveLength(0)
    // Named as the platform's terms rather than as our refusal, so it does not read as a judgement
    // about the candidate.
    expect(text()).toMatch(/terms do not allow us to read it automatically/i)
    expect(text()).toMatch(/your permission cannot change that/i)
  })

  it('still shows the link, because it is evidence someone can open', () => {
    render({ links: [link({ url: 'https://linkedin.com/in/someone', policyDecision: 'user_submitted' })] })
    const anchor = container?.querySelector('a[href="https://linkedin.com/in/someone"]')
    expect(anchor).not.toBeNull()
    // The destination must learn nothing about a page that names one person interviewing at one company.
    expect(anchor?.getAttribute('rel')).toContain('noreferrer')
  })
})

describe('a site the candidate can attest to', () => {
  it('keeps the import disabled until the box is ticked', () => {
    render({ links: [link()] })

    const importButton = buttons().find((button) => /import this site/i.test(button.textContent ?? ''))
    expect(importButton).toBeDefined()
    // Unticked by default, and the control it gates is unusable — spec.md requires "a separate,
    // unticked, versioned consent".
    expect(importButton?.hasAttribute('disabled')).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends the version the candidate was shown, not one the client invented', async () => {
    render({ links: [link({ attested: true })] })

    const importButton = buttons().find((button) => /import this site/i.test(button.textContent ?? ''))
    expect(importButton?.hasAttribute('disabled')).toBe(false)

    await act(async () => { importButton?.click() })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/public/scheduling/inv-1/links/link-1/import')
    expect(JSON.parse(String(init.body))).toEqual({ attestationVersion: ATTESTATION_VERSION })
  })

  it('offers no second import once one is already queued', () => {
    render({ links: [link({ attested: true, importState: 'queued' })] })
    expect(buttons().some((button) => /import this site/i.test(button.textContent ?? ''))).toBe(false)
    expect(text()).toMatch(/queued for import/i)
  })

  it('offers a retry after a failed import', () => {
    // `failed` may be transient — a policy refusal is `not_importable` instead — so asking again is
    // meaningful and the control comes back.
    render({ links: [link({ attested: true, importState: 'failed' })] })
    expect(buttons().some((button) => /import this site/i.test(button.textContent ?? ''))).toBe(true)
  })
})

describe('document status is legible', () => {
  it('names the stage rather than showing one generic spinner', () => {
    render({
      documents: [
        { id: 'd1', originalName: 'cv.pdf', bytes: 1024, status: 'scanning', rejectionCode: null },
        { id: 'd2', originalName: 'notes.txt', bytes: 512, status: 'extracting', rejectionCode: null },
      ],
    })
    expect(text()).toMatch(/checking for viruses/i)
    expect(text()).toMatch(/reading the text/i)
  })

  it('explains a rejection in terms the candidate can act on', () => {
    render({
      documents: [{ id: 'd1', originalName: 'cv.pdf', bytes: 1024, status: 'rejected', rejectionCode: 'infected' }],
    })
    expect(text()).toMatch(/virus scanner flagged this file/i)
  })

  it('falls back to a usable sentence for a code it does not know', () => {
    // An unmapped code is our bug; the candidate should still be able to make progress.
    render({
      documents: [{ id: 'd1', originalName: 'cv.pdf', bytes: 1024, status: 'rejected', rejectionCode: 'brand_new_code' }],
    })
    expect(text()).toMatch(/was not accepted/i)
  })

  it('stops offering uploads once the whole allowance is used', () => {
    render({
      documents: [{ id: 'd1', originalName: 'big.pdf', bytes: 25 * 1024 * 1024, status: 'ready', rejectionCode: null }],
    })
    const addButton = buttons().find((button) => /add a document/i.test(button.textContent ?? ''))
    expect(addButton?.hasAttribute('disabled')).toBe(true)
    expect(text()).toMatch(/used the full 25 MB/i)
  })

  it('does not count a rejected document against the allowance', () => {
    // Its bytes are gone from the bucket, so holding quota for it would lock the candidate out with
    // nothing on screen explaining why.
    render({
      documents: [{ id: 'd1', originalName: 'big.pdf', bytes: 25 * 1024 * 1024, status: 'rejected', rejectionCode: 'infected' }],
    })
    const addButton = buttons().find((button) => /add a document/i.test(button.textContent ?? ''))
    expect(addButton?.hasAttribute('disabled')).toBe(false)
  })
})
