# Plan de entrega — candidaturas delegadas

> **Status**: `pending`
> **Depends on**: [`job-opportunities-workspace`](../job-opportunities-workspace/spec.md), [`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md), [`security-and-multitenancy`](../../phase-1/security-and-multitenancy/spec.md)
> **Blocks**: nothing
> **Reality check**: Crea un dominio candidate-side nuevo y separado de [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/spec.md), de `candidate_submissions` y de [`ats-integrations`](../ats-integrations/spec.md). Extiende ficheros existentes: `src/shared/lib/db/schema.ts`, `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/ai/tasks.ts`, `src/shared/lib/billing/rate-cards.ts`, `src/shared/lib/repositories/account-privacy.ts`, `src/shared/lib/operational-schedules.ts`, `src/modules/dashboard/ui/shell/nav-config.ts`, `scripts/check-tenant-boundaries.mjs`, `scripts/db/verify-api-isolation-local.mjs`. Clona el patrón de `src/routes/api/admin/alerts/run-worker.ts` y la forma RLS de `drizzle/0085_candidate_documents_rls_grants.sql`. No añade cron nuevo para retención: reutiliza `legal.retention`.

Las fases están en orden de dependencia y **cada una es enviable por sí sola**. La regla de corte
es: si el trabajo se detiene al final de cualquier fase, lo entregado sigue siendo un producto
coherente y honesto, no un esqueleto a medias.

Ninguna migración lleva número fijado aquí. Cada una se acuña con
`pnpm exec drizzle-kit generate --custom --name <nombre>` y el índice real se lee de
`drizzle/meta/_journal.json` en el momento de implementar. Las migraciones de solo grants **también**
llevan snapshot; `pnpm test:migration-integrity` falla si falta.

---

## Fase 0 — Política, registro de fuentes y corpus de evaluación

**Solo documentos. Cero código.**

Se aprueba por escrito el nivel de autonomía (preparar y asistir, nunca enviar), la lista de
acciones y preguntas prohibidas, el modelo de amenazas del handoff al portal, y el registro de
fuentes con titular, permiso, base jurídica y fecha de caducidad de revisión. Se construye el corpus
de evaluación de fit (parejas oferta↔perfil con veredicto humano) y se mide el coste real por
llamada para fijar los topes por defecto.

**Salida**: una política que hace imposible el envío desde servidor *por diseño*, y números de
coste con los que fijar `max_new_jobs_per_day` y `max_kits_per_day`.

**Criterio de salida**: `docs/architecture/application-agent-policy.md` (new) dice literalmente "el
servidor no envía"; `docs/operations/application-source-register.md` (new) tiene al menos una fuente con
`reviewExpiresAt` futura, o ninguna — y si es ninguna, la fase 6 arranca sin conectores y no pasa
nada.

**Rollback**: n/a.

---

## Fase 1 — Tracker manual (sin automatización, sin IA, sin red)

Esta es la fase que define el producto. **No contiene una sola llamada a un modelo, ni una sola
petición saliente, ni un solo worker.**

Tres tablas: `job_applications`, `application_answer_facts`, `application_events`, con sus CHECKs
(incluido el gate de aprobación), sus índices, RLS tenant+owner y grants por rol. Cinco permisos
owner-only en `permissions.ts`. Repositorios bajo `withTenantContext`. CRUD y máquina de estados.
Tablero personal en `/career/applications`. Banco de respuestas con la categoría `never_autofill`
que no puede almacenar valor. Línea de tiempo de eventos.

**Salida**: una persona registra a mano las candidaturas que envía por su cuenta, las enlaza a
ofertas de su workspace, y ve su historial. Esto es útil el día 1 y no depende de que el billing
esté activo, que hoy no lo está (`STRIPE_BILLING_ENABLED = false`).

**Criterio de salida**:
`pnpm test:rls:local && pnpm test:api-isolation:local && pnpm test:migration-integrity` verdes con
la nueva `checkApplications()`, incluida la prueba de que un admin de la organización recibe `404`;
E2E crear → mover → marcar enviada → archivar; `pnpm security:boundaries` con la regla nueva de
"sin envío externo" activa desde este momento, no al final.

**Rollback**: quitar la entrada de nav y la ruta oculta la feature. Las tablas quedan vacías y
aisladas; nada existente cambia de comportamiento.

---

## Fase 2 — Mandatos, runs y filtros duros (sobre ofertas ya guardadas)

Sigue sin IA y sin red. Tres tablas: `application_mandates`, `application_runs`,
`application_candidates`. Wizard de mandato con versionado, pausa, revocación y caducidad, y el
`allowed_actions <@ ARRAY['discover','score','prepare']` que deja `'submit'` fuera del dominio.
Worker HTTP idempotente clonado de `src/routes/api/admin/alerts/run-worker.ts`, con leases,
`assertCareerOrganizationIsPersonal` y cancelación. El run recorre **las ofertas ya guardadas del
propio usuario**, aplica los filtros duros deterministas y produce una shortlist con el motivo de
cada descarte.

**Salida**: un run produce una lista ordenada y explicable sin gastar un céntimo ni tocar la red.

**Criterio de salida**: un run sobre 200 ofertas sembradas termina < 5 s; doble golpe del cron el
mismo día crea un solo run; revocar el mandato detiene el run en curso con `partial`; los filtros
duros pasan su corpus tabular incluida la semántica de `unknown_kept`.

**Rollback**: `APPLICATION_RUNS_ENABLED=false` oculta el wizard y el worker se vuelve no-op. El
tracker manual de la fase 1 no se entera.

---

## Fase 3 — `candidate-job-fit`, score determinista y banda

Primera fase con IA. Registro de la task, `buildFitInput` con allowlist de tipos de hecho,
`computeFitScore` puro y versionado, bandas, y la ruta de impugnación. Rate card
`candidate_job_fit` con `minimumTier: 'pro'` y reserva de créditos antes de la llamada. Fallback
determinista sin banda.

**Salida**: shortlist ordenada con evidencia por requisito y una banda que nunca se muestra sola.

**Criterio de salida**: eval sobre el corpus de la fase 0 con concordancia de orden aceptable;
`computeFitScore` reproducible bit a bit sobre la misma entrada; con `AI_DISABLED=true` el run
completa y todas las candidatas quedan `fit_source = 'fallback'` sin banda;
`pnpm security:provider-metering` pasa sin añadir excepciones al allowlist.

**Rollback**: `AI_DISABLED_TASKS=candidate-job-fit`. La fase 2 sigue produciendo shortlists
deterministas sin ordenar por fit.

---

## Fase 4 — Kits inmutables, carta opcional y el gate de aprobación

`application_kits` con `content_hash` generado y contenido INSERT-only. Ensamblado del kit: CV
adaptado (del plan hermano), carta opcional (`application-cover-letter` con
`assertFactsAreConfirmed`), mapeo de respuestas desde el banco, preguntas sin resolver, blockers y
checklist. Pantalla de revisión con el texto completo editable y `reviewedAt`.
`POST /api/applications/$applicationId/approve` con `Idempotency-Key` obligatoria,
`assertApprovalCoversCurrentKit` y `409 approval_stale`.

**Salida**: ningún kit se aprueba con un blocker abierto ni con una afirmación sin hecho
confirmado detrás; y una aprobación cubre un contenido exacto, no "la candidatura".

**Criterio de salida**: doble clic en aprobar produce una fila; editar tras aprobar invalida;
`UPDATE cover_letter_text` sobre un kit `ready` falla con `42501` bajo `builderhunt_app`; el worker
recibe error al intentar `INSERT` de `approval.granted`; cero afirmaciones sin respaldo en el corpus
de release.

**Rollback**: `APPLICATION_KITS_ENABLED=false` deja el detalle sin sección de kit. Las fases 1–3
siguen intactas; las candidatas se pueden promover a `job_application` y trabajarse a mano.

---

## Fase 5 — Handoff al portal y prueba de que el servidor no envía

Enlace saliente validado con `validateExternalHttpUrl`, sin endpoint de redirección. Copia y
descarga del kit. Marcado manual de "enviada" con evento idempotente. Distinción explícita entre
`submitted_by_user` y `confirmed_submitted`.

**Salida**: evidencia E2E de que el servidor nunca envía. Esta es la fase cuyo entregable principal
es una **prueba negativa**.

**Criterio de salida**: un espía de red en el proceso del servidor durante el E2E completo registra
cero peticiones salientes que no sean `GET` hacia hosts externos; una URL con `javascript:`,
`data:` o un host privado no se renderiza como enlace; CSRF cubierto en cada mutación;
`pnpm security:boundaries` con la regla 1 activa.

**Rollback**: quitar el botón de abrir portal. El estado se sigue pudiendo marcar a mano.

---

## Fase 6 — Descubrimiento externo, scheduling, billing y notificaciones

Registro de conectores en `src/lib/applications/connectors/` (new) con política por fuente, robots
tri-estado que **para** ante `'unavailable'`, y `safeFetch` como única salida a la red. Los
resultados se entregan al import del workspace de ofertas; este plan no normaliza ni deduplica por
su cuenta. Cadencia diaria registrada en `src/shared/lib/operational-schedules.ts`. Reserva,
liquidación y liberación de créditos por run. Resumen por correo al propio usuario, opcional.

**Salida**: un run diario que no supera el mandato ni el presupuesto y que no consulta ninguna
fuente sin entrada vigente en el registro.

**Criterio de salida**: cada fixture de `tests/fixtures/application-sources/` (new) produce exactamente
el código de error esperado; un id de fuente ausente del registro no genera petición; el run
respeta `max_new_jobs_per_day`; cancelar libera el sobrante; el worker corre contra
`DATABASE_WORKER_URL` como el rol real `builderhunt_worker`, no como el owner.

**Rollback**: `APPLICATION_SOURCES_ENABLED=` vacío deja el conjunto ejecutable vacío y el
descubrimiento externo desaparece. Quitar la entrada de cron detiene el scheduling. Las fases 1–5
siguen funcionando sobre ofertas guardadas.

---

## Fase 7 — Privacidad, retención, hardening y release gate

Exportación de cuenta con las siete tablas, borrado duro con el orden de FK probado, retención
enganchada al sweep `legal.retention` existente, escaneo de logs, runbook, canal de incidencias, y
la suite completa de gates.

**Salida**: el ciclo de vida del sujeto está cerrado y demostrado.

**Criterio de salida**: `pnpm ci:local` verde; borrado duro de una cuenta con candidaturas, kits,
eventos y aprobaciones completa sin quedar bloqueada por `restrict`; el escaneo de logs no
encuentra texto de carta, respuesta ni CV.

**Rollback**: n/a — esta fase solo añade garantías.

---

## Riesgos

| # | Riesgo | Probabilidad | Radio de impacto | Mitigación | Decisión tomada |
| --- | --- | --- | --- | --- | --- |
| 1 | Alguien "mejora" el producto añadiendo envío automático en una iteración futura | Media | Catastrófico: daño reputacional al usuario ante empleadores reales, posible infracción de términos, irreversible | El suelo ético está en `spec.md` §No objetivos con las condiciones exactas para revisarlo; `allowed_actions` no admite `'submit'` a nivel de CHECK; `scripts/check-tenant-boundaries.mjs` prohíbe cualquier salida no-`GET` desde el dominio | Se elige la restricción en DDL y en CI antes que la advertencia en prosa. Una prosa se ignora en un PR; un CHECK no |
| 2 | El gate de aprobación se vuelve saltable por un bug de aplicación | Media | Alto: se envía material que el usuario no leyó | Cuatro mecanismos independientes en la base de datos (evento inmutable, CHECK de estado, policy que impide al worker escribir aprobaciones, hash generado sobre contenido INSERT-only) | Se rechaza el diseño de "flag `approved` en la fila", que un `UPDATE` descuidado activa. Un `NOT NULL` que apunta a una fila append-only, no |
| 3 | Grants olvidados: funciona como owner, `42501` como `builderhunt_app`/`builderhunt_worker` | **Alta** — es el modo de fallo documentado de este repo (`app-reality.md` constraint 7, cinco bugs reales en una sesión) | Alto: la feature falla en producción y no en CI | Migración de RLS+grants dedicada por fase, tabla de grants por rol explícita en `spec.md`, y `checkApplications()` en `scripts/db/verify-api-isolation-local.mjs` conectada como los roles reales antes de cerrar cada fase | Se exige que cada fase con tabla nueva cierre con la comprobación de aislamiento, no que se acumulen al final |
| 4 | El score de fit se lee como un veredicto sobre la persona | **Alta** | Alto: daño de producto directo al usuario, difícil de detectar porque no genera errores | Banda en vez de número por defecto; la banda nunca se renderiza sin la tabla de requisitos; copia obligatoria de qué NO significa; ruta de impugnación que retira la candidata del ranking | Se acepta el coste de UI (más superficie, más texto) a cambio de que el número nunca aparezca desnudo |
| 5 | La carta contiene una afirmación fabricada y el usuario la envía firmada | Media | Alto: consecuencia recae sobre el usuario, no sobre nosotros | `factIds.min(1)` en el esquema + `assertFactsAreConfirmed` contra `career_facts.status = 'confirmed'` + reintento + fallback sin carta | Se prefiere no generar carta antes que generar una plantilla plausible. Un hueco visible es honesto; un párrafo inventado no |
| 6 | SSRF o acceso a una fuente sin permiso a través de los conectores | Media | Alto: el servidor se convierte en proxy hacia la red interna, o infringimos términos de un tercero | Ocho defensas por salto, todas fail-closed; `safeFetch` obligatorio con test estático; robots `'unavailable'` **para**; registro de fuentes con caducidad | Se decide explícitamente que `'unavailable'` deniega. Tratar el tri-estado como booleano es el bug que este control existe para evitar |
| 7 | Un admin de la organización ve la búsqueda de empleo de un miembro | Media | Alto: es exactamente el daño que la doble clave existe para evitar; podría costarle el empleo a alguien | Predicado RLS tenant **y** owner en las siete tablas; permisos sin rama `elevated`; test negativo obligatorio que exige `404` y cuerpo vacío | Se exige `404` y no `403`: un `403` confirma la existencia del recurso, que ya es una filtración |
| 8 | Un reintento convierte una aprobación en dos acciones | Media | Alto | `Idempotency-Key` obligatoria + índice único `(org, application, event_type, key)`; replay devuelve el evento existente con `200`; `settleReservation` idempotente por `reservationId` | Se rechaza `Idempotency-Key` opcional: sin clave la mutación falla con `400`, no se acepta "por compatibilidad" |
| 9 | Mezclar dominio candidate y employer al reutilizar `pipeline_*` "porque se parece" | Media | Alto: fuga de datos entre modelos de consentimiento distintos | Sección dedicada en `spec.md` con la tabla de diferencias, más una prohibición de importación en `scripts/check-tenant-boundaries.mjs` | Se decide poner la guarda en CI. Un comentario en el código no sobrevive a un refactor |
| 10 | Un kit mutable hace que la aprobación no signifique nada | Media | Alto | Contenido INSERT-only por *grant* (ningún rol tiene `UPDATE` sobre las columnas de contenido) + `content_hash` como columna generada | Se descarta el enfoque de trigger o de comprobación en repositorio: la ausencia de grant no se puede olvidar en un PR |
| 11 | Se envía la fase 3 y nadie puede usarla porque `STRIPE_BILLING_ENABLED = false` | **Alta** (es el estado real hoy) | Medio: trabajo enviado en oscuro | Las fases 1 y 2 no dependen de IA ni de billing y son el producto lanzable hoy; el hecho está escrito en `spec.md` §Casos límite para que se descubra al planificar y no al integrar | Se ordena a propósito el valor sin IA antes que el valor con IA |
| 12 | La organización de carrera deja de ser personal y el predicado de solo-tenant del worker amplía el acceso | Baja | Alto | `assertCareerOrganizationIsPersonal` cuenta miembros al tomar el lease y aborta con `career_org_not_personal` | Se elige fallar ruidosamente antes que degradar en silencio |
| 13 | El borrado duro queda bloqueado por `ON DELETE restrict` y la cuenta es imborrable | Media (ya pasó en este repo, `drizzle/0026_deleted_user_sentinel.sql`) | Alto: incumplimiento de derechos del interesado | Orden de borrado en 7 pasos escrito en `spec.md` §Retención y probado explícitamente en `checkLegalRunWorker` con una cuenta que tiene aprobaciones y kits | Se prueba el orden con datos reales, no se razona sobre él |
| 14 | Coste descontrolado en un run grande | Media | Medio | Filtros duros antes de la IA (con CHECK que lo hace estructural), reserva por run con máximo visible, tope diario en el mandato, cache de 7 días para fit | La carta se deja sin cache a propósito: reutilizarla es el modo de fallo "spam" |
| 15 | Migración a mano sin snapshot deja `pnpm test:migration-integrity` en rojo | Media (`0045` lo hizo) | Bajo | Toda migración se acuña con `drizzle-kit generate --custom`; snapshot, journal y `migration-hashes.json` aparecen en el `Files:` de cada tarea | Sin excepción para las de solo grants |
| 16 | Colisión de merge con los dos planes hermanos en `schema.ts`, `tasks.ts`, `permissions.ts`, `rate-cards.ts` | **Alta** — los tres tocan los mismos cuatro ficheros | Bajo, pero costoso en tiempo | Identificadores únicos por plan; este plan posee solo `candidate-job-fit` y `application-cover-letter`; los conectores viven en `src/lib/applications/` (new), no en `src/lib/jobs/` (new, del plan hermano); el campo de propietario reutiliza `creatorUserId` en vez de añadir uno nuevo | Se acepta un nombre de campo menos claro a cambio de no colisionar. Si el hermano añade `ownerUserId`, este plan lo adopta |
| 17 | Alcance que se desliza hacia "delegación total por lote" durante la fase 6 | Media | Alto | La fase 6 añade descubrimiento y cadencia, nunca aprobación ni envío; el wizard no tiene casilla de envío porque el dominio de `allowed_actions` no la admite | La ausencia del valor en el CHECK es la defensa; no hay que recordar no marcarla |

---

## Rollback por fase

Cada fase tiene su propio interruptor, y desactivar una fase superior nunca rompe una inferior:

| Fase | Interruptor | Qué queda funcionando |
| --- | --- | --- |
| 1 | Quitar la entrada de nav y la ruta | Nada del dominio es visible; nada existente cambia |
| 2 | `APPLICATION_RUNS_ENABLED=false` | Tracker manual completo |
| 3 | `AI_DISABLED_TASKS=candidate-job-fit` | Runs con shortlist determinista, sin orden por fit |
| 4 | `APPLICATION_KITS_ENABLED=false` | Todo lo anterior; las candidatas se promueven y se trabajan a mano |
| 5 | Quitar el botón de abrir portal | El estado se marca a mano igual |
| 6 | `APPLICATION_SOURCES_ENABLED=` vacío; quitar la entrada de cron | Runs sobre ofertas guardadas |
| 7 | n/a | — |

Reglas transversales:

- **Solo recuperación hacia adelante.** Las migraciones de producción son inmutables y forward-only
  (`_meta/security-policy.md` regla 9). Un rollback de esquema es una migración nueva que suelta en
  orden seguro de FK: eventos → kits → candidatas → runs → mandatos → respuestas → candidaturas.
- **Ningún estado enviado se revierte.** Si una candidatura está en `submitted_by_user` o
  `confirmed_submitted`, ningún rollback la mueve hacia atrás: el usuario envió algo en el mundo
  real y el sistema no puede fingir lo contrario.
- **Revocar un mandato es inmediato** y no espera al siguiente ciclo del worker: el worker
  comprueba el estado al inicio de cada item.
- **Las reservas de crédito se liberan** en cualquier cancelación o fallo, y `settleReservation` es
  idempotente, así que un rollback a mitad de liquidación no cobra dos veces.
