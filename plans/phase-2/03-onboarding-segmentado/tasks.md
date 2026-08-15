# Tareas — onboarding segmentado

> **Status**: `implemented`
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

- [x] **Implementar rama hiring**
  - Files: `src/routes/onboarding/search.tsx`, `src/routes/onboarding/save.tsx`
  - Do: parametrizar copy, starter queries y activación por builders guardados.
  - Verify: e2e hasta activación y dashboard.
  - Result: `onboarding-shared.ts` parametriza copy y starter queries **por preset** (10 tests);
    `search.tsx` lee el suyo de `/api/onboarding/v2`, con `general` como respuesta a cualquier fallo
    — un paso que no renderizara porque una preferencia no cargó sería peor producto que uno que
    muestra el copy general. `save.tsx` pide activación al terminar.
  - Las rutas difieren en **qué sugieren buscar**, no en tono: quien contrata quiere gente disponible,
    quien invierte quiere qué se está construyendo, y un builder quiere encontrarse a sí mismo.
    Reescribir las mismas cinco queries en cuatro voces habría sido personalización que cambia
    títulos, que es el modo de fallo que el README de la fase nombra explícitamente. Un test lo pina.
  - `other` comparte ruta con `general` a propósito, y el test lo afirma: `other` *es* la experiencia
    general, no una quinta variante.
  - **La activación se pide, no se afirma.** `save.tsx` envía `activationType`, y el servidor recuenta
    la evidencia antes de escribir nada. Dos e2e cubren las dos mitades: sin evidencia no activa, y
    con tres builders reales en `onboarding_selected_builders` sí — sin la segunda, un endpoint que no
    activara nunca satisfaría a la primera. Un tercero prueba que no re-activa: el primer acto real es
    el que cuenta, y una segunda activación movería `activated_at` y corrompería cualquier medida de
    tiempo hasta activación.
  - **No cubierto**: el recorrido completo por navegador hasta el dashboard. El e2e que existe llega a
    la activación por la API con evidencia real en la base; el paso por la UI de búsqueda depende de
    resultados de proveedores externos y sería una prueba que falla por motivos ajenos al plan.

- [x] **Implementar rama investing**
  - Files: `src/routes/onboarding/investing.tsx`, `src/shared/lib/onboarding-shared.ts`
  - Do: configurar tema y crear saved query/alert usando APIs existentes.
  - Verify: e2e confirma recurso tenant-scoped y no promete deal-flow inexistente.
  - Result: `src/routes/onboarding/investing.tsx`, `src/shared/lib/onboarding-investing.ts` (16 tests),
    la composición de tesis en `onboarding-shared.ts` y `tests/e2e/onboarding-investing.spec.ts`
    (8 specs). `goal.tsx` ya enruta por `entryRouteFor`, así que elegir `investing` lleva a su rama y
    todo lo demás sigue en el flujo general.
  - **Armar no es guardar.** La activación del spec es "primera búsqueda guardada con alerta/radar",
    y las alertas son de pago: `/api/alerts` responde 402 sin `paidActionsAllowed` y una organización
    recién creada está en `free`. Dejarlo ahí habría hecho que esta rama solo pudiera activar a quien
    ya había pagado, y su tasa de activación mediría la conversión a Pro y no la ruta. Así que armar
    tiene dos formas reales — alerta en el camino de pago, capacidad de feed (RSS privado, sin gate)
    en el gratuito — y la pantalla dice cuál de las dos ocurrió. `none` también es un resultado: una
    búsqueda que nadie va a entregar no se anuncia como si sí.
  - **La evidencia se cuenta, ya no se infiere.** `countActivationEvidence` lee filas:
    alertas con `query_id` y habilitadas, capacidades de feed no revocadas, y claims en `pending` o
    `verified`. La ruta derivaba `savedSearchesWithAlert` de "existe una saved query", que era el
    mismo hecho que `trackedBuilders` con otro nombre y habría activado a alguien cuya búsqueda no
    miraba nadie. La atribución es por persona aunque el recurso sea de la organización: sin eso, un
    compañero armando una búsqueda marcaría como activado a todo el equipo.
  - Encontrado por su propio e2e: `recordActivation` era un `UPDATE`, y esta rama activa a alguien
    que todavía no tiene fila en `onboarding_progress` — arma la búsqueda directamente desde el paso
    de objetivo. El UPDATE afectaba a cero filas y reportaba éxito; la activación desaparecía. Ahora
    es un upsert, y el guardia de "no sobreescribir" sigue haciéndolo de una sola vez.
  - **No cubierto**: el paso v2 (`current_step_key`) no lo escribe todavía ninguna pantalla, así que
    el funnel por step key aún no tiene datos. Es trabajo de la tarea de instrumentación, no de esta.

