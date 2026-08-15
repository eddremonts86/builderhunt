# Tareas — fundamento de segmentación de usuarios

> **Status**: `implemented`
> **Depends on**: nothing — **dependencia levantada el 2026-08-05.** Dependía de `01-investigacion-icp`,
> cuyas entrevistas se movieron a phase-5 porque necesitan usuarios reales. Se construye contra la
> taxonomía documentada en [`../README.md`](../../../phase-2/README.md) (`hiring | investing | building | other`) como
> hipótesis explícita, detrás de bandera; la investigación posterior la corrige. Es seguro porque
> `user_segment` nunca concede permisos.
> **Blocks**: [`03-onboarding-segmentado`](../../../phase-2/03-onboarding-segmentado/spec.md), [`04-dashboard-personalizado`](../../../phase-2/04-dashboard-personalizado/spec.md), [`06-landing-segmentada`](../../../phase-2/06-landing-segmentada/spec.md)
> **Reality check**: No hay tabla ni endpoints de preferencias; `/me` es el punto de integración
> existente.

- [x] **Cerrar el contrato de segmento**
  - Files: `src/shared/lib/user-segments.ts`, `tests/unit/shared/lib/user-segments.test.ts`
  - Do: definir enum, labels, descripciones, schema version y fallback `general`.
  - Verify: `pnpm test tests/unit/shared/lib/user-segments.test.ts`.

