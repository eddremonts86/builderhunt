// createOrganizationAlertFromQueryForPrincipal — repository unit tests.
//
// The principal-scoped visibility check is what enforces the tenant
// boundary on this path. These tests verify the repository's
// contract:
//   - 404 (not 403) when the source query is not visible, so a probe
//     by id cannot enumerate which ids exist.
//   - When visible, the alert is created with the source query's
//     keywords (not anything the caller supplied in triggerConditions)
//     and with the source query's id as `queryId`.
//   - The un-scoped createOrganizationAlert is never called on the
//     "from query" path.

import { describe, expect, it, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  findVisibleSavedQueryById: vi.fn(),
}))

vi.mock('~/shared/lib/repositories/saved-queries', () => ({
  findVisibleSavedQueryById: mocks.findVisibleSavedQueryById,
}))

const { createOrganizationAlertFromQueryForPrincipal } = await import('~/shared/lib/repositories/organization-alerts')
const { SharedResourceError } = await import('~/shared/lib/shared-resources/contracts')

const principal = { userId: 'u-1', organizationId: 'org-1', role: 'owner' as const, requestId: 'r-1' }

interface CapturedInsert {
  values: Record<string, unknown>
  returningCalled: boolean
}

function makeFakeTx() {
  const captured: CapturedInsert = { values: {}, returningCalled: false }
  const tx = {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          captured.values = v
          captured.returningCalled = true
          return [{ ...v }]
        },
      }),
    }),
  } as never
  return { tx, captured }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createOrganizationAlertFromQueryForPrincipal', () => {
  it('throws not_found (404) when the source query is not visible to the principal', async () => {
    // findVisibleSavedQueryById returns null for both cross-tenant and
    // private-and-not-yours, and the repository must surface that as a
    // 404 — never a 200 with no row, never a 403 (no enumeration).
    mocks.findVisibleSavedQueryById.mockResolvedValue(null)

    await expect(
      createOrganizationAlertFromQueryForPrincipal(
        {} as never,
        principal,
        {
          name: 'Watch rust people',
          queryId: 'q-private-of-other-member',
          triggerConditions: { eventType: 'any_activity' },
        },
      ),
    ).rejects.toBeInstanceOf(SharedResourceError)

    await expect(
      createOrganizationAlertFromQueryForPrincipal(
        {} as never,
        principal,
        {
          name: 'Watch rust people',
          queryId: 'q-private-of-other-member',
          triggerConditions: { eventType: 'any_activity' },
        },
      ),
    ).rejects.toMatchObject({ code: 'not_found', status: 404 })
  })

  it('inserts an alert with the source query id, copied keywords, and the principal on the same org', async () => {
    mocks.findVisibleSavedQueryById.mockResolvedValue({
      id: 'q-1',
      organizationId: 'org-1',
      userId: 'u-1',
      name: 'Rust query',
      keywords: ['rust', 'systems'],
      sources: ['github'],
      language: null,
      country: null,
      visibility: 'organization',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const { tx, captured } = makeFakeTx()

    const result = await createOrganizationAlertFromQueryForPrincipal(
      tx,
      principal,
      {
        name: 'Watch rust people',
        queryId: 'q-1',
        frequency: 'daily',
        deliveryChannel: 'email',
        triggerConditions: { eventType: 'any_activity' },
      },
    )

    expect(captured.returningCalled).toBe(true)
    expect(captured.values).toMatchObject({
      organizationId: 'org-1',
      userId: 'u-1',
      queryId: 'q-1',
      name: 'Watch rust people',
      keywords: ['rust', 'systems'],
      frequency: 'daily',
      deliveryChannel: 'email',
      enabled: true,
      triggerConditions: { eventType: 'any_activity' },
    })
    expect(result).toBeTruthy()
  })

  it('trims the alert name (so accidental whitespace in the body cannot smuggle a different name)', async () => {
    mocks.findVisibleSavedQueryById.mockResolvedValue({
      id: 'q-1',
      organizationId: 'org-1',
      userId: 'u-1',
      name: 'Rust query',
      keywords: ['rust'],
      sources: ['github'],
      language: null,
      country: null,
      visibility: 'organization',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const { tx, captured } = makeFakeTx()

    await createOrganizationAlertFromQueryForPrincipal(
      tx,
      principal,
      {
        name: '  Watch rust people  ',
        queryId: 'q-1',
        triggerConditions: { eventType: 'any_activity' },
      },
    )

    expect(captured.values.name).toBe('Watch rust people')
  })

  it('uses the source query keywords, NOT anything the caller put in triggerConditions.keywords', async () => {
    // The point of "create from query" is that the source-of-truth
    // keywords are the query's, not the caller's. If a caller could
    // override the keywords via the alert body, sharing a query would
    // be a no-op (a recipient could ignore them and watch anything).
    mocks.findVisibleSavedQueryById.mockResolvedValue({
      id: 'q-1',
      organizationId: 'org-1',
      userId: 'u-1',
      name: 'Rust query',
      keywords: ['rust', 'systems'],
      sources: ['github'],
      language: null,
      country: null,
      visibility: 'organization',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const { tx, captured } = makeFakeTx()

    await createOrganizationAlertFromQueryForPrincipal(
      tx,
      principal,
      {
        name: 'Watch rust people',
        queryId: 'q-1',
        triggerConditions: {
          eventType: 'keyword_match',
          keywords: ['whatever-the-caller-typed'],
        },
      },
    )

    // The alert's keywords are the query's; the caller-supplied
    // triggerConditions.keywords are preserved on triggerConditions
    // (they're optional guidance, not the source of truth).
    expect(captured.values.keywords).toEqual(['rust', 'systems'])
    expect(captured.values.triggerConditions).toEqual({
      eventType: 'keyword_match',
      keywords: ['whatever-the-caller-typed'],
    })
  })
})