- [x] **Implementar rama building**
  - Files: `src/routes/onboarding/building.tsx`, `src/routes/onboarding/success.tsx`
  - Do: localizar perfil y enlazar claim; soportar estado pendiente.
  - Verify: e2e claim found/not-found/pending y salida skippable.
  - Result: `src/routes/onboarding/building.tsx`, `src/routes/api/builders/claim/candidates.ts`,
    `findClaimCandidatesByHandle` y `tests/e2e/onboarding-building.spec.ts` (7 specs). Los tres
    estados que el spec pide están cubiertos, y el skip está en la primera pantalla, antes de pedir
    nada.
  - **Pendiente es una pantalla, no un spinner.** La verificación es asíncrona por diseño: el
    reclamante publica un challenge en la cuenta que reclama y el producto lo comprueba después. Así
    que el estado pendiente enseña el challenge, dónde ponerlo y un botón para volver a comprobar —
    "claim iniciado con siguiente paso claro", literalmente lo que pide el spec.
  - **La activación se registra al abrir el claim, no al verificarlo.** Esperar a la verificación
    haría que la tasa de activación de esta rama midiera con qué rapidez la gente se acuerda de
    editar un perfil en otro sitio. `countActivationEvidence` ya cuenta `pending` y `verified`.
  - **La búsqueda es por handle exacto.** Un prefijo sobre `builder_identities` sería un enumerador
    de handles para cualquier cuenta autenticada: escribe una letra y te devuelve a todo el índice.
    Quien busca su propia cuenta sabe cómo se escribe, así que la exactitud no le cuesta nada. Se
    filtra además por `kind = 'person'`, por fuentes con adaptador de prueba, y por supresión — una
    retirada de perfil que siguiera contestando "sí, esa persona está indexada" sería una retirada
    solo de nombre.
  - **"No encontrado" es una respuesta**, y no ofrece crear nada: el índice se construye de actividad
    pública, y una fila inventada por este flujo sería un perfil que nadie puede probar.
  - `success.tsx` dejó de contar una sola historia. Le decía a todo el mundo que su radar estaba
    activo, incluido quien acababa de reclamar su perfil sin guardar ninguna búsqueda — una frase
    simplemente falsa para esa persona. Ahora hay copy por ruta, con su acción concreta, y un test
    unitario que rechaza promesas que el producto no cumple (`deal flow`, visitas, oportunidades).
  - **No cubierto**: la llamada HTTP real a GitHub/GitLab/Codeberg/DEV. La bloquea el guardia de
    egress bajo `E2E_MODE` y el challenge se acuña por claim, así que ningún perfil real puede
    contenerlo — el seam de `claim-sources` la sustituye, igual que en `claimable-profiles.spec.ts`.

- [x] **Instrumentar y desplegar gradualmente**
  - Files: `src/shared/lib/conversion-events.ts`, `src/shared/lib/conversion-client.ts`, `src/routes/api/admin/metrics/conversion.ts`, `.env.example`, `docs/operations/segmented-onboarding-rollout.md`
  - Do: extender la analítica de conversión existente con funnels por step/segment/version y
    feature flag por cohorte.
  - Verify: flag off sirve v1; flag on completa las tres ramas; smoke mobile/desktop.
  - Result: `drizzle/0173_conversion_onboarding_funnel.sql`, tres eventos nuevos con su contexto,
    `src/shared/lib/onboarding-rollout.ts` (14 tests), `src/shared/lib/useOnboardingStep.ts` en las
    siete pantallas, el bloque `onboarding` en `/api/admin/metrics/conversion`,
    `tests/e2e/onboarding-rollout.spec.ts` (6 specs) y
    [`docs/operations/segmented-onboarding-rollout.md`](../../../docs/operations/segmented-onboarding-rollout.md).
  - **El funnel de la fase 02 no existía, y no por estar incompleto.** `conversion_events` tenía un
    CHECK con los siete eventos de landing y cuatro surfaces; `segment_selected` sobre `onboarding`
    lo violaba, y la ruta de ingesta captura el fallo, lo registra y responde `{ok: true}`. Además
    `recordConversionEvent` insertaba seis columnas y descartaba el contexto de segmento que el
    contrato sí validaba. Comprobado contra la base real antes y después: `23514
    conversion_events_name_check` → `INSERT ACCEPTED`.
  - **El índice de identidad ahora lleva el step.** `(session, name, surface, variant)` es correcto
    para un evento de landing que ocurre una vez, y es exactamente lo contrario para un flujo: el
    segundo `onboarding_step_viewed` de una sesión es *otro paso*, no un reintento, y
    `onConflictDoNothing` se lo habría tragado — un funnel por paso que solo podía enseñar el paso
    uno. `coalesce(..., '')` porque un NULL nunca iguala a otro NULL en un índice único.
  - **El reparto por cohorte es estable y solo suma.** `fnv1a(userId) % 100`, así que la misma
    persona recibe siempre el mismo flujo y subir el porcentaje nunca le quita el flujo a alguien que
    está a mitad. Un valor ilegible se satura a 0: "off" nunca puede ser "todo el mundo". El e2e no
    reinicia el servidor para probar las dos posiciones — no puede — sino que a 50 % busca una cuenta
    a cada lado de la línea, que además demuestra que el bucket controla la interfaz de verdad.
  - **La máquina v2 por fin la mueve alguien.** `current_step_key` estaba construido, testeado y en
    `null` para todo el mundo: ninguna pantalla lo avanzaba. Ahora lo hace `complete()`, y solo en
    v2 — quien está fuera de la cohorte se salta el paso de objetivo, así que su segundo avance
    nombraría un paso que el servidor no reconoce y todos los siguientes darían 409. Correctos, pero
    ruido: lo cazó el colector estricto de `onboarding.spec.ts`.
  - Smoke real de móvil añadido con `@mobile-only` en las dos ramas. Sin la etiqueta, el proyecto
    `mobile` no ejecuta nada y `--project=mobile` reporta verde sin haber corrido un solo test.
  - **No cubierto**: `flow_version` sigue a la cohorte, no al camino recorrido, así que alguien
    dentro de la cohorte que teclee una URL de v1 se cuenta como v2. Documentado en el runbook.
