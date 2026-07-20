# Authorization Matrix

This document is the normative product authorization policy. Route handlers must derive a
`TenantPrincipal` from the server session and current membership. Client-supplied user, role, or
organization identifiers never establish authority. PostgreSQL RLS is the final enforcement layer;
application checks provide action- and role-level policy.

## Principals

- `anonymous`: no authenticated account; global published resources only.
- `member`: active organization member.
- `admin`: organization administrator; cannot transfer or delete the organization.
- `owner`: the single organization owner.
- `platform-admin`: separate server-verified operational principal; never represented by an
  organization role and never gains tenant access implicitly.
- `worker`: authenticated job identity with a server-selected organization scope per transaction.

## Product actions

| Action | Anonymous | Member | Admin | Owner | Platform admin | Worker |
| --- | --- | --- | --- | --- | --- | --- |
| Read published global resource | allow | allow | allow | allow | allow | allow |
| Read organization metadata | deny | allow | allow | allow | audited support only | scoped job only |
| Update organization | deny | deny | allow | allow | deny by default | deny |
| Invite/manage members | deny | deny | allow | allow | deny by default | deny |
| Transfer/delete organization | deny | deny | deny | allow + recent auth | deny by default | deny |
| Create tenant resource | deny | allow | allow | allow | deny by default | scoped job only |
| Read private creator resource | deny | creator | creator | creator | audited support only | scoped job only |
| Read organization-visible resource | deny | allow | allow | allow | audited support only | scoped job only |
| Update/delete/share private resource | deny | creator | creator | creator | audited support only | deny by default |
| Update/delete/share organization-visible resource | deny | creator | allow | allow | audited support only | deny by default |
| Export organization | deny | deny | allow + recent auth | allow + recent auth | deny | deny |
| Export/delete account-subject data | deny | own subject only | own subject only | own subject only | legal workflow only | privacy worker only |

`src/shared/lib/authorization/permissions.ts` implements the organization-role subset. Platform
administration and workers use distinct principals because adding either value to the member role
column would create an authorization bypass.

## Mandatory checks

1. Authenticate and resolve active organization from Better Auth.
2. Re-read membership and reject missing, stale, or unsupported roles.
3. Call `can()` for the requested action and, where relevant, creator/visibility attributes.
4. Execute private data access inside `withTenantContext()` using only its transaction argument.
5. Return an explicit DTO; never serialize an unrestricted ORM row.
6. Emit a redacted audit event for membership, ownership, export, deletion, claim, admin, and policy
   changes.

