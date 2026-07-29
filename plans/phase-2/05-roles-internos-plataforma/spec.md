# Especificación — roles internos de plataforma

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Los clientes ya usan roles organizacionales `owner | admin | member` mediante
> `src/shared/lib/authorization/permissions.ts`. Las rutas internas usan `getIsAppAdmin` y una
> allowlist `ADMIN_USER_IDS` en `src/shared/lib/auth/auth-session.ts`; la navegación admin se filtra
> con `adminOnly` en `src/modules/dashboard/ui/shell/nav-config.ts`.

## Problema

La allowlist actual concede acceso administrativo como un bloque único. A medida que aparecen
usuarios, contenido, soporte, billing, refunds, disputes, abuse e incidents, una persona interna
recibe más privilegios de los necesarios y los cambios carecen de un workflow auditable.

## Objetivo

Implementar autorización interna de mínimo privilegio, administrable y auditable, sin reutilizar
roles de organización, segmentos, planes o controles puramente visuales.

## Modelo conceptual

### Roles iniciales

- `super_admin`: gestiona roles y todas las operaciones;
- `operations`: usuarios, métricas, incidents y abuse;
- `support`: lectura limitada de usuarios/estado y acciones de soporte explícitas;
- `content`: contenido público, changelog y roadmap;
- `billing`: billing ops, refunds y disputes.

Los roles son bundles convenientes. La decisión real se realiza sobre permisos.

### Permisos iniciales

- `platform.users.read`;
- `platform.users.support`;
- `platform.metrics.read`;
- `platform.incidents.read|manage`;
- `platform.abuse.read|manage`;
- `platform.content.read|manage|publish`;
- `platform.billing.read|manage`;
- `platform.refunds.manage`;
- `platform.disputes.manage`;
- `platform.roles.read|manage`.

Antes de implementar se debe reconciliar esta matriz con cada endpoint real. Una acción destructiva
o monetaria merece permiso separado.

## Persistencia

`platform_staff_assignments`:

- `user_id`;
- `role`;
- `granted_by_user_id`;
- `reason`;
- `created_at`, `updated_at`, `revoked_at`.

`platform_staff_audit_log` append-only:

- actor, target, action, role anterior/nuevo;
- reason;
- request ID;
- timestamp;
- metadata redacted.

Son datos operacionales sensibles, accesibles por la conexión platform y sin exposición tenant.

## Autorización

Crear:

- `requirePlatformPrincipal(request)`;
- `hasPlatformPermission(principal, permission)`;
- `requirePlatformPermission(request, permission)`.

Toda ruta `/api/admin/*` declara el permiso requerido en servidor. La UI recibe capabilities para
presentación, pero ocultar navegación nunca es el control de seguridad.

## Bootstrap y emergencia

- `ADMIN_USER_IDS` permanece temporalmente como bootstrap de `super_admin`;
- migración idempotente crea assignments iniciales;
- después del enforcement actúa solo como break-glass documentado;
- nunca puede quedar el sistema sin un `super_admin` activo;
- cambio de rol requiere reason y genera audit event.

## UX administrativa

Nueva pantalla `/admin/roles`:

- lista staff y roles activos;
- muestra matriz de permisos;
- asigna/revoca con confirmación y reason;
- impide auto-revocación del último super admin;
- muestra audit trail;
- no permite buscar cualquier cliente y promoverlo sin confirmación explícita.

## Rollout

1. inventario/matriz;
2. persistencia y bootstrap;
3. shadow mode: calcula permiso y registra discrepancias sin bloquear;
4. migrar endpoints por grupos;
5. enforcement;
6. reducir uso normal de allowlist.

## Seguridad

- deny by default;
- tests negativos por endpoint;
- acciones de billing/refund/dispute permanecen protegidas por controles de dominio además de RBAC;
- no registrar secretos ni datos financieros completos;
- cambios de rol son outward-facing/security-sensitive y requieren confirmación explícita en UI;
- considerar reautenticación para gestión de roles en una fase posterior si Better Auth lo soporta.

## No objetivos

- cambiar `owner/admin/member`;
- permisos configurables arbitrarios por cliente;
- ABAC completo;
- SSO/SCIM;
- usar segmento como rol;
- reemplazar controles de dominio.

## Criterios de aceptación

- cada endpoint admin tiene permiso explícito;
- matriz y código coinciden;
- usuarios sin permiso reciben 403 en servidor;
- último super admin no puede eliminarse;
- bootstrap y rollback están ensayados;
- todos los cambios aparecen en audit log;
- navegación refleja capabilities sin ser la barrera.

