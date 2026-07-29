# Plan de entrega — roles internos de plataforma

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: La migración parte de una allowlist binaria y múltiples rutas admin existentes;
> debe realizarse en modo sombra antes de bloquear.

## Fase 1 — matriz real

- inventariar páginas y endpoints admin;
- clasificar cada operación read/manage/destructive/money/publish;
- asignar permisos a roles;
- revisar least privilege y segregación de funciones.

## Fase 2 — foundation

- crear enums, asignaciones y audit log;
- crear principal y guards;
- bootstrap desde allowlist;
- tests unitarios exhaustivos.

## Fase 3 — shadow mode

- calcular autorización RBAC junto al guard actual;
- registrar discrepancias redacted;
- no cambiar comportamiento;
- resolver todas las discrepancias antes de enforcement.

## Fase 4 — migración por dominio

1. content y metrics, bajo riesgo;
2. users/support;
3. incidents/abuse;
4. billing read;
5. refunds, disputes y mutations monetarias;
6. role management.

## Fase 5 — UI y enforcement

- capability-aware navigation;
- pantalla de roles;
- audit trail;
- activar deny-by-default;
- ejecutar test de break-glass.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Lockout total | Bootstrap, último super admin y break-glass |
| UI oculta pero API abierta | Guards server-side y tests HTTP |
| Rol demasiado amplio | Permisos granulares y revisión |
| Acción monetaria accidental | Confirmación + dominio + audit |
| Allowlist y DB divergen | Shadow mode con métricas |

## Rollback

Feature flag restaura autorización por allowlist sin borrar assignments/audit. El procedimiento debe
ser ensayado en staging y documentar quién puede activarlo. Rollback no revierte acciones ya
ejecutadas; por ello auditoría y confirmación preceden enforcement.

