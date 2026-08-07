# Tareas — fundamento de segmentación de usuarios

> **Status**: `pending`
> **Depends on**: nothing — **dependencia levantada el 2026-08-05.** Dependía de `01-investigacion-icp`,
> cuyas entrevistas se movieron a phase-5 porque necesitan usuarios reales. Se construye contra la
> taxonomía documentada en [`../README.md`](../README.md) (`hiring | investing | building | other`) como
> hipótesis explícita, detrás de bandera; la investigación posterior la corrige. Es seguro porque
> `user_segment` nunca concede permisos.
> **Blocks**: [`03-onboarding-segmentado`](../03-onboarding-segmentado/spec.md), [`04-dashboard-personalizado`](../04-dashboard-personalizado/spec.md), [`06-landing-segmentada`](../06-landing-segmentada/spec.md)
> **Reality check**: No hay tabla ni endpoints de preferencias; `/me` es el punto de integración
> existente.

- [ ] **Cerrar el contrato de segmento**
  - Files: `src/shared/lib/user-segments.ts`, `tests/unit/shared/lib/user-segments.test.ts`
  - Do: definir enum, labels, descripciones, schema version y fallback `general`.
  - Verify: `pnpm test tests/unit/shared/lib/user-segments.test.ts`.

- [ ] **Crear persistencia account-subject**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/*.sql` (new migration allocated by
    `pnpm db:generate`), `drizzle/migration-hashes.json`
  - Do: crear `user_preferences` con FK, timestamps, source y version; añadir grants/RLS coherentes
    con datos account-subject. Nunca reservar un número de migración en el plan: el tip actual es
    `0154` y puede avanzar antes de ejecutar esta tarea.
  - Verify: aplicar migraciones en DB desechable y probar que usuario A no lee/escribe usuario B.

- [ ] **Crear repositorio de preferencias**
  - Files: `src/shared/lib/repositories/user-preferences.ts`, `tests/unit/shared/lib/repositories/user-preferences.test.ts`
  - Do: implementar get/upsert con user ID resuelto en servidor y actualización idempotente.
  - Verify: tests de create, update, null, enum inválido y aislamiento.

- [ ] **Exponer API autenticada**
  - Files: `src/routes/api/me/preferences.ts`, `src/shared/lib/user-preferences-api.ts`, `tests/unit/shared/lib/user-preferences-api.test.ts`
  - Do: implementar GET/PATCH, schemas estrictos y rechazo de `userId`, `organizationId`, `role` y entitlement.
  - Verify: tests HTTP 200/400/401 y autoridad negativa.

- [ ] **Añadir configuración de objetivo**
  - Files: `src/routes/_dashboard/me/index.tsx`, `src/modules/dashboard/components/UserSegmentSettings.tsx`, `tests/unit/modules/dashboard/components/UserSegmentSettings.test.tsx`
  - Do: selector accesible, copy explicativo y estados de persistencia.
  - Verify: test de teclado/screen reader y smoke real de cambio + refresh.

- [ ] **Instrumentar eventos**
  - Files: `src/shared/lib/conversion-events.ts`, `tests/unit/shared/lib/conversion-events.test.ts`, `src/shared/lib/conversion-client.ts`, `src/routes/api/admin/metrics/index.ts`
  - Do: extender el pipeline de conversión existente con selección/cambio/skip, propiedades
    allowlisted y distribución agregada incluyendo unknown.
  - Verify: tests de redacción y respuesta de métricas sin PII.

- [ ] **Añadir feature flag y documentación**
  - Files: `.env.example`, `docs/operations/user-segmentation-rollout.md`
  - Do: documentar enable/disable, rollout, consulta de salud y rollback.
  - Verify: con flag off, settings no aparece y toda la aplicación sigue funcional.
