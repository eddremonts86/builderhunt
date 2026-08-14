# Tareas — onboarding segmentado

> **Status**: `pending`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md)
> **Blocks**: [`04-dashboard-personalizado`](../04-dashboard-personalizado/spec.md)
> **Reality check**: `src/shared/lib/onboarding.ts` y sus rutas son la base obligatoria.

- [x] **Definir state machine v2**
  - Files: `src/shared/lib/onboarding-v2.ts`, `tests/unit/shared/lib/onboarding-v2.test.ts`
  - Do: modelar segmentos, step keys, transiciones, skip, resume y activaciones.
  - Verify: tests de cada transición válida/inválida y fallback general.
  - Result: `src/shared/lib/onboarding-v2.ts`, 28 tests. El paso pasa de ser un número que el cliente
    incrementa a una **clave cuyo sucesor calcula el servidor** desde `(preset, actual)`: con un solo
    camino el número bastaba, con cuatro es la vía para llegar a un paso que no es tuyo y para
    reportar una activación que no te has ganado. Solo se avanza de uno en uno y hacia delante —
    saltar dos pasos es exactamente cómo se reporta trabajo que nadie hizo, y retroceder dejaría
    re-disparar eventos de una sola vez.
  - `general` y `other` comparten la ruta de búsqueda que ya existía en v1, porque el spec exige que
    el onboarding nunca bloquee el dashboard: "sin segmento" tiene que ser una ruta de la máquina, no
    un estado que no sabe representar.
  - **Terminar el flujo no es activarse.** v1 contaba un flujo completado como usuario activado, así
    que su tasa describía el flujo y no el producto. `activationReached` devuelve *qué* tipo de
    activación se alcanzó, no un booleano: dos personas activadas por motivos distintos son dos
    señales distintas, y una tasa que no las separa no dice qué ruta funciona.

- [x] **Migrar progreso de onboarding**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/*.sql` (new migration allocated by
    `pnpm db:generate`), `drizzle/migration-hashes.json`
  - Do: añadir flow version, step key y activación manteniendo compatibilidad v1; no fijar un
    número de migración antes de ejecutar.
  - Verify: DB desechable migra filas not-started/in-progress/completed/skipped sin pérdida.
  - Result: `drizzle/0172_onboarding_v2.sql` — cinco columnas nullable añadidas a
    `onboarding_progress`, sin tocar ninguna de v1. Una fila v1 tiene `flow_version` null y `step`
    0..3; una v2 tiene `flow_version` 2 y `current_step_key`. Ambas se leen, que es lo que permite
    desplegar por cohortes en vez de por migración, y lo que hace que un rollback deje a la gente
    donde estaba en lugar de devolverla al principio.
  - Verificado aplicando **desde cero** en base desechable y luego insertando una fila v1 en sus
    cuatro estados: `not-started`, `in-progress`, `completed` y `skipped` sobreviven con sus valores
    intactos y las columnas v2 en `null`.
  - La migración salió limpia, sin las tablas fantasma que apareció en `0171`: arreglar aquel fichero
    a mano reparó la cadena de snapshots, como estaba previsto.

- [x] **Versionar contratos API**
  - Files: `src/shared/lib/onboarding-api.ts`, `src/routes/api/onboarding/status.ts`, `src/routes/api/onboarding/complete.ts`, `src/routes/api/onboarding/skip.ts`
  - Do: devolver state v2 y aceptar acciones validadas; no aceptar segmento/IDs de autoridad libres.
  - Verify: suite HTTP para auth, idempotencia, orden inválido y retry.
  - Result: `src/shared/lib/onboarding-api.ts` (contrato, 18 tests),
    `src/shared/lib/onboarding-v2-repository.ts` (11 tests) y `src/routes/api/onboarding/v2/index.ts`.
  - **v2 es una ruta nueva, no una modificada.** `/status`, `/complete` y `/skip` siguen respondiendo
    v1 sin cambios, así que desplegar es elegir endpoint en el cliente y revertir es la misma
    elección al revés — sin deploy, sin migración y sin nadie tirado a medio flujo. La respuesta v2
    incluye además el bloque `legacy`, para que un consumidor que aún no se ha movido siga leyendo
    algo cierto durante la convivencia.
  - **El cliente nombra el paso que deja, no el que quiere.** El sucesor lo calcula el servidor, así
    que un cliente desactualizado no puede saltar: como mucho se le dice que el paso que nombró ya no
    es el actual. Eso responde **409 y no 400** — la petición estaba bien formada y el estado se movió
    debajo; un 409 significa "vuelve a leer" y un 400 "tienes un bug", y juntarlos haría un bucle de
    reintento indistinguible de un cliente roto.
  - **La evidencia de activación se cuenta en el servidor.** Un cliente que pudiera afirmar "he
    guardado tres builders" podría afirmarlo habiendo guardado cero, y la tasa de activación sería la
    primera víctima. `recordActivation` además no sobrescribe: el primer acto real es el que cuenta,
    y una segunda activación movería `activated_at` y corrompería cualquier medida de tiempo hasta
    activación.
  - `skip` sigue siendo de v1 a propósito: el techo de skips y su contador no cambian con la
    segmentación, y una segunda implementación dejaría a las dos discrepar sobre cuántos quedan.

- [x] **Añadir selección de objetivo**
  - Files: `src/routes/onboarding/goal.tsx`, `src/routes/onboarding/welcome.tsx`, `src/shared/lib/landing-segment-hint.ts`
  - Do: selector accesible, hint validado, confirmación y persistencia.
  - Verify: Playwright signup → goal, URL manipulada y cambio de objetivo.
  - Result: `src/routes/onboarding/goal.tsx`, `src/shared/lib/landing-segment-hint.ts` (6 tests) y
    `tests/e2e/onboarding-goal.spec.ts` (7 specs). `welcome` ahora enlaza a `goal`, y el recorrido v1
    de `onboarding.spec.ts` se actualizó para atravesarlo por "I would rather not say" — el camino que
    funciona con la segmentación encendida o apagada, porque no escribe nada.
  - **El hint preselecciona y nunca persiste.** La URL la controla cualquiera: escribir desde ella
    metería en una cuenta una preferencia que nadie expresó. Decide qué radio nace marcado y nada
    más; la escritura ocurre al confirmar, con `source: onboarding`. Un hint manipulado devuelve
    exactamente lo mismo que no traer hint, porque si un valor inválido diera un resultado distinto
    la URL sería una forma de sondear qué acepta el enum. Los tres casos están en el e2e.
  - **El paso tolera la función apagada**: un 404 de la API de preferencias deja continuar en vez de
    dejar a alguien tirado a mitad del onboarding. Por eso no hace falta un segundo camino de código
    para el flag en cada posición.
  - Encontrado por su propio test: el parser del hint fallaba con un path relativo
    (`/onboarding/goal?goal=hiring`) — `new URL()` lo rechaza y el fallback troceaba la cadena entera
    como una sola clave, devolviendo "sin hint" en silencio. Y un path relativo es justo lo que
    entrega un loader de ruta, así que el caso roto era el común.

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
