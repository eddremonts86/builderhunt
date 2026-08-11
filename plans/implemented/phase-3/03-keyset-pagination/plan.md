# Plan — scope-safe keyset pagination

> **Status**: `implemented`
> **Depends on**: [`02-table-query-contract`](../02-table-query-contract/spec.md)
> **Blocks**: [`04-sort-indexes`](../04-sort-indexes/spec.md), [`07-first-surface-sprint-results`](../07-first-surface-sprint-results/spec.md)
> **Reality check**: New files under `src/shared/lib/table/`. No existing read path changes here; plan 07 is the first caller.

## Sequence

1. **The capability type and registry** — the allowlist must exist before anything can resolve an
   id through it.
2. **`buildKeysetPage`** — id resolution, tuple predicate, tiebreaker, counts, facets.
3. **Adversarial tests, before any endpoint exists.** Forged cursors, cross-tenant cursors,
   unknown ids, missing tenant context.
4. **The four request adapters**, so tenant, account, platform and public routes cannot hand-roll
   auth + parse + connection context or accidentally use the tenant guard for platform data.

Step 3 comes before step 4 deliberately. The moment a handler exists the surface is reachable;
the attacks should already be proven closed.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A client-supplied id or value reaches SQL unparameterised | Low by design | **Critical** | Ids resolve only through `TableCapability`; values are bound parameters; a test asserts a quote-heavy filter value changes nothing structural about the generated SQL |
| A forged cursor reads another organization's rows | Low | **Critical** | The signature covers the organization, and RLS is the second layer and forced — neither is trusted alone, per the security policy's two-layer rule |
| Non-total sort order duplicates or drops rows at a page boundary | **High** without a tiebreaker | High — silently wrong lists | `tiebreaker` is required, not optional; capability construction fails without it |
| A capability runs in the wrong security scope | Medium | **Critical** | Capability declares scope; scope-specific adapters establish the exact context and reject every mismatch |
| Counts triple the cost of every request | Medium | Medium | Facets opt-in; counts share the rows' transaction; approximate counts revisited only when a real table proves slow |

## Rollback

New files with no callers — delete them. RLS and tenant context are untouched by this plan, so
there is no security posture to restore.
