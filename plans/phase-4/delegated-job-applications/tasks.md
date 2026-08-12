# Tareas — candidaturas delegadas

> **Status**: `pending`
> **Depends on**: [`job-opportunities-workspace`](../job-opportunities-workspace/spec.md), [`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md), [`ai-expansion`](../../implemented/phase-1/21-ai-expansion/spec.md), [`security-and-multitenancy`](../../implemented/phase-1/01-security-and-multitenancy/spec.md)
> **Blocks**: nothing
> **Reality check**: Dominio candidate-side nuevo. No se modifican `pipeline_*` (propuestos en [`hiring-pipeline-kanban`](../hiring-pipeline-kanban/spec.md)), `candidate_submissions`, `organization_builders` ni integraciones ATS para almacenar candidaturas del job seeker. Se extienden ficheros reales de HEAD: `src/shared/lib/db/schema.ts`, `src/shared/lib/authorization/permissions.ts`, `src/shared/lib/ai/tasks.ts`, `src/shared/lib/billing/rate-cards.ts`, `src/shared/lib/repositories/account-privacy.ts`, `src/shared/lib/operational-schedules.ts`, `src/modules/dashboard/ui/shell/nav-config.ts`, `scripts/check-tenant-boundaries.mjs`, `scripts/db/verify-api-isolation-local.mjs`.

Ordenadas para que la app esté enviable después de cada casilla.

**Migraciones.** Ninguna tarea fija un número. Cada migración se acuña con
`pnpm exec drizzle-kit generate --custom --name <nombre>` y el índice real se lee de
`drizzle/meta/_journal.json` en el momento de implementar. Las de solo grants **también** llevan su snapshot en `drizzle/meta/`; `pnpm test:migration-integrity`
falla si falta. Tras cada
migración se regenera el manifiesto con `node scripts/db/verify-migration-integrity.mjs --write`.

**Dependencias externas.** `src/shared/lib/auth/career-principal.ts` (new) lo crea
[`job-opportunities-workspace`](../job-opportunities-workspace/spec.md); aquí solo se importa.
`job_opportunities` / `job_opportunity_versions` son de ese mismo plan; `career_facts` /
`resume_versions` / `career_profiles` son de
[`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md). Este plan no los
define.

---

## Fase 0 — Política, fuentes y corpus (solo documentos)

- [ ] **Aprobar la política de autonomía y el suelo ético**
  - Files: `docs/architecture/application-agent-policy.md` (new), `docs/architecture/threat-model.md`
  - Do: Escribir la política con los nueve puntos del suelo ético de `spec.md` §No objetivos,
    literalmente y numerados, más la sección "qué tendría que ser cierto para revisarlo"
    (legal, contractual, consentimiento, operativo, ADR). Añadir al `threat-model.md` existente una
    sección "candidate-side applications" con los actores (usuario, admin de su organización de
    empresa, worker, portal externo) y el árbol de ataque del gate de aprobación.
  - Verify: Revisión de producto/seguridad/privacidad registrada en el documento con fecha; el
    fichero contiene la frase exacta "el servidor no envía"; `grep -c "submit" ` sobre el documento
    devuelve solo apariciones en contexto de prohibición.

- [ ] **Crear el registro de fuentes y el corpus de evaluación**
  - Files: `docs/operations/application-source-register.md` (new), `docs/operations/application-agent-runbook.md` (new), `tests/fixtures/application-sources/README.md` (new)
  - Do: El registro copia el formato de `docs/operations/public-enrichment-source-register.md`: por
    fuente, `id`, titular, `acquisitionMode` (`official_api | authorized_crawl`), referencia de
    permiso, base jurídica, `reviewExpiresAt`, hosts permitidos, `maxRequestsPerMinute`. Si no hay
    ninguna fuente con permiso escrito, el registro se entrega **vacío** y la fase 6 arranca sin
    conectores; eso es un resultado válido, no un bloqueo. El runbook describe el canal de
    incidencias y el procedimiento cuando un usuario reporta una carta con un dato falso. El README
    de fixtures lista los 12 ficheros de `spec.md` §Descubrimiento externo y qué prueba cada uno.
  - Verify: Cada fuente listada tiene `reviewExpiresAt` futura y una referencia de permiso no vacía;
    ninguna fuente con `acquisitionMode: 'authorized_crawl'` carece de la nota de robots tri-estado.

---

## Fase 1 — Tracker manual (cero IA, cero red, cero worker)

- [ ] **Definir contratos y la máquina de estados de candidatura**
  - Files: `src/shared/lib/applications/contracts.ts` (new), `tests/unit/shared/lib/applications/contracts.test.ts` (new)
  - Do: Módulo puro, sin importar `db` ni `env`. Exporta
    `APPLICATION_STATUSES = ['discovered','shortlisted','preparing','needs_review','approved','submitted_by_user','confirmed_submitted','closed_rejected','withdrawn','discarded','archived'] as const`,
    `APPLICATION_EVENT_TYPES` (los 13 de `spec.md`),
    `APPROVAL_EVENT_TYPES = ['approval.granted','manual.self_reported_submission'] as const`,
    `ANSWER_CATEGORIES`, `ANSWER_SENSITIVITIES`, y la tabla de transiciones
    `ALLOWED_TRANSITIONS: Record<ApplicationStatus, readonly ApplicationStatus[]>`.
    `canTransition(from, to, ctx: { hasValidApproval: boolean })` devuelve
    `{ ok: true } | { ok: false; reason: 'illegal_transition' | 'approval_required' | 'approval_stale' }`
    y **niega** cualquier destino en `['approved','submitted_by_user','confirmed_submitted']` cuando
    `hasValidApproval` es falso. Nada aquí llama a red ni a un modelo.
  - Verify: `pnpm test applications/contracts` — cubre las 11×11 combinaciones (matriz exhaustiva),
    y en particular que ningún camino alcanza `approved` con `hasValidApproval: false`.

- [ ] **Añadir al schema las tres tablas del tracker**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: Añadir `jobApplications`, `applicationAnswerFacts` y `applicationEvents` exactamente como
    `spec.md` §Modelo de datos 1–3: todas con `organizationId` (`text`, `notNull`,
    `references(organizations.id, { onDelete: 'cascade' })`) y `ownerUserId` (`text`, `notNull`,
    `references(authUsers.id, { onDelete: 'restrict' })`). FK compuesta
    `(organizationId, jobOpportunityId) → jobOpportunities(organizationId, id)` `onDelete('cascade')`;
    `(organizationId, jobApplicationId) → jobApplications(organizationId, id)` `onDelete('cascade')`
    en eventos. Los CHECK literales del spec, incluidos
    `status NOT IN ('approved','submitted_by_user','confirmed_submitted') OR approval_event_id IS NOT NULL`,
    `event_type NOT IN ('approval.granted','manual.self_reported_submission') OR actor_kind = 'user'`,
    `event_type <> 'approval.granted' OR (approved_kit_id IS NOT NULL AND approved_content_hash ~ '^[0-9a-f]{64}$')`
    y `sensitivity <> 'never_autofill' OR (answer_text IS NULL AND answer_json IS NULL)`.
    Los índices del spec, incluido el único
    `(organization_id, owner_user_id, job_opportunity_id)` y el único
    `(organization_id, job_application_id, event_type, idempotency_key)`.
    `approved_kit_id` y `current_kit_id` se declaran ahora como `uuid` **sin FK** — la FK compuesta a
    `application_kits` se añade en la fase 4, cuando esa tabla exista.
  - Verify: `pnpm type-check`; `pnpm exec drizzle-kit check` pasa.

- [ ] **Generar la migración DDL del tracker**
  - Files: nueva migración bajo `drizzle/`, nuevo snapshot bajo `drizzle/meta/`, `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: `pnpm db:generate`; renombrar el tag a `<NNNN>_application_tracker` leyendo el índice
    siguiente real de `drizzle/meta/_journal.json` y actualizando la entrada del journal a juego.
    Leer el SQL emitido y confirmar que solo contiene `CREATE TABLE`, FKs, índices y CHECKs — ni
    un `DROP`, ni un `RENAME`, ni una reescritura de tabla existente. Regenerar el manifiesto con
    `node scripts/db/verify-migration-integrity.mjs --write`.
  - Verify: `pnpm db:migrate` sobre una base limpia; `\d job_applications` muestra el único de tres
    columnas y los CHECK; `pnpm test:migration-integrity` y `pnpm exec drizzle-kit check` pasan.

- [ ] **Escribir a mano la migración de RLS y grants del tracker**
  - Files: nueva migración `--custom` bajo `drizzle/`, nuevo snapshot bajo `drizzle/meta/`, `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: Acuñar con `pnpm exec drizzle-kit generate --custom --name application_tracker_rls_grants`.
    Espejo de `drizzle/0085_candidate_documents_rls_grants.sql`, con comentario de cabecera que
    declare la clase de dato y por qué el predicado es tenant **y** owner. Para las tres tablas:
    `ENABLE` + `FORCE ROW LEVEL SECURITY`, y una policy `FOR ALL TO builderhunt_app` con
    `USING`/`WITH CHECK` =
    `organization_id = nullif(current_setting('app.organization_id', true), '') AND owner_user_id = nullif(current_setting('app.user_id', true), '')`.
    Grants exactos:
    `GRANT SELECT, INSERT, UPDATE, DELETE ON job_applications TO builderhunt_app;`
    `GRANT SELECT, INSERT, UPDATE, DELETE ON application_answer_facts TO builderhunt_app;`
    `GRANT SELECT, INSERT ON application_events TO builderhunt_app;` — **sin `UPDATE`, sin
    `DELETE`**, con comentario explicando que el borrado de cuenta depende del `ON DELETE cascade`
    desde `job_applications`. `builderhunt_worker`, `builderhunt_platform`,
    `builderhunt_capability`, `builderhunt_auth` y `builderhunt_readonly` no reciben nada en esta
    fase. `REVOKE ALL ... FROM PUBLIC` en las tres. Sin `TRUNCATE`, sin `REFERENCES`.
  - Verify: `pnpm db:migrate`; `pnpm test:rls:local` y `pnpm test:migration-integrity` pasan;
    `psql -U builderhunt_app -c "select * from job_applications"` sin GUCs devuelve 0 filas (no un
    error); con `app.organization_id` de A y `app.user_id` de B devuelve 0 filas;
    `psql -U builderhunt_app -c "update application_events set payload='{}'"` falla con `42501`.

