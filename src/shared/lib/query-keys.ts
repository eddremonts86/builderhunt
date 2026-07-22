/**
 * Every private (organization-scoped) query key must start with this prefix
 * so `TenantQueryProvider` can reason about "clear on organization switch" —
 * in practice it clears the whole client rather than filtering by prefix
 * (see that component for why), but the prefix still documents intent and
 * lets call sites invalidate/refetch a specific resource without guessing.
 */
export function organizationQueryKey(
  organizationId: string | null,
  ...parts: readonly unknown[]
): readonly unknown[] {
  return ['organization', organizationId, ...parts]
}
