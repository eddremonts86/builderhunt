import { requireTenantPrincipal, TenantAuthorizationError } from '~/shared/lib/auth/tenant-principal'
import type { TenantPrincipal } from '~/shared/lib/authorization/permissions'
import { withTenantContext } from '~/shared/lib/db/tenant-context'
import type { TenantTransaction } from '~/shared/lib/db/client'

import type { TableCapability } from './capability'
import { TableCursorError } from './cursor'
import { TableQueryError } from './keyset'
import { tableSearchSchema } from './query-url'
import type { PageResult, TableSearch } from './types'

/**
 * Authenticate, parse, open a tenant transaction, answer.
 *
 * Every table route needs the same four steps in the same order, and every route that hand-rolls
 * them is a chance to do one of them differently — to parse before authenticating, to forget the
 * transaction, to return an ORM row. This is that sequence written once.
 *
 * The error mapping is the part worth reading. An unknown sort id and a forged cursor are both
 * 400: from the server's side they are the same thing, a request naming something that does not
 * exist. Neither is a 403, which would confirm that the thing named *does* exist and is merely
 * out of reach.
 */

/**
 * A failure the surface's own `load` wants to answer with a specific status.
 *
 * A sprint that does not exist is a 404, not a 500 — but `load` runs inside the handler, so it
 * needs a way to say so that is distinguishable from "something went wrong". Anything else thrown
 * is a 500 with a generic message, because an unexpected error's text is not a thing to hand to a
 * caller.
 */
export class TablePageError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'TablePageError'
  }
}

export interface TablePageContext {
  principal: TenantPrincipal
  transaction: TenantTransaction
  search: TableSearch
}

export interface TablePageHandlerOptions<Row> {
  /** Only used for its `table` id in error messages; the load function holds the real query. */
  capability: TableCapability
  request: Request
  /** Runs inside `withTenantContext`. Must return a DTO built from an explicit field allowlist. */
  load: (context: TablePageContext) => Promise<PageResult<Row>>
}

export async function tablePageHandler<Row>(
  options: TablePageHandlerOptions<Row>,
): Promise<Response> {
  try {
    // Authenticate before validating. A parse error answered before the auth check tells an
    // anonymous caller which parameters the endpoint takes (`security:auth-before-validate`).
    const principal = await requireTenantPrincipal(options.request)
    const url = new URL(options.request.url)
    const search = tableSearchSchema(searchParamsToRecord(url.searchParams))

    const result = await withTenantContext(principal, (transaction) =>
      options.load({ principal, transaction, search }))

    return Response.json(result)
  } catch (error) {
    if (error instanceof TenantAuthorizationError) {
      return Response.json({ error: error.message }, { status: error.status })
    }
    if (error instanceof TableQueryError || error instanceof TableCursorError) {
      return Response.json({ error: error.message }, { status: 400 })
    }
    if (error instanceof TablePageError) {
      return Response.json({ error: error.message }, { status: error.status })
    }
    console.error(`Table page error (${options.capability.table}):`, error)
    return Response.json({ error: 'Failed to load page' }, { status: 500 })
  }
}

/** `URLSearchParams` → the record shape `tableSearchSchema` reads, repeated keys as arrays. */
export function searchParamsToRecord(params: URLSearchParams): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key)
    record[key] = values.length > 1 ? values : values[0]
  }
  return record
}
