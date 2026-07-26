/**
 * Common API error codes and their stable HTTP status mapping (plan:
 * calendar-scheduling-interview-intelligence, spec.md "HTTP contract": "Common errors are
 * `400 invalid_input`, `401 authentication_required`, ... and `503 dependency_unavailable`.").
 * Pure — no I/O. A route handler throws `ApiError`; the route's own catch block calls
 * `httpStatusForApiErrorCode` to pick the response status, so the mapping never drifts between
 * routes that happen to reuse the same code.
 */
import { z } from 'zod'

export const API_ERROR_CODES = [
  'invalid_input',
  'authentication_required',
  'forbidden',
  'not_found',
  'invitation_unavailable',
  'state_changed',
  'slot_unavailable',
  'insufficient_credits',
  'too_large',
  'unsupported_media_type',
  'consent_required',
  'source_not_importable',
  'rate_limited',
  'dependency_unavailable',
] as const
export type ApiErrorCode = (typeof API_ERROR_CODES)[number]

/**
 * `invitation_unavailable` shares 404 with `not_found` deliberately — spec.md: "Public endpoints
 * ... return the same `404 invitation_unavailable` for unknown, revoked, expired, or foreign
 * resources," collapsing every unavailable-capability reason into one non-enumerating status.
 */
export const API_ERROR_HTTP_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  invalid_input: 400,
  authentication_required: 401,
  forbidden: 403,
  not_found: 404,
  invitation_unavailable: 404,
  state_changed: 409,
  slot_unavailable: 409,
  insufficient_credits: 409,
  too_large: 413,
  unsupported_media_type: 415,
  consent_required: 422,
  source_not_importable: 422,
  rate_limited: 429,
  dependency_unavailable: 503,
}

export class ApiError extends Error {
  constructor(message: string, readonly code: ApiErrorCode) {
    super(message)
    this.name = 'ApiError'
  }
}

export function httpStatusForApiErrorCode(code: ApiErrorCode): number {
  return API_ERROR_HTTP_STATUS[code]
}

export const apiErrorResponseSchema = z.object({
  error: z.enum(API_ERROR_CODES),
  message: z.string().optional(),
}).strict()
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>