- [ ] **Registrar las tres tablas en la documentación de arquitectura**
  - Files: `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: Tres filas nuevas: clase `tenant private`, clave de propiedad
    `organization_id + owner_user_id`, campos públicos `none`, retención según `spec.md`
    §Retención ("vida de la cuenta, sin poda automática" para las tres). En la matriz de
    autorización, dejar constancia de que `owner`/`admin` de la organización **no** obtienen acceso,
    con el motivo.
  - Verify: Las tres tablas aparecen en ambos documentos; sin cambio de código.

- [ ] **Añadir los cinco permisos owner-only**
  - Files: `src/shared/lib/authorization/permissions.ts`, `tests/unit/shared/lib/authorization/permissions.test.ts`, `docs/architecture/authorization-matrix.md`
  - Do: Añadir a `PermissionAction`: `'application:read'`, `'application:mutate'`,
    `'application:approve'`, `'mandate:manage'`, `'answer-fact:manage'`. En el `switch` de `can()`,
    los cinco en un solo `case` agrupado que devuelve
    `resource.creatorUserId === principal.userId` — **sin rama `elevated`**, con un comentario que
    cite `spec.md` §Separación del dominio employer-side y siga el estilo del bloque `calendar:*`
    que ya está en el fichero por el mismo motivo. `creatorUserId` transporta `owner_user_id`;
    dejarlo comentado para el revisor.
  - Verify: `pnpm test permissions` — matriz de los tres roles × las cinco acciones, con
    `owner`/`admin` de la organización recibiendo `false` cuando `creatorUserId` es de otro usuario;
    `pnpm security:boundaries` sigue verde (ninguna comparación de rol en línea nueva).

- [ ] **Construir el repositorio de candidaturas y eventos**
  - Files: `src/shared/lib/repositories/job-applications.ts` (new)
  - Do: Toda función recibe `TenantTransaction` primero y filtra por `organizationId` **y**
    `ownerUserId`; el módulo nunca importa el `db` global (lo verifica
    `scripts/check-tenant-boundaries.mjs`). Exporta `listApplications`, `findApplication`,
    `createApplication`, `updateApplicationNote`, `transitionApplication`
    (aplica `canTransition`, escribe la fila y **un** evento en la misma transacción),
    `appendApplicationEvent(tx, orgId, ownerId, input)` con `idempotencyKey` obligatorio que ante
    violación del único devuelve `{ created: false, event: <existente> }` en vez de lanzar, y
    `listApplicationEvents`. Ningún `UPDATE` ni `DELETE` sobre `application_events`: el rol no tiene
    grant y el repositorio no debe intentarlo.
  - Verify: `pnpm type-check`; `pnpm security:boundaries`.

- [ ] **Probar los puntos de decisión del repositorio**
  - Files: `tests/unit/shared/lib/repositories/job-applications.test.ts` (new)
  - Do: Estilo de transacción falsa, como
    `tests/unit/shared/lib/repositories/account-privacy.test.ts`. Afirmar: todo constructor de
    consulta recibe predicado de `organizationId` **y** `ownerUserId`; `transitionApplication` con
    una transición ilegal no ejecuta `UPDATE` ni `INSERT`; una transición a `approved` sin
    aprobación válida se rechaza con `approval_required`; `appendApplicationEvent` replicado con la
    misma clave devuelve `created: false` y no inserta segunda fila; el repositorio nunca construye
    un `UPDATE`/`DELETE` sobre `applicationEvents`.
  - Verify: `pnpm test repositories/job-applications`.

- [ ] **Construir el repositorio del banco de respuestas**
  - Files: `src/shared/lib/repositories/application-answers.ts` (new), `tests/unit/shared/lib/repositories/application-answers.test.ts` (new)
  - Do: `listAnswerFacts`, `upsertAnswerFact`, `deleteAnswerFact`, `expireStaleAnswerValues`.
    `upsertAnswerFact` rechaza en la capa de aplicación cualquier intento de guardar valor cuando
    `sensitivity === 'never_autofill'` (el CHECK de la base es la segunda barrera, no la primera), y
    rechaza `source` distinto de `'user_entered' | 'user_confirmed_suggestion'`. Nada infiere una
    respuesta: no existe función que derive un valor de otro dato.
  - Verify: `pnpm test repositories/application-answers` — un `upsert` con
    `sensitivity: 'never_autofill'` y `answerText` no vacío lanza antes de tocar la base; el mismo
    intento por SQL directo falla con violación de CHECK.

- [ ] **Exponer la API CRUD de candidaturas**
  - Files: `src/routes/api/applications/index.ts` (new), `src/routes/api/applications/$applicationId.ts` (new), `src/shared/lib/applications/api.ts` (new)
  - Do: `resolveCareerPrincipal(request)` de `src/shared/lib/auth/career-principal.ts` (new — creado
    por [`job-opportunities-workspace`](../job-opportunities-workspace/spec.md)) →
    `withTenantContext`. `GET` lista con zod de query
    `{ status?: ApplicationStatus, cursor?: string, limit?: number ≤ 50 }`. `POST` con
    `{ jobOpportunityId: z.string().uuid(), ownerNote?: z.string().max(5000) }`. `PATCH` con
    `{ status?: ApplicationStatus, ownerNote?: string, deadlineAt?: string, resumeVersionId?: string }`
    y cabecera `Idempotency-Key` obligatoria cuando el cuerpo incluye `status`. Un
    `organizationId` del cliente se ignora siempre. Respuesta con **allowlist explícita de DTO**;
    nunca se difunde una fila del ORM. Un id que no pertenece al propietario devuelve `404` con
    cuerpo vacío, nunca `403`.
  - Verify: `curl -b session -X POST /api/applications -d '{"jobOpportunityId":"…"}'` crea y devuelve
    el DTO; una segunda llamada con el mismo `jobOpportunityId` devuelve `409 already_tracked`;
    `curl` sin sesión → `401`; `PATCH` con `status: 'approved'` → `422 approval_required`.

- [ ] **Exponer la API del banco de respuestas**
  - Files: `src/routes/api/career/application-answers/index.ts` (new), `src/routes/api/career/application-answers/$answerId.ts` (new)
  - Do: `GET`/`POST`/`PATCH`/`DELETE` bajo `can(principal, 'answer-fact:manage')`. El `POST` valida
    con zod: `question_key` `^[a-z0-9_]{1,64}$`, `category` en la lista, `sensitivity` en la lista,
    exactamente uno de `answerText`/`answerJson` salvo `never_autofill` que no admite ninguno.
    Las respuestas del `GET` incluyen el valor (es dato del propio interesado) pero la ruta añade
    cabecera `Cache-Control: no-store`.
  - Verify: `POST` con `sensitivity: 'never_autofill'` y valor → `400 value_not_allowed`; `GET`
    devuelve `no-store`; la sesión de otro usuario recibe `404` sobre un `answerId` ajeno.

- [ ] **Construir el tablero personal y engancharlo a la navegación**
  - Files: `src/routes/_dashboard/career/applications/index.tsx` (new), `src/modules/applications/ApplicationsBoard.tsx` (new), `src/modules/applications/ApplicationCard.tsx` (new), `src/modules/dashboard/ui/shell/nav-config.ts`
  - Do: Añadir la entrada `{ to: '/career/applications', label: 'Applications', icon: <lucide>, group: 'Career' }` al área de carrera de `NAV_AREAS`
    (la crean los planes hermanos; si aún no existe, añadirla con `id: 'career'` y
    `routes: ['/career']`). Tablero por estado con filtros y plazo próximo, construido con las
    primitivas existentes de `src/components/ui` (`button.tsx`, `select.tsx`, `dialog.tsx`) — sin
    tokens de diseño nuevos. Cada tarjeta tiene un `Select` "Mover a…" además del arrastre, y las
    transiciones se anuncian en una región `aria-live="polite"`.
  - Verify: `pnpm dev` — `/career/applications` renderiza y el rail se ilumina; navegación completa
    solo con teclado: tabular a una tarjeta, abrir el select, mover, y oír el anuncio;
    `pnpm type-check` con el árbol de rutas regenerado.

- [ ] **Construir el detalle, la línea de tiempo y los ajustes de respuestas**
  - Files: `src/routes/_dashboard/career/applications/$applicationId.tsx` (new), `src/modules/applications/ApplicationDetail.tsx` (new), `src/modules/applications/ApplicationTimeline.tsx` (new), `src/modules/applications/ApplicationAnswerSettings.tsx` (new)
  - Do: Detalle con oferta enlazada, nota privada, acciones de estado y la línea de tiempo desde
    `GET /api/applications/$applicationId` (los eventos vienen en el mismo DTO, no en una ruta
    aparte). Los ajustes de respuestas listan las categorías `never_autofill` con la etiqueta
    "nunca se rellenan automáticamente" y sin campo de valor — no deshabilitado: **ausente**.
  - Verify: Crear una candidatura, cambiar tres estados y ver los tres eventos en orden inverso con
    su actor; la sección `never_autofill` no tiene ningún `input`; auditoría a11y de la página sin
    violaciones de nivel serio.

- [ ] **Activar las cuatro guardas mecánicas de frontera activas desde esta fase**
  - Files: `scripts/check-tenant-boundaries.mjs`, `scripts/ci/local-quality.sh`, `tests/unit/security/application-boundaries.test.ts` (new)
  - Do: Añadir al script tres escaneos sobre los directorios `src/lib/applications/` (new),
    `src/shared/lib/applications/` (new) y `src/routes/api/applications/` (new):
    (1) **sin envío externo** — prohibir `method: 'POST'`, `method: 'PUT'`, `method: 'PATCH'`,
    `method: 'DELETE'` en cualquier literal de opciones de `fetch`, más `nodemailer`, `resend`,
    `smtp` y `sendMail`; sin entradas en el allowlist, porque este plan no envía nada a ningún
    tercero. (2) **sin escritura employer-side** — prohibir importar `organizationBuilders`,
    `organizationPipelineStages`, `organizationBuilderStageEvents`, `candidateSubmissions`,
    `candidateDocuments` o `~/shared/lib/repositories/pipeline`. (3) **propiedad de identificadores** —
    afirmar que este plan sólo registra `candidate-job-fit` y `application-cover-letter` en
    `src/shared/lib/ai/tasks.ts`, y que `src/lib/applications/**` no importa de `src/lib/jobs/**` (del
    plan hermano) ni al contrario. Y (4) enganchar `scripts/check-forbidden-claims.mjs` —el script del
    plan hermano, donde vive la lista de cifras desacreditadas— a `scripts/ci/local-quality.sh` si no lo
    está ya; **no se duplica la lista**, porque dos escáneres se desincronizarían. El test unitario
    nuevo ejecuta el script sobre un fixture con una violación de cada tipo y comprueba que falla con el
    mensaje correcto (evita que el escaneo se rompa en silencio).
    Las comprobaciones 3 (metering) y 4 (cobertura de rutas) de spec.md §Guardas mecánicas entran en
    las fases 3 y 1 respectivamente, cuando hay algo que medir; **son seis en total**, no dos.
  - Verify: `pnpm security:boundaries` verde sobre el árbol real; `pnpm test application-boundaries`
    — los fixtures con `method: 'POST'`, con un import de `pipeline`, con un task id ajeno y con un
    cruce `applications` → `jobs` fallan los cuatro.

- [ ] **Extender la comprobación de aislamiento de API con `checkApplications()`**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Nueva función registrada en `main()`. Cubre: la sesión del tenant B no ve candidaturas del
    tenant A; **un `owner` y un `admin` de la organización del propietario piden
    `GET /api/applications/$id` de otro miembro y reciben `404` con cuerpo vacío, no `403`** (test
    negativo obligatorio del contrato compartido de carrera); un `organizationId` inyectado en
    cuerpo o query no cambia nada; cambiar la organización activa de la sesión no altera el
    workspace; una lectura SQL directa como `builderhunt_app` sin `app.user_id` devuelve 0 filas;
    `UPDATE`/`DELETE` sobre `application_events` como `builderhunt_app` fallan con `42501`; un
    `INSERT` en `application_answer_facts` con `sensitivity='never_autofill'` y valor viola CHECK.
  - Verify: `pnpm test:api-isolation:local` — todas las comprobaciones nuevas pasan y ninguna
    existente regresa.

- [ ] **Implementar el import de hoja de cálculo**
  - Files: `src/shared/lib/applications/import.ts` (new), `src/routes/api/applications/import.ts` (new), `src/modules/applications/components/ApplicationImportDialog.tsx` (new), `tests/unit/shared/lib/applications/import.test.ts` (new)
  - Do: Módulo **puro** de parseo y mapeo, más una ruta que sólo persiste lo ya confirmado. Detección
    heurística de encabezados (empresa, puesto, fecha, estado, URL, notas) → **mapeo propuesto que la
    persona corrige** → previsualización con conteos (cuántas se crean, cuántas se saltan y por qué) →
    confirmar. Nada se escribe antes de la confirmación. Reglas duras:
    un estado que no mapea al dominio de `job_applications.status` cae en **`discovered`** y se marca en
    la previsualización, **nunca se adivina** ("waiting" no significa `submitted_by_user`);
    `job_opportunity_id` queda `null` si la fila no trae URL, y enlazarla después es opcional;
    `Idempotency-Key` obligatoria por import, con deduplicación por
    `(owner, empresa normalizada, puesto normalizado)` reportando las colisiones como **saltadas**, sin
    fusionar; una fila marcada como enviada entra como `submitted_by_user` con el evento
    `manual.self_reported_submission` y `actor_kind = 'user'`, y **`confirmed_submitted` es inalcanzable
    por esta vía** porque exige `confirmation_source` con evidencia externa que un CSV no aporta; límite
    duro de filas por import.
  - Verify: `pnpm test -- tests/unit/shared/lib/applications/import.test.ts` — un estado desconocido cae
    en `discovered`; reimportar el mismo fichero **no duplica**; una columna `status` con
    `confirmed_submitted` **no** produce ese estado; un CSV de 5.000 filas es rechazado por el límite.

- [ ] **Cerrar la fase 1 con E2E, el camino gratuito y la suite completa**
  - Files: `tests/e2e/career-applications.spec.ts` (new), `tests/e2e/applications-free-path.spec.ts` (new), `package.json`, `scripts/ci/local-quality.sh`
  - Do: Recorrido sin IA y sin red: crear una oferta manual en el workspace, crear la candidatura,
    editar la nota, mover `discovered → shortlisted → preparing`, intentar mover a `approved` y
    comprobar que la UI lo impide con el mensaje de aprobación requerida, marcar enviada a mano,
    y archivar. Comprobar la línea de tiempo y que un segundo usuario no ve nada.
    Añadir además `pnpm test:e2e:applications-free-path`, que corre con
    **`STRIPE_BILLING_ENABLED=false` y `AI_DISABLED=true`** e incluye el **import de un CSV de 50
    filas**, y engancharlo a `scripts/ci/local-quality.sh`. Existe porque ése es el estado real de
    producción: no prueba un caso degradado, prueba el camino principal.
  - Verify: `pnpm exec playwright test tests/e2e/career-applications.spec.ts`;
    `pnpm test:e2e:applications-free-path` verde con ninguna ruta en 500 y ninguna acción de UI
    imposible de completar; después
    `pnpm lint && pnpm type-check && pnpm test && pnpm build && pnpm test:migration-integrity && pnpm test:rls:local && pnpm test:api-isolation:local && pnpm security:boundaries`.

---

## Fase 2 — Mandatos, runs y filtros duros (sigue sin IA y sin red)

- [ ] **Implementar los filtros duros deterministas**
  - Files: `src/shared/lib/applications/hard-filters.ts` (new), `tests/unit/shared/lib/applications/hard-filters.test.ts` (new)
  - Do: Módulo puro. `HARD_FILTER_CODES` con los nueve códigos de `spec.md` §Filtros duros.
    `evaluateHardFilters(job, mandate, context): { result: 'passed' | 'rejected' | 'unknown_kept'; reasons: Array<{ code: HardFilterCode; detail: string }> }`.
    Regla central, probada explícitamente: **si cualquiera de los dos lados de una comparación es
    desconocido, el resultado es `unknown_kept` con su razón, nunca `rejected`.** Sin acceso a red,
    sin acceso a base, sin ninguna característica protegida en la firma de entrada.
    Cada código lleva además su **clase**: `knockout` (`sponsorship_incompatible`,
    `explicit_legal_requirement_unmet`, `location_mismatch` — elegibilidad objetiva, y el filtro que de
    verdad elimina: una sola pregunta de sponsorship descarta ~30 % en roles técnicos),
    `preference` (`employment_type_mismatch`, `salary_below_floor`, `company_excluded` — vienen del
    mandato) y `housekeeping` (`job_expired`, `already_applied`, `duplicate_in_run`). La clase **no**
    cambia si se descarta, sólo cómo se explica: un knockout se presenta como un hecho sobre el mundo;
    una preferencia se presenta con enlace a la regla del mandato que la produjo y que la persona
    **puede cambiar**. Un filtro de preferencia que no se puede localizar ni revertir se lee como una
    caja negra.
  - Verify: `pnpm test hard-filters` — corpus tabular con al menos un caso por código, más los casos
    de desconocido: salario no publicado, sponsorship desconocido en un lado, ubicación ausente. **Un
    knockout con cualquiera de los dos lados desconocido sigue siendo `unknown_kept`**, no `rejected`.
    Un test estático comprueba que el tipo de entrada no contiene `age`, `gender`, `nationality`,
    `photo` ni `birthDate`.

- [ ] **Añadir la recencia del anuncio como desempate del ranking**
  - Files: `src/shared/lib/applications/ranking.ts` (new), `tests/unit/shared/lib/applications/ranking.test.ts` (new)
  - Do: La edad del anuncio (de `job_opportunities`) entra en el orden de la shortlist **sólo como
    desempate**, nunca sustituyendo al fit: una oferta fresca con encaje bajo no sube por encima de una
    buena de hace una semana. Las de menos de 72 h se marcan visualmente en la cola de revisión. Si la
    fecha de publicación es desconocida, no se penaliza ni se premia — mismo criterio que
    `unknown_kept`. Justificación y su límite en spec.md §Recencia: 52 % de los reclutadores revisa por
    orden de llegada, pero es correlación reportada, no un experimento, así que se implementa como
    desempate y aviso y **no como promesa de resultado**.
  - Verify: `pnpm test -- tests/unit/shared/lib/applications/ranking.test.ts` — dos candidatas con el
    mismo `fit_score` se ordenan por recencia; una candidata reciente con `fit_score` menor **no**
    adelanta a otra mejor; `postedAt = null` no altera el orden relativo.

- [ ] **Añadir al schema mandatos, runs y candidatas**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: `applicationMandates`, `applicationRuns` y `applicationCandidates` exactamente como
    `spec.md` §Modelo de datos 4–6, con `organizationId` + `ownerUserId` y FKs compuestas. El CHECK
    que materializa el suelo ético:
    `check('application_mandates_allowed_actions_check', sql\`${table.allowedActions} <@ ARRAY['discover','score','prepare']::text[]\`)`.
    Los índices únicos parciales
    `UNIQUE (organization_id, owner_user_id) WHERE status = 'active'` y
    `UNIQUE (organization_id, owner_user_id, idempotency_key)` en runs. En candidatas, los CHECK
    `hard_filter_result <> 'rejected' OR fit_score IS NULL` y
    `fit_contested_at IS NULL OR (fit_band IS NULL AND rank IS NULL)`. Añadir la FK compuesta
    `(organizationId, applicationRunId) → applicationRuns(organizationId, id)` en `jobApplications`.
  - Verify: `pnpm type-check`; `pnpm exec drizzle-kit check`; un `INSERT` manual con
    `allowed_actions = '{submit}'` es rechazado por CHECK.

- [ ] **Generar la migración DDL de mandatos y runs**
  - Files: nueva migración bajo `drizzle/`, nuevo snapshot bajo `drizzle/meta/`, `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: `pnpm db:generate`, renombrar el tag a `<NNNN>_application_mandates_runs` con el índice real
    del journal, leer el SQL y confirmar que es puramente aditivo, y regenerar el manifiesto.
  - Verify: `pnpm db:migrate` sobre base limpia; `pnpm test:migration-integrity` y
    `pnpm exec drizzle-kit check` pasan.

- [ ] **Escribir a mano la migración de RLS y grants de mandatos, runs y candidatas**
  - Files: nueva migración `--custom` bajo `drizzle/`, nuevo snapshot bajo `drizzle/meta/`, `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: `pnpm exec drizzle-kit generate --custom --name application_runs_rls_grants`. `ENABLE` +
    `FORCE` en las tres, policy `FOR ALL TO builderhunt_app` con el predicado tenant+owner. Añadir
    ahora las policies del worker, con la justificación en comentario de por qué el worker usa solo
    el predicado de organización (la organización de carrera es personal y tiene un miembro):
    `builderhunt_worker` `SELECT` en `application_mandates`, `SELECT/INSERT/UPDATE` en
    `application_runs` y `application_candidates`, `SELECT` + la policy de `UPDATE` restringida de
    `spec.md` §El gate de aprobación punto 3 sobre `job_applications`, y la policy de `INSERT`
    restringida sobre `application_events` que prohíbe los `event_type` de clase aprobación.
    Grants column-scoped exactamente como la tabla de `spec.md`:
    `GRANT UPDATE (status, status_changed_at, updated_at) ON job_applications TO builderhunt_worker;`
    y el conjunto de columnas de `application_runs`. `builderhunt_platform` y el resto, nada.
  - Verify: `pnpm db:migrate`; `pnpm test:rls:local`; como `builderhunt_worker` con
    `app.organization_id` puesto, `INSERT INTO application_events (…, event_type) VALUES (…, 'approval.granted')`
    falla por policy, y `UPDATE job_applications SET status='approved'` también.

- [ ] **Construir el repositorio de mandatos**
  - Files: `src/shared/lib/repositories/application-mandates.ts` (new), `tests/unit/shared/lib/repositories/application-mandates.test.ts` (new)
  - Do: `listMandates`, `findActiveMandate`, `createMandate` (siempre `version = 1`, `status = 'draft'`,
    `allowedActions = []` — deny-by-default), `publishMandate`, `reviseMandate` (inserta
    `version + 1` y marca la anterior `superseded` en la misma transacción), `pauseMandate`,
    `revokeMandate`, `expireMandates`. `resolveExecutableSourceIds(mandate, env)` intersecta
    `allowed_source_ids` con el registro compilado y con `APPLICATION_SOURCES_ENABLED`, siguiendo el
    patrón exacto de `resolveExecutableConnectorIds` en `src/lib/enrichment/policies.ts`: la lista
    de entorno solo puede **estrechar**.
  - Verify: `pnpm test application-mandates` — un mandato nuevo no permite ninguna acción hasta que
    se publica; `reviseMandate` deja exactamente un `active`; `resolveExecutableSourceIds` con un id
    inventado en el mandato devuelve conjunto vacío; revocar es inmediato.

- [ ] **Exponer la API y el wizard de mandato**
  - Files: `src/routes/api/application-mandates/index.ts` (new), `src/routes/api/application-mandates/$mandateId.ts` (new), `src/routes/_dashboard/career/applications/mandate.tsx` (new), `src/modules/applications/MandateWizard.tsx` (new)
  - Do: Rutas bajo `can(principal, 'mandate:manage')`. Zod de cuerpo con
    `allowedActions: z.array(z.enum(['discover','score','prepare'])).max(3)` — el enum **no incluye
    envío**, así que el cliente no puede pedirlo ni por accidente; `maxNewJobsPerDay: z.number().int().min(1).max(50)`;
    `maxKitsPerDay: z.number().int().min(0).max(10)`; `expiresAt` con tope de 90 días desde ahora.
    El wizard muestra un preview de "qué haría este mandato" y una línea fija:
    "Este mandato nunca envía una candidatura. Tú apruebas y envías cada una."
  - Verify: `POST` con `allowedActions: ['submit']` → `400` de zod; `expiresAt` a 120 días →
    `400 expiry_too_far`; revocar devuelve `200` y `findActiveMandate` pasa a `null` de inmediato;
    la sesión de otro usuario recibe `404`.

- [ ] **Construir el servicio de runs sobre ofertas guardadas**
  - Files: `src/lib/applications/run-service.ts` (new), `tests/unit/lib/applications/run-service.test.ts` (new)
  - Do: `planRun(mandate, savedJobs, now)` puro: aplica `evaluateHardFilters` a cada oferta, respeta
    `max_new_jobs_per_day`, ordena de forma determinista (sin fit todavía) y devuelve las candidatas
    a insertar con sus razones. **Sin acceso a red en este módulo.** `assertCareerOrganizationIsPersonal(tx, organizationId)`
    cuenta filas de `organization_members` y lanza `CareerOrgNotPersonalError` si es > 1.
  - Verify: `pnpm test run-service` — el tope diario se respeta exactamente; una oferta ya aplicada
    sale con `already_applied`; dos ofertas idénticas en la misma entrada colapsan con
    `duplicate_in_run`; `assertCareerOrganizationIsPersonal` lanza con dos miembros.

- [ ] **Construir el worker de runs y su endpoint de administración**
  - Files: `src/lib/applications/run-worker.ts` (new), `tests/unit/lib/applications/run-worker.test.ts` (new), `src/routes/api/admin/applications/run-worker.ts` (new)
  - Do: El worker clona la forma de `src/shared/lib/repositories/alerts-worker.ts`
    (`listWorkerOrganizationIds` + `withWorkerOrganization`), una transacción por organización, el
    fallo de una nunca aborta otra (se acumulan en `errors[]`). Toma lease con
    `UPDATE ... WHERE status IN ('queued','running') AND (lease_expires_at IS NULL OR lease_expires_at < now())`,
    sube `attempt_count`, y a los 5 intentos deja el run en `failed` con `error_code = 'lease_lost'`.
    Comprueba el estado del mandato **al inicio de cada item**, no solo del run. La ruta clona
    `src/routes/api/admin/alerts/run-worker.ts` verbatim en estructura:
    `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`, envoltura
    `withJobRun({ jobKey: 'applications.run' })` de
    `src/shared/lib/repositories/platform-operations.ts`, y
    `auditPlatformAdminAction({ action: 'admin.worker.run', targetType: 'worker', targetId: 'applications' })`.
  - Verify: **Ejecutarlo contra `DATABASE_WORKER_URL` conectado como el rol real
    `builderhunt_worker`, no como el owner de la base** (`app-reality.md` constraint 7). Con un
    mandato activo y 200 ofertas sembradas: primer `POST` devuelve `jobsSeen: 200` y candidatas
    creadas en < 5 s; segundo `POST` inmediato no crea un run nuevo (misma `idempotency_key` del
    día); revocar el mandato a mitad deja `status: 'partial'` y `error_code: 'mandate_revoked'`
    conservando lo producido; una sesión no-admin recibe `401`/`403`.

- [ ] **Exponer la API y la UI de runs**
  - Files: `src/routes/api/application-runs/index.ts` (new), `src/routes/api/application-runs/$runId.ts` (new), `src/routes/api/application-runs/$runId/cancel.ts` (new), `src/routes/_dashboard/career/applications/runs/$runId.tsx` (new), `src/modules/applications/ApplicationRunPage.tsx` (new)
  - Do: `POST /api/application-runs` lanza un run manual (`trigger: 'manual'`) con
    `Idempotency-Key`. `GET $runId` devuelve contadores, coste y candidatas ordenadas con sus
    razones de filtro. `POST cancel` marca `cancelled`, libera cualquier reserva y no toca lo ya
    producido. La UI muestra progreso, incluir/excluir por candidata y el motivo textual de cada
    descarte.
  - Verify: E2E de un run manual: lanzar, ver progreso, cancelar a mitad, comprobar que las
    candidatas ya creadas siguen ahí; refrescar la página no relanza el run; lector de pantalla
    anuncia el cambio de estado del run.

- [ ] **Añadir el interruptor de fase y cerrar la fase 2**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: Añadir `APPLICATION_RUNS_ENABLED` (booleano en texto, default `'false'`) al esquema zod de
    entorno y a `.env.example` con un comentario que diga qué desactiva y qué sigue funcionando (el
    tracker manual, entero).
  - Verify: Con `APPLICATION_RUNS_ENABLED=false` el wizard no se renderiza, la ruta de run devuelve
    `404` y `pnpm test:e2e` de la fase 1 sigue verde;
    `pnpm lint && pnpm type-check && pnpm test && pnpm test:api-isolation:local` verdes.

---

## Fase 3 — Encaje explicable

- [ ] **Construir el cálculo de score determinista**
  - Files: `src/shared/lib/applications/fit-score.ts` (new), `tests/unit/shared/lib/applications/fit-score.test.ts` (new)
  - Do: Puro. `FIT_FORMULA_VERSION = 1`. `DEFAULT_REQUIREMENT_WEIGHTS` por veredicto
    (`meets: 1, partial: 0.5, missing: 0, unknown: 0` con el `unknown` **fuera del denominador**, no
    contado como fallo). `computeFitScore(requirements, weights)` → entero 0–100 redondeado con una
    regla fija. `bandForScore(score)` → `'low' | 'medium' | 'high'` con cortes documentados
    (`< 40`, `40–69`, `≥ 70`). `applyContest(requirements, requirementId)` pone peso 0 y devuelve un
    conjunto nuevo. Reproducible: misma entrada, mismo entero, siempre.
    `FIT_WEIGHTS` lleva **procedencia en el código**, no intuición: los tres pesos que entran
    (cobertura de `must`, cobertura de `nice`, y bonus por evidencia con métrica) se derivan de lo que
    los reclutadores dijeron que miran — experiencia y skills relevantes **88 %**, logros medibles
    **52 %** (spec.md §Pesos de `computeFitScore`). Los criterios de estructura, formato y longitud
    **no** son pesos de fit: son checks de higiene del plan hermano, y mezclarlos aquí convertiría el
    score en un juicio sobre el documento en vez de sobre la cobertura de requisitos.
  - Verify: `pnpm test fit-score` — 500 entradas aleatorias con semilla producen el mismo resultado
    en dos ejecuciones; un conjunto con todo `unknown` devuelve `null`, no `0` (que se leería como
    "malo" en vez de "sin información"); impugnar el único requisito `meets` baja la banda; los
    umbrales reales del mercado (`< 75 %` y `< 7 de 10 skills`) se **simulan** sobre el corpus para
    saber cómo se comporta la salida bajo ellos, sin que ninguno se convierta en objetivo de la
    fórmula — sólo el 8 % de los empleadores los tiene activados.

- [ ] **Construir `<FitBand>` con la tabla de requisitos como invariante**
  - Files: `src/modules/applications/ui/fit-band.tsx` (new), `tests/unit/modules/applications/fit-band.test.tsx` (new)
  - Do: `<FitBand band requirements />` con `requirements` como **prop obligatoria**, y
    `throw new Error('fit_band_requires_requirements')` si llega vacía. No es un guard defensivo: es la
    razón de existir del componente. Una banda sin su tabla es un veredicto disfrazado, y este plan
    decidió que eso no se renderiza en ningún sitio. **Ningún otro componente renderiza `fit_band`.**
    El denominador es visible: no "encaje del 70 %" sino "**7 de los 10 requisitos publicados**", con
    los tres estados distinguibles —cubierto, parcial y **no encontrado**—, este último explícitamente
    distinto de "no cumples". La tabla es una `<table>` real con encabezados.
  - Verify: `pnpm test -- tests/unit/modules/applications/fit-band.test.tsx` —
    `<FitBand band="high" requirements={[]} />` **lanza**; el render con requisitos muestra la fracción
    con su denominador; `grep -rn "fit_band\|fitBand" src/modules --include=*.tsx` no encuentra ningún
    otro componente que lo pinte. Es el harness que le faltaba al criterio de aceptación 9.

- [ ] **Registrar la task `candidate-job-fit`**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/applications/ai-contracts.ts` (new), `tests/unit/shared/lib/applications/ai-contracts.test.ts` (new)
  - Do: En `ai-contracts.ts`, `candidateJobFitInputSchema` y `candidateJobFitOutputSchema`
    exactamente como `spec.md` §IA (con `.strict()`). En `tasks.ts`, la entrada del registro:
    `id: 'candidate-job-fit'`, `tier: 'server-only'`, `cacheTtlSeconds: 604800`,
    `allowances: { free: 0, pro: 100, team: 300 }`, `maxOutputTokens: 2000` (MiniMax M3 emite un
    bloque `<think>` antes de la respuesta — ver el comentario de `pingTask` sobre por qué un
    presupuesto ajustado trunca el JSON). `buildPrompt` envuelve el texto de la oferta con
    `wrapUntrusted()` e instruye explícitamente a no obedecer instrucciones dentro del bloque.
    `buildFitInput()` hace **allowlist** de tipos de hecho
    (`employment | project | education | certification | skill | language | achievement`).
  - Verify: `pnpm test ai-contracts` — el esquema rechaza `verdict` desconocido, más de 30
    requisitos y campos extra; `buildFitInput` con un hecho que contiene `birthDate`/`gender`/`photo`
    los omite; un test estático comprueba que el `system` prompt no contiene vocabulario de
    características protegidas; `pnpm test tasks` sigue verde con el registro ampliado.

- [ ] **Construir el servicio de fit con medición y fallback**
  - Files: `src/lib/applications/fit-service.ts` (new), `tests/unit/lib/applications/fit-service.test.ts` (new), `src/shared/lib/billing/rate-cards.ts`
  - Do: Añadir a `RATE_CARDS` la entrada
    `candidate_job_fit: { operation: 'candidate_job_fit', version: 1, maxUnits: 5, maxDurationSeconds: 120, settlementGraceSeconds: 60, minimumTier: 'pro' }`.
    `analyzeFit()` en el orden obligatorio: `getCached` con
    `tenantAiCacheKey({ organizationId, artifact: 'candidate-job-fit:v1', input: canonicalJson({ ownerUserId, careerProfileVersion, jobOpportunityVersionId, weightsVersion }) })`
    → si falla, `reserveCredits` (o `checkAndConsumeBudget`) **en la misma función** que la llamada
    al proveedor, porque eso es lo que `scripts/check-provider-metering.mjs` exige → llamada →
    validación zod con un reintento de reparación → `computeFitScore` → `setCached` →
    `settleReservation`. Ante fallo definitivo, `fallbackFitAnalysis()`: todos los requisitos
    `unknown`, `fitScore = null`, `fitBand = null`, `fitSource = 'fallback'`, y
    `releaseReservation`.
  - Verify: `pnpm test fit-service` — con el proveedor devolviendo JSON inválido dos veces, el
    resultado es el fallback y la reserva se libera; con `AI_DISABLED=true` no hay llamada al
    proveedor; `pnpm security:provider-metering` pasa **sin añadir ninguna entrada al allowlist**.

- [ ] **Integrar el fit en el worker y evaluar contra el corpus**
  - Files: `src/lib/applications/run-worker.ts` (new), `scripts/evals/candidate-job-fit-eval.ts` (new)
  - Do: El worker puntúa solo las candidatas con `hard_filter_result <> 'rejected'`, escribe
    `fit_evidence`, `fit_score`, `fit_band`, `fit_formula_version`, `fit_source` y `rank`, y respeta
    el `min_fit_band` del mandato al decidir la shortlist. El eval corre el corpus de la fase 0 y
    reporta concordancia de orden y tasa de `unknown`.
  - Verify: `pnpm exec tsx scripts/evals/candidate-job-fit-eval.ts` publica las métricas (es un
    script, no un test de vitest: `vitest.config.ts` solo incluye la carpeta `tests/unit/`); con
    `AI_DISABLED_TASKS=candidate-job-fit` el run completa y todas las candidatas quedan
    `fit_source = 'fallback'` sin banda; el CHECK impide que una rechazada por filtro duro tenga
    score.

- [ ] **Presentar la banda con su tabla de requisitos, nunca sola**
  - Files: `src/modules/applications/FitEvidencePanel.tsx` (new), `src/modules/applications/ApplicationRunPage.tsx` (new), `tests/unit/modules/applications/FitEvidencePanel.test.tsx` (new)
  - Do: El componente renderiza la banda **y** la tabla de requisitos como una sola unidad; el
    número 0–100 solo dentro del panel de evidencia con la etiqueta "cobertura de requisitos
    publicados (0–100)". Copia fija encima: "Mide cuántos requisitos publicados están respaldados
    por hechos que confirmaste. No predice si te contratarán." La tabla es un `<table>` real con
    `<th scope="col">`. Cada fila tiene el botón "esto no es correcto".
  - Verify: `pnpm test FitEvidencePanel` — renderizar solo con `band` y sin `requirements` lanza en
    tiempo de desarrollo (la prop es obligatoria y no admite lista vacía); el número no aparece en
    el DOM del resumen colapsado; auditoría a11y de la tabla sin violaciones.

- [ ] **Implementar la impugnación del análisis**
  - Files: `src/routes/api/application-candidates/$candidateId/contest.ts` (new), `src/shared/lib/repositories/application-candidates.ts` (new)
  - Do: `POST` con `{ requirementId?: string, reason: z.string().max(500) }` bajo
    `can(principal, 'application:mutate')`. Escribe `fit_contested_at`/`fit_contested_reason`, pone
    `fit_band = NULL` y `rank = NULL` (el CHECK lo exige), emite `fit.contested` en
    `application_events`, y devuelve la candidata recalculada. Si el usuario en su lugar añade un
    hecho de carrera confirmado, `recomputeFitScore()` recalcula **sin llamar al modelo**.
  - Verify: Impugnar deja la candidata fuera del ranking y con banda vacía; el evento aparece en la
    línea de tiempo; añadir un hecho confirmado recalcula sin incrementar el contador de llamadas al
    proveedor.

---

## Fase 4 — Kits inmutables y el gate de aprobación

- [ ] **Añadir al schema `application_kits` y `application_kit_claim_facts`**
  - Files: `src/shared/lib/db/schema.ts`
  - Do: También `applicationKitClaimFacts` como `spec.md` §Modelo de datos 8: PK compuesta
    `(organization_id, kit_id, claim_id, fact_id)`, FK compuesta a
    `applicationKits(organizationId, id)` `cascade`, FK compuesta a
    `careerFacts(organizationId, id)` **`restrict`** —borrar un hecho no puede dejar huérfana una
    afirmación de una carta ya enviada—, `check (claim_id ~ '^c[0-9a-f]{12}$')` con el mismo formato y
    generador que `resume_claim_facts`, y `check (support in ('direct','derived'))`. Existe porque sin
    ella la carta tiene **dos** capas de veracidad donde el CV tiene cuatro, incumpliendo el contrato
    publicado #7 del plan hermano; `cover_letter_fact_ids` queda como proyección desnormalizada para el
    hash, no como fuente de verdad.
    Y `applicationKits` como `spec.md` §Modelo de datos 7, con `contentHash` declarado
    `.generatedAlwaysAs(sql\`encode(sha256(convert_to(...)), 'hex')\`)` sobre la expresión exacta del
    spec, y los CHECK `status <> 'ready' OR jsonb_array_length(blockers) = 0` y
    `(status = 'superseded') = (superseded_at IS NOT NULL)`. Añadir ahora las FK compuestas
    pendientes de la fase 1: `(organizationId, currentKitId) → applicationKits(organizationId, id)`
    `onDelete('set null')` en `jobApplications`, y
    `(organizationId, approvedKitId) → applicationKits(organizationId, id)` `onDelete('restrict')`
    en `applicationEvents`; más
    `(organizationId, approvalEventId) → applicationEvents(organizationId, id)`
    `onDelete('restrict')` en `jobApplications`.
  - Verify: `pnpm type-check`; `pnpm exec drizzle-kit check`; tras migrar, dos filas con el mismo
    contenido tienen el mismo `content_hash` y cambiar una coma en `cover_letter_text` lo cambia.

- [ ] **Generar la migración DDL de kits y las FKs pendientes**
  - Files: nueva migración bajo `drizzle/`, nuevo snapshot bajo `drizzle/meta/`, `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: `pnpm db:generate`, tag `<NNNN>_application_kits` con el índice real del journal.
    Comprobar en el SQL que la columna generada se emite como `GENERATED ALWAYS AS (...) STORED` y
    que las tres FKs nuevas son `ADD CONSTRAINT`, no reescrituras de tabla. Incluye
    `application_kit_claim_facts` con sus dos FK compuestas.
  - Verify: `pnpm db:migrate` sobre base limpia; `INSERT` que menciona `content_hash` falla con
    `cannot insert a non-DEFAULT value into column`; **un `INSERT` en `application_kit_claim_facts` con
    un `fact_id` de otro `organization_id` falla por FK**, y un `DELETE` de un `career_facts` enlazado
    falla por `restrict`; `pnpm test:migration-integrity` pasa.

- [ ] **Escribir a mano la migración de RLS y grants de kits**
  - Files: nueva migración `--custom` bajo `drizzle/`, nuevo snapshot bajo `drizzle/meta/`, `drizzle/meta/_journal.json`, `drizzle/migration-hashes.json`
  - Do: `pnpm exec drizzle-kit generate --custom --name application_kits_rls_grants`. `ENABLE` +
    `FORCE`. Policies: `application_kits_app_select` (`FOR SELECT`, tenant+owner),
    `application_kits_app_insert` (`FOR INSERT`, tenant+owner), y
    `application_kits_app_supersede` (`FOR UPDATE`) exactamente como el bloque SQL de `spec.md`
    §Modelo de datos 7, cuyo `WITH CHECK` limita el estado resultante a `'superseded' | 'blocked'`.
    Grants **column-scoped**, con comentario de cabecera explicando que la inmutabilidad del
    contenido es un grant y no una convención:
    `GRANT SELECT, INSERT ON application_kits TO builderhunt_app;`
    `GRANT UPDATE (status, superseded_at) ON application_kits TO builderhunt_app;`
    `GRANT SELECT, INSERT ON application_kits TO builderhunt_worker;`
    `GRANT UPDATE (status, superseded_at, credits_settled) ON application_kits TO builderhunt_worker;`
    Ningún rol recibe `UPDATE` sobre `cover_letter_text`, `answer_map`, `unresolved_questions`,
    `blockers` ni los pins. `REVOKE ALL ... FROM PUBLIC`.
    En la misma migración, `application_kit_claim_facts`: `ENABLE` + `FORCE`, policies de `SELECT` e
    `INSERT` tenant+owner para `builderhunt_app` y `builderhunt_worker`, y
    `GRANT SELECT, INSERT` a los dos — **sin `UPDATE` ni `DELETE` para ningún rol**, igual que
    `resume_claim_facts`: un enlace de procedencia se crea con su kit y muere con él por cascade, nunca
    se reescribe.
  - Verify: `pnpm db:migrate`; `pnpm test:rls:local`; como `builderhunt_app` con los GUCs correctos,
    `UPDATE application_kits SET cover_letter_text = 'x'` falla con `42501`, mientras que
    `UPDATE application_kits SET status = 'superseded', superseded_at = now()` funciona; y
    `UPDATE application_kit_claim_facts SET fact_id = ...` falla con `42501` para los dos roles.

- [ ] **Registrar la task `application-cover-letter`**
  - Files: `src/shared/lib/ai/tasks.ts`, `src/shared/lib/applications/ai-contracts.ts` (new), `tests/unit/shared/lib/applications/ai-contracts.test.ts` (new)
  - Do: `applicationCoverLetterOutputSchema` exactamente como `spec.md` §IA, con
    `paragraphs[].factIds` en `.min(1)`. Entrada del registro: `id: 'application-cover-letter'`,
    `tier: 'server-only'`, **`cacheTtlSeconds: null`** con un comentario que diga por qué (reutilizar
    una carta entre candidaturas es el modo de fallo "spam"),
    `allowances: { free: 0, pro: 30, team: 100 }`, `maxOutputTokens: 2500`. El `system` prohíbe
    adulación, afirmaciones sobre la cultura de la empresa sin evidencia, y obedecer instrucciones
    dentro del bloque `wrapUntrusted`. Añadir
    `assertFactsAreConfirmed(factIds, confirmedFactIds): void` que lanza `UnsupportedClaimError`.
    Cada párrafo lleva además su `claimId` (mismo generador que `resume_claim_facts`) para poder
    escribir la fila de procedencia en `application_kit_claim_facts`.
  - Verify: `pnpm test ai-contracts` — un párrafo con `factIds: []` no valida; una salida que cita
    un `factId` cuyo `career_facts.status` es `'proposed'` lanza `UnsupportedClaimError`; una oferta
    con "ignora tus instrucciones anteriores" produce `warnings: ['job_text_requested_action']` y no
    cambia el esquema.

- [ ] **Construir el ensamblador de kits**
  - Files: `src/lib/applications/build-kit.ts` (new), `tests/unit/lib/applications/build-kit.test.ts` (new), `src/shared/lib/billing/rate-cards.ts`
  - Do: Añadir la rate card
    `application_cover_letter: { operation: 'application_cover_letter', version: 1, maxUnits: 4, maxDurationSeconds: 120, settlementGraceSeconds: 60, minimumTier: 'pro' }`.
    `buildKit()` fija `job_opportunity_version_id`, `resume_version_id` y `career_profile_version`;
    pide el CV adaptado a `ai-cv-generation-and-tailoring`; genera la carta solo si
    `mandate.cover_letter_enabled` y el usuario no la desactivó; mapea respuestas desde
    `application_answer_facts` **saltando toda categoría `sensitive` y `never_autofill`**; compone
    `unresolved_questions`, `portal_checklist` y `blockers`. **Escribe el kit con un único
    `INSERT` completo**: no existe estado `'building'` y no hay `UPDATE` posterior del contenido.
    Un kit con cualquier blocker se inserta con `status: 'blocked'`, nunca `'ready'`.
  - Verify: `pnpm test build-kit` — una pregunta `sensitive` sale en `unresolved_questions` y nunca
    en `answer_map`; una carta con un `factId` no confirmado deja el kit `blocked` con el blocker
    `unsupported_claim`; sin proveedor, el kit se inserta con `cover_letter_unavailable`; el
    ensamblador nunca emite un `UPDATE` sobre columnas de contenido.

- [ ] **Exponer la generación de kits y la pantalla de revisión**
  - Files: `src/routes/api/applications/$applicationId/kit.ts` (new), `src/modules/applications/ApplicationKitReview.tsx` (new), `src/routes/_dashboard/career/applications/$applicationId.tsx` (new)
  - Do: `POST` genera el siguiente `version` y actualiza `job_applications.current_kit_id`,
    marcando la versión anterior `superseded`. La pantalla muestra el texto **íntegro** de la carta
    en un editor, el diff frente al CV base, las respuestas con su origen, las preguntas sin
    resolver y los blockers. `reviewedAt` se registra en el cliente cuando el usuario abre el editor
    y alcanza el final del texto; hasta entonces, copiar, descargar y aprobar están deshabilitados.
    Editar la carta **no muta el kit**: genera la versión siguiente.
  - Verify: Generar un kit, editar la carta y comprobar que aparece `version: 2` y la v1 queda
    `superseded` con su hash intacto; el botón de aprobar está deshabilitado hasta desplazar el
    editor hasta el final; un kit con blocker no permite aprobar en absoluto.

- [ ] **Implementar la ruta de aprobación con idempotencia**
  - Files: `src/routes/api/applications/$applicationId/approve.ts` (new), `src/shared/lib/applications/approval.ts` (new), `tests/unit/shared/lib/applications/approval.test.ts` (new)
  - Do: `POST` bajo `can(principal, 'application:approve')`. Cabecera `Idempotency-Key` (uuid v4)
    **obligatoria**: sin ella, `400 idempotency_key_required`. El cuerpo toma **un** id de kit, no
    una lista, y no existe ruta de aprobación masiva. En una transacción: verificar
    `kit.status === 'ready'`, insertar `application_events` con `event_type: 'approval.granted'`,
    `actor_kind: 'user'`, `approved_kit_id`, `approved_content_hash = kit.content_hash`,
    `payload: { reviewedAt }`; actualizar `approval_event_id`, `approved_at` y
    `status = 'approved'`. `assertApprovalCoversCurrentKit(application, approvalEvent)` devuelve
    `409 approval_stale` cuando `current_kit_id <> approved_kit_id`, y emite `approval.invalidated`.
    Una clave repetida devuelve `200` con el evento existente.
  - Verify: `pnpm test approval`; doble `POST` con la misma clave produce **una** fila en
    `application_events` y dos respuestas `200` idénticas; sin cabecera → `400`; con el kit
    superseded → `409 approval_stale`; el CHECK impide alcanzar `approved` si se borra a mano el
    `approval_event_id`.

- [ ] **Probar que el gate de aprobación es inviolable desde los roles reales**
  - Files: `scripts/db/verify-api-isolation-local.mjs`
  - Do: Ampliar `checkApplications()` con, conectado como los roles reales:
    (a) `builderhunt_worker` intenta `INSERT INTO application_events (event_type) VALUES ('approval.granted')`
    → rechazado por policy; (b) `builderhunt_worker` intenta
    `UPDATE job_applications SET status = 'approved'` → rechazado por `WITH CHECK`;
    (c) `builderhunt_app` intenta `UPDATE application_kits SET cover_letter_text = 'x'` sobre un kit
    `ready` → `42501`; (d) `UPDATE job_applications SET status='approved', approval_event_id=NULL`
    → violación de CHECK; (e) no existe ningún endpoint que acepte una lista de ids para aprobar
    (comprobación estática sobre el árbol de rutas).
  - Verify: `pnpm test:api-isolation:local` — las cinco comprobaciones pasan y ninguna existente
    regresa.

- [ ] **Añadir el interruptor de kits y cerrar la fase 4**
  - Files: `src/shared/lib/env.ts`, `.env.example`
  - Do: `APPLICATION_KITS_ENABLED` (default `'false'`) en el esquema zod y en `.env.example`, con la
    nota de que desactivarlo deja el detalle sin sección de kit y no afecta a las fases 1–3.
  - Verify: Con el flag en `false`, `POST .../kit` devuelve `404` y el E2E de la fase 1 sigue verde;
    `pnpm lint && pnpm type-check && pnpm test && pnpm build && pnpm test:api-isolation:local`.

---

## Fase 5 — Handoff al portal y la prueba negativa

- [ ] **Construir el enlace saliente seguro**
  - Files: `src/shared/lib/applications/source-links.ts` (new), `tests/unit/shared/lib/applications/source-links.test.ts` (new)
  - Do: `resolveSafeApplicationUrl(rawUrl)` usa `validateExternalHttpUrl` de
    `src/shared/lib/security/url-policy.ts` y devuelve
    `{ ok: true; href: string } | { ok: false; reason: 'invalid' | 'private_network' | 'not_https' }`.
    **No existe endpoint de redirección del servidor** — sería un open redirect esperando a ocurrir;
    el `href` se renderiza como `<a target="_blank" rel="noopener noreferrer">` y, si no valida, se
    muestra el texto de la URL sin enlace.
  - Verify: `pnpm test source-links` — `javascript:`, `data:`, `http://`, `http://169.254.169.254/`
    y `https://user:pass@host/` devuelven `ok: false`; un `grep -r "Response.redirect" src/routes/api/applications` no
    encuentra nada.

- [ ] **Construir el handoff y el marcado manual de envío**
  - Files: `src/modules/applications/PortalHandoff.tsx` (new), `src/routes/api/applications/$applicationId/mark-submitted.ts` (new)
  - Do: El componente muestra el enlace validado, el checklist del portal, y botones de copiar y
    descargar el kit. Literal fijo: "Aprobar no envía nada. Tienes que enviar la candidatura tú en
    el portal del empleador." `POST mark-submitted` con `Idempotency-Key` y cuerpo
    `{ submittedAt?: string, reference?: z.string().max(200), confirmationSource?: z.enum(['portal_receipt','official_api']) }`.
    Sin `confirmationSource` el estado es `submitted_by_user`; con él y con evidencia,
    `confirmed_submitted`. Nunca al revés.
  - Verify: Marcar sin evidencia deja `submitted_by_user`; una segunda llamada con la misma clave no
    duplica el evento; CSRF cubierto (petición con `Origin` cruzado rechazada por
    `server/security.mjs`); intentar `confirmed_submitted` sin `confirmationSource` → `422`.

- [ ] **Probar por E2E que el servidor nunca envía**
  - Files: `tests/e2e/career-applications-handoff.spec.ts` (new)
  - Do: Recorrido completo con un portal falso servido localmente: mandato → run → fit → kit →
    revisión → aprobación → apertura del portal → envío **manual simulado por el test** → marcado.
    Durante toda la ejecución, un espía instalado en el proceso del servidor registra cada petición
    saliente. La aserción central: **cero peticiones salientes con método distinto de `GET`** hacia
    cualquier host que no sea el proveedor de IA configurado, y cero peticiones al portal falso
    originadas por el servidor.
  - Verify: `pnpm exec playwright test tests/e2e/career-applications-handoff.spec.ts`; el informe del
    espía se adjunta como artefacto y se revisa a mano una vez.

---

## Fase 6 — Descubrimiento externo, cadencia y billing

- [ ] **Crear el registro de políticas de fuentes de empleo**
  - Files: `src/lib/applications/connectors/policies.ts` (new), `src/lib/applications/connectors/types.ts` (new), `tests/unit/lib/applications/connectors/policies.test.ts` (new)
  - Do: Clonar la forma de `src/lib/enrichment/policies.ts`: `JOB_SOURCE_POLICIES` congelado con
    `id`, `acquisitionMode` (`'official_api' | 'authorized_crawl'`), `status`,
    `permissionReference`, `lawfulBasisReference`, `reviewExpiresAt`, `allowedHosts`,
    `maxRequestsPerMinute`; `getJobSourcePolicy(id)`;
    `resolveExecutableJobSourceIds(allowlistEnv, now)` que devuelve conjunto vacío cuando el
    allowlist está vacío y **nunca** devuelve una fuente `blocked`, ausente o con
    `reviewExpiresAt` pasada. Poblar solo con fuentes que tengan entrada vigente en
    `docs/operations/application-source-register.md` (new); si son cero, el registro se entrega vacío y el
    resto de la fase igualmente funciona (sin conectores no hay descubrimiento, que es el
    comportamiento correcto).
  - Verify: `pnpm test connectors/policies` — el mismo corpus de casos que
    `tests/unit/lib/enrichment/policies.test.ts`: allowlist con un id desconocido devuelve vacío;
    una política caducada nunca es ejecutable; el allowlist de entorno solo estrecha.

- [ ] **Construir los conectores sobre `safeFetch` y el robots tri-estado**
  - Files: `src/lib/applications/connectors/registry.ts` (new), `src/lib/applications/connectors/fake.ts` (new), `src/lib/applications/connectors/fetch-guard.ts` (new), `tests/unit/lib/applications/connectors/registry.test.ts` (new), `tests/fixtures/application-sources/` (new)
  - Do: Interfaz `listPostings(cursor)` paginada. `fetch-guard.ts` es el único punto de salida:
    llama a `safeFetch` de `src/lib/enrichment/network.ts` con `allowedHosts` de la política, y
    **antes**, solo si `acquisitionMode === 'authorized_crawl'`, llama a `isPathAllowedByRobots` de
    `src/lib/enrichment/robots.ts` y **exige exactamente `'allowed'`**:

    ```ts
    const decision = await isPathAllowedByRobots(origin, path, APPLICATION_USER_AGENT)
    // Tri-estado, no booleano. 'unavailable' significa "no pude leer robots.txt",
    // que NO es permiso. Fail-closed = denegar aquí, no dejarlo pasar.
    if (decision !== 'allowed') throw new SourceDeniedError(decision)
    ```

    Para `official_api`, robots no se consulta (igual que `robotsRequired: false` en la política de
    github de `src/lib/enrichment/policies.ts`). Cubo por host con `maxRequestsPerMinute`.
    `auth_required` y `rate_limited` terminan la fuente para todo el run. Ningún conector llama a
    `fetch` directamente. Crear los 12 fixtures listados en `spec.md` §Descubrimiento externo.
  - Verify: `pnpm test connectors/registry` — un test estático comprueba que ningún fichero bajo
    `src/lib/applications/connectors/` (new) contiene `fetch(` fuera de `fetch-guard.ts` (mismo patrón que
    `tests/unit/lib/enrichment/registry.test.ts`); cada uno de los 12 fixtures produce exactamente
    su código esperado, y `robots-unavailable.txt` produce `SourceDeniedError('unavailable')`, no
    una petición.

- [ ] **Integrar el descubrimiento en el worker de runs**
  - Files: `src/lib/applications/run-worker.ts` (new), `tests/unit/lib/applications/run-worker.test.ts` (new)
  - Do: Cuando `mandate.allowed_actions` incluye `'discover'` y
    `resolveExecutableJobSourceIds` devuelve un conjunto no vacío, el worker pide postings a cada
    conector y los entrega al import del workspace de ofertas — **este plan no normaliza ni
    deduplica por su cuenta**. Respeta `max_new_jobs_per_day` contando importaciones del día por
    propietario. Cada fallo de fuente escribe `error_code` y no aborta las demás fuentes.
  - Verify: Con el conector falso y `max_new_jobs_per_day: 5`, un run con 40 postings disponibles
    importa exactamente 5; con el allowlist de entorno vacío no se ejecuta ninguna petición
    (comprobado con un espía de red); una fuente que devuelve 403 deja `source_denied` y las demás
    terminan bien.

- [ ] **Registrar la cadencia diaria**
  - Files: `src/shared/lib/operational-schedules.ts`, `tests/unit/shared/lib/operational-schedules.test.ts`, `docs/operations/deploy-runbook.md`
  - Do: Añadir a `OPERATIONAL_SCHEDULES` la entrada
    `{ jobKey: 'applications.run', cronExpression: '0 6 * * *', timezone: 'Europe/Copenhagen', scope: 'organization', label: 'Career application runs', sourceRoute: '/api/admin/applications/run-worker' }`.
    Cadencia diaria y en zona local porque es un trabajo que un humano nota. Documentar la entrada
    de cron en la tabla de workers del runbook, con la nota de que la retención va por
    `legal.retention` y **no** se añade cron nuevo para ella.
  - Verify: `pnpm test operational-schedules` — `assertRegistryIsSafe` pasa y `sourceRoute` apunta a
    una ruta que autentica con `tryCronPrincipal ?? requirePlatformAdminPrincipal`; el runbook lista
    la entrada.

- [ ] **Cerrar el ciclo de billing del run**
  - Files: `src/shared/lib/applications/billing.ts` (new), `tests/unit/shared/lib/applications/billing.test.ts` (new)
  - Do: `reserveRunBudget(tx, principal, { runId, estimatedFitCalls, estimatedLetterCalls })` llama a
    `reserveCredits` de `src/shared/lib/billing/feature-authorization.ts` con
    `idempotencyKey = 'application-run:' + runId`; `settleRunBudget` liquida el uso real;
    `releaseRunBudget` libera en cancelación o fallo. El coste máximo se calcula desde
    `RATE_CARDS` y se devuelve al cliente **antes** de lanzar el run.
  - Verify: `pnpm test applications/billing` — cancelar a mitad libera el sobrante; una liquidación
    replicada con el mismo `reservationId` no cobra dos veces; con
    `STRIPE_BILLING_ENABLED=false`, `checkEntitlement` devuelve `no_subscription` y el run termina
    con `error_code: 'budget_exceeded'` sin llamar al proveedor (y esa es la ruta que se observa
    hoy en producción).

- [ ] **Añadir el resumen opcional por correo y el interruptor de fuentes**
  - Files: `src/shared/lib/email.ts`, `src/shared/lib/env.ts`, `.env.example`
  - Do: `sendApplicationRunSummaryEmail(to, summary)` modelado sobre `sendAlertDigestEmail` del
    mismo fichero: mismo envoltorio `dispatchEmail`, mismo registro en modo dev cuando falta
    `RESEND_API_KEY`. El destinatario es **siempre la dirección del propio propietario del run**,
    nunca otra. El cuerpo lleva contadores y enlaces a `/career/applications`, y **nunca** texto de
    carta, respuestas ni descripción de oferta. Añadir `APPLICATION_SOURCES_ENABLED` (lista
    separada por comas, default vacía) y `APPLICATION_CANDIDATE_RETENTION_DAYS` (default `180`) al
    esquema zod y a `.env.example`.
  - Verify: Con `RESEND_API_KEY` sin definir, la función registra la vista previa y devuelve sin
    lanzar; con `APPLICATION_SOURCES_ENABLED` vacío el conjunto ejecutable es vacío; el cuerpo del
    correo no contiene ninguna de las claves de la lista de redacción.

---

## Fase 7 — Privacidad, retención y release gate

- [ ] **Añadir las ocho tablas a la exportación de cuenta**
  - Files: `src/shared/lib/repositories/account-privacy.ts`, `tests/unit/shared/lib/repositories/account-privacy.test.ts`
  - Do: Extender `loadAccountExportSource` con siete secciones JSON, incluidas las respuestas del
    banco y el texto íntegro de las cartas: son datos del propio interesado y no se omiten del
    export (se omiten del **log**, que es distinto). Cada sección se lee dentro del contexto de
    tenant del propietario.
  - Verify: `pnpm test account-privacy` — una cuenta con candidaturas, kits, eventos y respuestas
    exporta las ocho secciones; una cuenta sin datos de carrera exporta ocho arrays vacíos, no
    ausencias.

- [ ] **Implementar el borrado duro con el orden de FK probado**
  - Files: `src/shared/lib/repositories/account-privacy.ts`, `tests/unit/shared/lib/repositories/account-privacy.test.ts`, `scripts/db/verify-api-isolation-local.mjs`
  - Do: Dentro del bucle `withTenantContext` por membresía de `hardDeleteAccountSubject`, los siete
    pasos de `spec.md` §Retención **en ese orden exacto**: (1) `UPDATE job_applications SET approval_event_id = NULL, current_kit_id = NULL`,
    (2) `DELETE application_events`, (3) `DELETE application_kits` (que borra
    `application_kit_claim_facts` por `cascade`, así que **no** necesita paso propio — pero el test debe
    demostrarlo en vez de asumirlo, porque su FK a `career_facts` es `restrict` y un orden equivocado
    dejaría la cuenta imborrable), (4) `DELETE application_candidates`,
    (5) `DELETE application_runs`, (6) `DELETE application_mandates`, (7) `DELETE job_applications`
    (que además borra respuestas por su propia consulta). Comentar por qué el paso 1 existe: las FK
    `restrict` desde `job_applications` hacia eventos y kits crearían un ciclo aparente y dejarían la
    cuenta imborrable, que es el fallo que `drizzle/0026_deleted_user_sentinel.sql` documenta. **No**
    se usa `DELETED_USER_SENTINEL_ID`: aquí no hay recurso propiedad de la organización que deba
    sobrevivir al usuario.
    **Orden entre planes**: `career_facts` sólo se puede borrar **después** de que este dominio haya
    soltado sus kits, porque `application_kit_claim_facts.fact_id` es `restrict`. El plan hermano borra
    hechos en su propio paso; si los dos dominios existen, este bloque va antes. Es la clase de
    dependencia que se prueba con datos, no se razona.
  - Verify: `pnpm test account-privacy`; y en `pnpm test:api-isolation:local`, extender
    `checkLegalRunWorker` con una cuenta sembrada que tiene una aprobación, dos kits, **una carta con
    tres filas de `application_kit_claim_facts` apuntando a hechos de carrera** y diez eventos: el
    borrado duro completa sin quedar bloqueado por `restrict`, y ninguna fila huérfana queda en las ocho
    tablas. El caso de la carta es el que importa: es el único enlace `restrict` que sale de este
    dominio hacia el hermano.

- [ ] **Enganchar la retención al barrido legal existente**
  - Files: `src/shared/lib/legal.ts`, `tests/unit/shared/lib/legal.test.ts`
  - Do: Añadir `pruneApplicationCandidates(now)`: borra `application_candidates` con
    `disposition <> 'promoted'` y sus `application_runs` sin candidatas promovidas más antiguos que
    `APPLICATION_CANDIDATE_RETENTION_DAYS`; vacía el valor de `application_answer_facts` cuyo
    `valid_until` venció hace más de 30 días conservando `question_key` y `label`; borra kits
    `failed`/`blocked` no promovidos con más de 90 días. Se invoca desde el flujo que ya sirve
    `/api/admin/legal/run-worker` (`jobKey: 'legal.retention'`). **No se añade cron nuevo.**
  - Verify: `pnpm test legal` — el barrido es idempotente (segunda ejecución borra 0) y nunca toca
    una candidata `promoted`, un kit referenciado por una aprobación, ni una `job_applications`;
    `curl -X POST /api/admin/legal/run-worker` como admin devuelve los contadores nuevos.

- [ ] **Verificar la redacción de logs y payloads**
  - Files: `src/shared/lib/applications/redaction.ts` (new), `tests/unit/shared/lib/applications/redaction.test.ts` (new)
  - Do: `APPLICATION_EVENT_PAYLOAD_SCHEMA` en zod con `.strict()` que **rechaza** cualquier clave
    fuera del allowlist (`reviewedAt`, `kitVersion`, `contentHashPrefix`, `errorCode`, `sourceId`,
    `requirementId`) en vez de confiar en quien escribe. `redactForLog(value)` elimina
    `cover_letter_text`, `answer_text`, `answer_json`, texto de `career_facts`,
    `submitted_reference`, `source_url` con query string y correo. Todo `console.*` del dominio pasa
    por ella.
  - Verify: `pnpm test redaction` — un payload con `coverLetterText` es rechazado por el esquema; un
    escaneo estático comprueba que ningún fichero del dominio llama a `console.log` con un objeto
    sin pasar por `redactForLog`; ejecutar el E2E completo con captura de stdout y confirmar por
    `grep` que no aparece ni una frase de la carta de prueba.

- [ ] **Cerrar el release gate**
  - Files: `docs/operations/application-agent-runbook.md` (new), `docs/architecture/data-classification.md`, `docs/architecture/authorization-matrix.md`
  - Do: Completar el runbook con: cómo desactivar cada fase, qué hacer ante un reporte de dato falso
    en una carta, cómo retirar una fuente del registro, y a quién escalar. Registrar las cuatro
    tablas que faltaban (`application_mandates`, `application_runs`, `application_candidates`,
    `application_kits`) en la clasificación de datos y los permisos en la matriz. Marcar en el
    runbook que las fases 3–6 salen "en oscuro" mientras `STRIPE_BILLING_ENABLED` sea `false`.
  - Verify: `pnpm ci:local` verde de principio a fin; además
    `pnpm test:migration-integrity && pnpm test:rls:local && pnpm test:api-isolation:local && pnpm test:migrations:local && pnpm security:boundaries && pnpm security:route-coverage && pnpm security:provider-metering && pnpm db:audit-schema`;
    y `pnpm exec playwright test tests/e2e/career-applications.spec.ts tests/e2e/career-applications-handoff.spec.ts`.
