/**
 * Plan 59, task 10 — the shared invitation value preview.
 *
 * Uses the project's `react-dom/client` + `act` pattern (see
 * `OrganizationAdminSection.test.tsx` for the reference); there is no
 * `@testing-library/react` in this repository.
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { InvitationValuePreview, type InvitationValuePreviewProps } from '~/modules/organizations/components/InvitationValuePreview'
import {
  INVITATION_INTENT_CAPABILITIES,
  INVITATION_INTENTS,
  INVITATION_SUGGESTED_QUERY,
} from '~/shared/lib/organizations/invitation-personalization'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

function mount(props: InvitationValuePreviewProps): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(<InvitationValuePreview {...props} />) })
  return container
}

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  root = null
  container = null
})

const testId = (id: string) => container?.querySelector(`[data-testid="${id}"]`)
const text = (id: string) => testId(id)?.textContent ?? ''

describe('InvitationValuePreview', () => {
  it('renders the three capability bullets and the suggested query for every intent', () => {
    for (const intent of INVITATION_INTENTS) {
      mount({ intent, audience: 'recipient' })
      const bullets = text('invitation-preview-capabilities')
      for (const capability of INVITATION_INTENT_CAPABILITIES[intent]) {
        expect(bullets).toContain(capability)
      }
      expect(text('invitation-preview-suggested-query')).toContain(INVITATION_SUGGESTED_QUERY[intent])
      act(() => { root!.unmount() })
      container!.remove()
    }
  })

  it('renders the identical capability list for the sender and the recipient', () => {
    // The sender's whole reason to review is to see what the recipient will see. Two components would
    // drift — one bullet reworded on one side — and the drift is invisible because nobody sees both at
    // once. Only the framing may differ.
    const shared = { intent: 'hiring' as const, organizationName: 'Acme', role: 'member' as const }

    mount({ ...shared, audience: 'sender' })
    const senderBullets = text('invitation-preview-capabilities')
    act(() => { root!.unmount() })
    container!.remove()

    mount({ ...shared, audience: 'recipient' })
    expect(text('invitation-preview-capabilities')).toBe(senderBullets)
  })

  it('frames the sender view as a preview and the recipient view as their own', () => {
    mount({ intent: 'hiring', audience: 'sender' })
    expect(container!.textContent).toContain('What they will see')
    expect(text('invitation-preview-suggested-query')).toContain('Their first search')
    act(() => { root!.unmount() })
    container!.remove()

    mount({ intent: 'hiring', audience: 'recipient' })
    expect(container!.textContent).not.toContain('What they will see')
    expect(text('invitation-preview-suggested-query')).toContain('Your first search')
  })

  it('attributes the role title to the sender rather than asserting it', () => {
    mount({ intent: 'hiring', roleTitle: 'Staff Engineer', audience: 'recipient' })
    const line = text('invitation-preview-role-title')
    expect(line).toContain('They described the role as')
    expect(line).toContain('Staff Engineer')
    // Not "Your role:" — nobody verified this string; it is one person's description of another.
    expect(line).not.toMatch(/^Your role/)
  })

  it('omits the role-title line when there is none', () => {
    mount({ intent: 'hiring', roleTitle: null, audience: 'recipient' })
    expect(testId('invitation-preview-role-title')).toBeNull()
  })

  it('omits the organization line when no name is passed', () => {
    mount({ intent: 'hiring', audience: 'sender' })
    expect(testId('invitation-preview-organization')).toBeNull()
  })

  it('names the offered role in words rather than as a raw enum', () => {
    mount({ intent: 'hiring', organizationName: 'Acme', role: 'admin', audience: 'recipient' })
    expect(text('invitation-preview-organization')).toContain('as an admin')
  })

  it('shows no people, no counts and no plan vocabulary', () => {
    // This renders on a page reached from an email by someone who is not a member yet. Anything dynamic
    // would be either a query run for a non-member or a number that changes before they accept.
    for (const intent of INVITATION_INTENTS) {
      mount({ intent, roleTitle: 'Partner', organizationName: 'Acme', role: 'member', audience: 'recipient' })
      const rendered = text('invitation-value-preview')
      expect(rendered).not.toMatch(/\b(pro max|team plan|credits?|unlimited|\$\d)/i)
      expect(rendered).not.toMatch(/\b\d+\s+(builders?|results?|people|matches)\b/i)
      act(() => { root!.unmount() })
      container!.remove()
    }
  })
})