- [x] **Crear persistencia account-subject**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/*.sql` (new migration allocated by
    `pnpm db:generate`), `drizzle/migration-hashes.json`
  - Do: crear `user_preferences` con FK, timestamps, source y version; añadir grants/RLS coherentes
    con datos account-subject. Nunca reservar un número de migración en el plan: el tip actual es
    `0154` y puede avanzar antes de ejecutar esta tarea.
  - Verify: aplicar migraciones en DB desechable y probar que usuario A no lee/escribe usuario B.

- [x] **Crear repositorio de preferencias**
  - Files: `src/shared/lib/repositories/user-preferences.ts`, `tests/unit/shared/lib/repositories/user-preferences.test.ts`
  - Do: implementar get/upsert con user ID resuelto en servidor y actualización idempotente.
  - Verify: tests de create, update, null, enum inválido y aislamiento.

- [x] **Exponer API autenticada**
  - Files: `src/routes/api/me/preferences.ts`, `src/shared/lib/user-preferences-api.ts`, `tests/unit/shared/lib/user-preferences-api.test.ts`
  - Do: implementar GET/PATCH, schemas estrictos y rechazo de `userId`, `organizationId`, `role` y entitlement.
  - Verify: tests HTTP 200/400/401 y autoridad negativa.

- [x] **Añadir configuración de objetivo**
  - Files: `src/routes/_dashboard/me/index.tsx`, `src/modules/dashboard/components/UserSegmentSettings.tsx`, `tests/unit/modules/dashboard/components/UserSegmentSettings.test.tsx`
  - Do: selector accesible, copy explicativo y estados de persistencia.
  - Verify: test de teclado/screen reader y smoke real de cambio + refresh.

- [x] **Instrumentar eventos**
  - Files: `src/shared/lib/conversion-events.ts`, `tests/unit/shared/lib/conversion-events.test.ts`, `src/shared/lib/conversion-client.ts`, `src/routes/api/admin/metrics/index.ts`
  - Do: extender el pipeline de conversión existente con selección/cambio/skip, propiedades
    allowlisted y distribución agregada incluyendo unknown.
  - Verify: tests de redacción y respuesta de métricas sin PII.

- [x] **Añadir feature flag y documentación**
  - Files: `.env.example`, `docs/operations/user-segmentation-rollout.md`
  - Do: documentar enable/disable, rollout, consulta de salud y rollback.
  - Verify: con flag off, settings no aparece y toda la aplicación sigue funcional.
  - Result: `src/shared/lib/user-segments.ts` — enum, labels, descripciones, `SEGMENT_SCHEMA_VERSION`
    y `resolveSegmentPreset`. 11 tests. `general` queda **fuera** de `USER_SEGMENTS` a propósito: es
    el preset que se renderiza para `null`, nunca un valor almacenable, y meterlo en el enum habría
    borrado la diferencia entre "eligió otra cosa" y "nunca se le preguntó".
  - Result: `user_preferences` en `schema.ts` + `drizzle/0171_user_preferences.sql` con RLS
    **activada y forzada**, políticas sobre `app.user_id` y grants `SELECT, INSERT, UPDATE` — sin
    `DELETE`, porque la fila muere con la cuenta por `ON DELETE CASCADE` y un grant que nadie
    necesita es un grant que se puede usar mal.
  - Encontrado al generar: `pnpm db:generate` produjo **cuatro** `CREATE TABLE`, tres de tablas que
    ya existen (`platform_admin_preferences`, `platform_beta_mode`, `service_metric_buckets`).
    `0167`, `0169` y `0170` son migraciones *custom*, cuyo SQL drizzle-kit no lee, así que
    `0170_snapshot.json` describe 124 tablas mientras la base tiene 127. Aplicar el fichero generado
    habría fallado en la primera y arrastrado el resto. Se reescribió a mano dejando solo lo de esta
    tarea; `0171_snapshot.json` ya tiene las 128, así que la cadena se repara aquí — pero la trampa
    sigue esperando a quien escriba la próxima migración custom y luego genere.
  - Verificado aplicando **desde cero** en una base desechable y actuando como el rol real
    `builderhunt_app`, no con tests unitarios (que conectan como superusuario y no ven RLS):
    `userA` solo ve su fila, las de `userB` son 0, el `UPDATE` sobre `userB` afecta 0 filas, y el
    `INSERT` de una fila ajena responde `ERROR: new row violates row-level security policy`.
  - Result: `get`/`setPrimarySegment` idempotente vía `onConflictDoUpdate` — no read-then-write,
    porque dos pestañas guardando a la vez chocarían entre la lectura y el insert y el perdedor
    recibiría una violación de clave primaria como un 500 en una página de ajustes. 9 tests.
    `getUserPreferences` devuelve un registro con `primarySegment: null` en vez de `null` entero: así
    los consumidores manejan una forma y no dos.
  - Result: `GET`/`PATCH /api/me/preferences` con `.strict()`, 14 tests. El sujeto es
    `principal.userId` y nunca el cuerpo; `REJECTED_REQUEST_FIELDS` fija los seis nombres prohibidos
    para que los tests negativos no puedan desviarse de la lista. El `source` acepta solo
    `onboarding|settings` de los cuatro que existen: `migration` lo escribe una migración y `landing`
    el embudo pre-login, y aceptarlos dejaría a un cliente etiquetar mal sus propias escrituras.
  - Result: `UserSegmentSettings` montado en `/me`, 11 tests. Radios en un `fieldset` con
    `aria-describedby` por opción — un `<select>` muestra una a la vez y no tiene dónde poner las
    descripciones, así que la elección se haría sin la información que distingue las opciones.
    Estado de guardado en `role="status" aria-live="polite"`, y un fallo se reporta en vez de
    fingir que guardó.
  - Result: cinco eventos en el stream de conversión existente, 28 tests en total en ese fichero.
    El contexto de segmento es **obligatorio en los cuatro eventos de elección y prohibido en el
    resto** — un evento de landing con contexto de segmento significaría que una superficie envía
    datos que no le corresponden. Solo dos enums y un origen: no hay campo donde pueda caber un
    email, un nombre ni una query. La clave de deduplicación incluye el valor elegido, así que quien
    prueba tres segmentos antes de decidirse cuenta como tres cambios y no como uno.
  - Distribución agregada en `/api/admin/metrics`, ausente (no en cero) mientras el flag está
    apagado — misma convención que `removals`, porque un bloque de ceros se leería como "todos
    declinaron" en vez de "aún no se ha preguntado".
  - Result: `USER_SEGMENTATION_ENABLED`, **apagado por defecto**, en `env.ts` y `.env.example`, más
    `docs/operations/user-segmentation-rollout.md`. Apagado significa *ausente*, no escondido: la
    API responde **404** (no 403 — un 403 confirmaría a quien sondee que la ruta existe, y se leería
    como "no tienes permiso", que es lo único que esta función nunca dice de nadie), y el componente
    se auto-oculta ante ese 404. Así el flag tiene un solo hogar, en el servidor, sin una copia en
    cliente que pueda desincronizarse.
  - Verify cumplido: con el flag apagado la suite completa pasa y `/me` sigue entera — la sección
    simplemente no existe.
  - **No demostrado de extremo a extremo, y por qué**: `startWorkerServer` cachea un servidor por
    worker de Playwright, y los `flags` solo lo alcanzan escribiéndose en `process.env` *antes* de
    que ese servidor arranque. Un segundo harness en el mismo worker reutiliza el primero, así que un
    test que afirme `USER_SEGMENTATION_ENABLED=false` en la misma corrida habla con un proceso que ya
    arrancó con el flag encendido — el primer intento recibió `200` donde esperaba `404`. Queda
    cubierto donde sí se puede: el test del componente prueba que la superficie desaparece ante el
    404, y el guard se lee antes de resolver la sesión, por encima de todo lo demás del handler. Lo
    que sigue sin probarse en e2e es la API devolviendo 404 en un servidor arrancado con el flag
    apagado, y eso necesita una corrida cuyo worker entero lo tenga apagado.
