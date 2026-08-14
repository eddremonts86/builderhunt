# Tareas — onboarding segmentado

> **Status**: `pending`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md)
> **Blocks**: [`04-dashboard-personalizado`](../04-dashboard-personalizado/spec.md)
> **Reality check**: `src/shared/lib/onboarding.ts` y sus rutas son la base obligatoria.

- [ ] **Definir state machine v2**
  - Files: `src/shared/lib/onboarding-v2.ts`, `tests/unit/shared/lib/onboarding-v2.test.ts`
  - Do: modelar segmentos, step keys, transiciones, skip, resume y activaciones.
  - Verify: tests de cada transición válida/inválida y fallback general.

- [ ] **Migrar progreso de onboarding**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/*.sql` (new migration allocated by
    `pnpm db:generate`), `drizzle/migration-hashes.json`
  - Do: añadir flow version, step key y activación manteniendo compatibilidad v1; no fijar un
    número de migración antes de ejecutar.
  - Verify: DB desechable migra filas not-started/in-progress/completed/skipped sin pérdida.

- [ ] **Versionar contratos API**
  - Files: `src/shared/lib/onboarding-api.ts`, `src/routes/api/onboarding/status.ts`, `src/routes/api/onboarding/complete.ts`, `src/routes/api/onboarding/skip.ts`
  - Do: devolver state v2 y aceptar acciones validadas; no aceptar segmento/IDs de autoridad libres.
  - Verify: suite HTTP para auth, idempotencia, orden inválido y retry.

- [ ] **Añadir selección de objetivo**
  - Files: `src/routes/onboarding/goal.tsx`, `src/routes/onboarding/welcome.tsx`, `src/shared/lib/landing-segment-hint.ts`
  - Do: selector accesible, hint validado, confirmación y persistencia.
  - Verify: Playwright signup → goal, URL manipulada y cambio de objetivo.

- [ ] **Implementar rama hiring**
  - Files: `src/routes/onboarding/search.tsx`, `src/routes/onboarding/save.tsx`
  - Do: parametrizar copy, starter queries y activación por builders guardados.
  - Verify: e2e hasta activación y dashboard.

- [ ] **Implementar rama investing**
  - Files: `src/routes/onboarding/investing.tsx`, `src/shared/lib/onboarding-shared.ts`
  - Do: configurar tema y crear saved query/alert usando APIs existentes.
  - Verify: e2e confirma recurso tenant-scoped y no promete deal-flow inexistente.

- [ ] **Implementar rama building**
  - Files: `src/routes/onboarding/building.tsx`, `src/routes/onboarding/success.tsx`
  - Do: localizar perfil y enlazar claim; soportar estado pendiente.
  - Verify: e2e claim found/not-found/pending y salida skippable.

- [ ] **Instrumentar y desplegar gradualmente**
  - Files: `src/shared/lib/conversion-events.ts`, `src/shared/lib/conversion-client.ts`, `src/routes/api/admin/metrics/conversion.ts`, `.env.example`, `docs/operations/segmented-onboarding-rollout.md`
  - Do: extender la analítica de conversión existente con funnels por step/segment/version y
    feature flag por cohorte.
  - Verify: flag off sirve v1; flag on completa las tres ramas; smoke mobile/desktop.
