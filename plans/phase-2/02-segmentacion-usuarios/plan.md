# Plan de entrega — fundamento de segmentación de usuarios

> **Status**: `pending`
> **Depends on**: nothing — the provisional taxonomy is fixed in the phase README.
> **Blocks**: [`03-onboarding-segmentado`](../03-onboarding-segmentado/spec.md), [`04-dashboard-personalizado`](../04-dashboard-personalizado/spec.md), [`06-landing-segmentada`](../06-landing-segmentada/spec.md)
> **Reality check**: La aplicación ya usa Zod, Drizzle, Better Auth y rutas TanStack Start. La nueva
> preferencia debe integrarse sin modificar los roles organizacionales.

## Fase 1 — contrato y persistencia

- freeze the provisional enum and schema version before persistence;
- crear módulo compartido sin dependencias de UI;
- añadir tabla y migración segura;
- backfill nullable, sin obligar a usuarios existentes.

## Fase 2 — repositorio y API

- implementar lectura/upsert por el `userId` resuelto de sesión;
- construir schemas request/response;
- rechazar authority fields;
- probar acceso cruzado negativo.

## Fase 3 — settings

- añadir selector accesible a `/me`;
- mostrar estado loading/saving/error/success;
- permitir cambio reversible;
- explicar alcance de personalización.

## Fase 4 — eventos y métricas

- emitir eventos allowlisted;
- agregar conteos por segmento en admin metrics;
- preservar categoría `unknown` para null;
- establecer baseline antes de activar onboarding v2.

## Fase 5 — rollout

- desplegar lectura y fallback primero;
- habilitar escritura en settings;
- observar errores y distribución;
- habilitar consumidores uno por uno.

## Riesgos y rollback

| Riesgo | Mitigación |
|---|---|
| La investigación contradice el enum provisional | Migración versionada; nunca reinterpretar valores históricos |
| Segmento usado como permiso | Tests y separación de módulos |
| Usuarios existentes bloqueados | Campo nullable y preset general |
| Métricas con PII | Payload allowlisted |
| Cambio rompe consumidores | Schema version y exhaustividad |

Rollback: deshabilitar superficies mediante feature flag y mantener la columna nullable. No eliminar
datos durante el rollback. Los consumidores vuelven a `general`.
