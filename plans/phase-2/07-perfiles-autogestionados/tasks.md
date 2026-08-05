# Tareas — perfiles auto-gestionados

> Las tareas siguen el orden de implementación. Cada tarea referencia los archivos a
> tocar cuando aplica; las tareas sin ruta se centran en modelo, contrato o QA.
> `spec.md` §"Modelo canónico de datos", §"Adjuntos — capa de seguridad" y
> §"Criterios de éxito verificables" son la fuente de verdad para el "hecho".

## Fase 0 — modelo y migraciones

- [ ] **0.1** — Crear migración Drizzle `0042_self_managed_profiles.ts` con las tres
  tablas (`selfManagedProfiles`, `selfManagedAttachments`,
  `selfManagedHandleReservations`) según `spec.md` §"Modelo canónico de datos".
  Constraints: `UNIQUE` en `handle` y `ownerUserId`; índice sobre
  `(visibility, updatedAt)` para el barrido del discovery worker.
- [ ] **0.2** — Definir `selfManagedProfileSchema`, `selfManagedAttachmentSchema` y
  `handleReservationSchema` con Zod en
  `src/shared/lib/db/schema/self-managed.ts`. Incluir `schemaVersion: 1` en payload
  cuando aplique.
- [ ] **0.3** — Generar tipos Drizzle y añadirlos al barrel de
  `src/shared/lib/db/schema.ts` y al barrel público de
  `src/shared/lib/repositories/`.
- [ ] **0.4** — Crear `src/shared/lib/repositories/self-managed-profiles.ts` con
  `createProfile`, `getProfileByHandle`, `getProfileByOwner`, `updateProfile`,
  `softDeleteProfile`, `listProfilesByVisibility`. Las funciones reciben `tx` para
  integrarse con `withWorkerOrganization` y `withTenantContext`.
- [ ] **0.5** — Crear `src/shared/lib/repositories/self-managed-attachments.ts` con
  `insertAttachment`, `softDeleteAttachment`, `getAttachmentById`,
  `listAttachmentsByProfile`, `markScanResult`, `purgeDeletedOlderThan(days)`.
- [ ] **0.6** — Añadir la taxonomía de servicios en
  `src/shared/lib/self-managed/service-taxonomy.ts` con `schemaVersion: 1` y
  función `resolveServiceLabel(id)`.

## Fase 1 — capa de seguridad para adjuntos

- [ ] **1.1** — Crear `src/shared/lib/storage/safe-deliver.ts` con
  `safeDeliverBlob({ storageKey, expiresIn })`: genera URL firmada de 15 min,
  sin listar el bucket, sin redirects, host allowlist contra el dominio público
  de BuilderHunt. Inspirado en la estructura de
  `src/lib/enrichment/network.ts` (ver `spec.md` §"Adjuntos — capa de seguridad").
- [ ] **1.2** — Crear `src/shared/lib/storage/upload-validator.ts` con validación por
  magic bytes (no solo por MIME declarado), enforcing la allowlist
  `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `audio/mpeg`,
  `audio/wav`, `video/mp4`. Tests unitarios con fixtures por cada tipo y con
  casos negativos.
- [ ] **1.3** — Conectar con el servicio de antivirus ya desplegado
  (`docker/clamav/`); crear `src/shared/lib/storage/av-scan.ts` que enqueue
  adjuntos subidos y actualice `selfManagedAttachments.scanStatus` cuando el scan
  devuelva `clean` / `infected` / `suspicious` / `error`.
- [ ] **1.4** — Añadir retention pass en
  `src/shared/lib/repositories/self-managed-attachments.ts` que purgue blobs
  físicos con `deletedAt < now() - 30 days`. La función debe ser idempotente y
  procesar en lotes de 500, consistente con la retention pass de
  `enrichment_evidence`.
- [ ] **1.5** — Cobertura de tests: security test que verifique que un payload con
  MIME `image/png` pero magic bytes `MZ` (PE executable) es rechazado; que una
  URL firmada caducada devuelve 410 Gone; que un blob en `quarantined` nunca se
  expone a través de `/api/self-managed/attachments/$id/file`.

## Fase 2 — endpoints públicos y autenticados

- [ ] **2.1** — `src/routes/api/self-managed/profile/index.ts`: `POST` crea
  perfil, valida handle, activa la reserva pendiente si existe. `GET` (sin auth)
  por `handle` devuelve el DTO público. Rate limit por IP en `GET`.
- [ ] **2.2** — `src/routes/api/self-managed/profile/$profileId/index.ts`:
  `PATCH` (auth) edita campos propios; `DELETE` (auth) hace soft-delete. Sólo el
  dueño puede escribir; RLS en `selfManagedProfiles` reforzado a nivel de fila
  con `ownerUserId`.
- [ ] **2.3** — `src/routes/api/self-managed/handle/$handle/reserve.ts`:
  rate-limited (5/día por usuario), TTL 7 días, libera handles que vencieron.
- [ ] **2.4** — `src/routes/api/self-managed/visibility.ts`: `PATCH` cambia entre
  `public` / `unlisted` / `draft`. Audita el cambio.
- [ ] **2.5** — `src/routes/api/self-managed/attachments/index.ts`: `POST`
  multipart con validación, devuelve `attachmentId` y `scanStatus = pending_scan`.
- [ ] **2.6** — `src/routes/api/self-managed/attachments/$id/index.ts`: `DELETE`
  soft-delete; `GET /file` (auth dueño) sirve el blob vía `safeDeliverBlob`.
  Nadie más puede servir el blob.
- [ ] **2.7** — Tests: auth y ownership en cada endpoint; rate limit verificado
  con test de integración; intento de edición cross-tenant debe ser 404 (no 403,
  para no filtrar existencia).

## Fase 3 — UI del perfil público y del editor

- [ ] **3.1** — Componente `SelfManagedProfile` en
  `src/modules/builder-profile/components/SelfManagedProfile.tsx`: renderiza
  `displayName`, `headline`, `bio`, `services` (resueltos por
  `resolveServiceLabel`), `topics`, `languages`, adjuntos, location, y el chip
  "Self-managed" según `spec.md` §"Marca visual y honestidad epistémica".
- [ ] **3.2** — Ruta `src/routes/u/$handle.tsx` con SSR, SEO metadata, OG image
  dinámica con iniciales del display name. Si el perfil tiene
  `promotedToBuilderClaimId`, incluye el bloque "Verified claim" extraído de
  `builder_claims`.
- [ ] **3.3** — Editor en `src/routes/_dashboard/me/profile/index.tsx` con
  formulario por secciones (Identity, Story, Services, Languages, Visibility) y
  autosave con debounce. Validación inline de handle y bio con contadores de
  caracteres.
- [ ] **3.4** — Componente `AttachmentUploader` con drag-and-drop, preview por
  tipo MIME, lista de adjuntos con `scanStatus` y estado de deduplicación.
  Estados: `uploading`, `pending_scan`, `clean`, `infected`, `quarantined`,
  `error`. Solo `clean` aparece en la página pública.
- [ ] **3.5** — Bloque de accesibilidad: contraste WCAG AA del chip
  "Self-managed" verificado con axe-core; el chip nunca se renderiza con el
  mismo verde del badge "verified".
- [ ] **3.6** — Página de error `/u/$handle` con 404 si no existe o está en
  `draft` (los `unlisted` siguen resolviendo).

## Fase 4 — indexación y búsqueda

- [ ] **4.1** — Añadir `'self-managed'` a `SOURCE_NAMES` en
  `src/lib/sources/types.ts` con `acquisitionMode: 'user_submitted'` en
  `src/lib/enrichment/policies.ts` y un connector vacío que devuelve los
  perfiles desde la DB local (no es red, es user-submitted; ver analogía con
  `user-submitted` connector existente en
  `src/lib/enrichment/connectors/user-submitted.ts`).
- [ ] **4.2** — Modificar el `discovery worker` para que, en su pasada, incluya
  perfiles auto-gestionados con `visibility = 'public'` y adjuntos en
  `scanStatus = 'clean'`. El campo `kind` se mapea a `self-managed-person`.
- [ ] **4.3** — Ajustar el ranking de búsqueda en `src/lib/search` para que
  perfiles auto-gestionados y builders con claim convivan en la misma SERP sin
  penalización silenciosa. La marca visual se renderiza en cada card; el
  ranking en sí mismo no conoce el tipo.
- [ ] **4.4** — Re-indexación por evento: trigger de `insert/update` en
  `selfManagedProfiles` y `selfManagedAttachments` actualiza
  `builder_embeddings`; el barrido nocturno del `discovery worker` corrige
  adjuntos recién escaneados que pasen a `clean`.

## Fase 4b — superficies de búsqueda (cobertura integral)

Las tareas de esta fase son obligatorias antes de Fase 5. Cada superficie de
búsqueda que la app expone hoy debe ser capaz de devolver perfiles
auto-gestionados, con el chip "Self-managed" siempre visible.

### 4b.1 — Búsqueda federada en vivo

- [ ] **4b.1.1** — Crear `src/lib/sources/self-managed.ts` con `searchSelfManaged`
  que lee directamente de `selfManagedProfiles` (no red), respeta
  `CONNECTOR_TIMEOUT_MS` (8 s, ver `src/lib/search.ts`), filtra por
  `visibility = 'public'`, devuelve `RawBuilder[]` con `kind: 'person'`,
  `source: 'self-managed'`, `sourceId: profile.id`, `username: profile.handle`,
  `displayName`, `bio`, `topics` y `metadata.isSelfManaged = true`,
  `metadata.services = profile.services`,
  `metadata.attachmentCount`.
- [ ] **4b.1.2** — Registrar el connector en `search.ts` (paralelo a los otros
  15). El score base es 0.5 con boost ×1.4 si `services` matchea keywords y
  ×1.2 si `topics` matchea.
- [ ] **4b.1.3** — Extender `deduplicateBuilders()` en `src/lib/dedup.ts` para
  que la clave de dedup de auto-gestionados sea `(source, sourceId)` (no
  username/displayName), evitando fusión con builders con claim.
- [ ] **4b.1.4** — Cubrir `selfManagedProfiles.deletedAt IS NOT NULL` en
  `filterSuppressed()`.
- [ ] **4b.1.5** — Test E2E: una búsqueda por "traducción español inglés"
  devuelve al menos un perfil auto-gestionado cuando existe en la DB de
  fixtures; el resultado lleva el chip "Self-managed".

### 4b.2 — Búsqueda semántica

- [ ] **4b.2.1** — En el connector `self-managed`, llamar a
  `upsertEmbeddingStubs()` con `kind: 'self-managed-person'` y los campos
  necesarios para que `src/lib/semantic/semantic-search.ts` los incluya en
  los resultados.
- [ ] **4b.2.2** — Test E2E: una query semántica devuelve resultados
  auto-gestionados mezclados con builders con claim, con el chip visible.

### 4b.3 — Recomendaciones "For you"

- [ ] **4b.3.1** — En `src/routes/api/recommendations/index.ts`, no filtrar
  perfiles auto-gestionados por `getTrackedBuilderIds()`.
- [ ] **4b.3.2** — Añadir query param `includeSelfManaged: boolean` (default
  `true`) y persistirlo en `user_preferences` bajo
  `recommendations.includeSelfManaged`. Si `false`, filtrar
  `result.metadata?.isSelfManaged !== true` antes del ranking.
- [ ] **4b.3.3** — Test: un usuario sin `includeSelfManaged = false` recibe
  perfiles auto-gestionados en su "For you" cuando matchean saved queries.

### 4b.4 — Sourcing sprints

- [ ] **4b.4.1** — En `src/lib/sprints/results.ts`, los `result.metadata?.isSelfManaged`
  entran al pool de shortlist sin cambios. La composición del shortlist
  mantiene el orden de score.
- [ ] **4b.4.2** — Añadir `sprintConfig.includeSelfManaged: boolean` (default
  `true`). Si `false`, filtrar antes del shortlist. Persistir en la tabla
  `sprints` (existente) o en una nueva columna nullable.
- [ ] **4b.4.3** — Sprint summary muestra un breakdown
  `claimed: N · self-managed: M` para que el recruiter entienda la
  composición.

### 4b.5 — Alert matching

- [ ] **4b.5.1** — Añadir `src/lib/alerts/worker-self-managed-trigger.ts` o
  equivalente que escuche los eventos de `selfManagedProfiles` (insert,
  update, `visibility` flip, nuevo adjunto `clean`, cambio en `services` o
  `topics`) y los enqueue al mismo pipeline de alerts que ya existe para
  builders con claim.
- [ ] **4b.5.2** — Aplicar la misma ventana de supresión (default 7 días) por
  perfil auto-gestionado para evitar alert-spam por ediciones del dueño.
- [ ] **4b.5.3** — Test: cuando un nuevo perfil auto-gestionado matchea una
  saved search existente, el alert se dispara con el mismo formato que para
  builders con claim, pero con el chip "Self-managed" en el cuerpo del alert.

### 4b.6 — Solutions — intelligence de soluciones

- [ ] **4b.6.1** — Añadir `'self-managed'` como una nueva `kind: 'people'`
  fuente en `src/lib/solutions/composer/`. El composer ya tiene
  `src/lib/solutions/sources/` para fuentes de job feeds, documentación y
  AI tools; la nueva fuente es la única que devuelve personas, no contenido.
- [ ] **4b.6.2** — Cuando un brief se genera, el composer filtra perfiles
  auto-gestionados cuyo `services` intersecta con `brief.requirements[]`
  (overlap ≥ 1 elemento) y los incluye en una sección
  "People who can do this" del output.
- [ ] **4b.6.3** — La sección incluye el chip "Self-managed" y un disclaimer
  fijo: "These profiles are not source-verified. Review attached work
  samples before engaging." (texto revisable, fijado en el composer).
- [ ] **4b.6.4** — Las personas auto-gestionadas **nunca** sustituyen a AI
  tools o documentación en el brief; el composer trata los dos grupos
  como categorías disjuntas. Test que verifica que el output incluye
  siempre las dos secciones cuando hay match en ambas.
- [ ] **4b.6.5** — Métrica: para cada brief generado, contar cuántos perfiles
  auto-gestionados se incluyeron y cuántos se ignoraron por filtro de
  `services`. Telemetría en `src/shared/lib/metrics/`.

### 4b.7 — Sourcing workspace y talent market intelligence

- [ ] **4b.7.1** — Aplazar a planes futuros. **Acción contractual**: dejar
  un comentario en
  `plans/phase-4/sourcing-workspace/spec.md` (cuando se redacte) y en
  `plans/phase-4/talent-market-intelligence/spec.md` (cuando se redacte)
  referenciando este spec y prohibiendo asumir
  `builders_with_claim = all_builders`. La cláusula estándar será:
  "toda agregación debe segmentar `kind: 'self-managed-person'`
  separado de builders con `builder_claims`".

### 4b.8 — Look-alike sourcing

- [ ] **4b.8.1** — Aplazar a planes futuros. **Acción contractual**: añadir
  nota en `plans/phase-4/look-alike-sourcing/spec.md` (cuando se redacte)
  indicando que el vector de similitud debe construirse desde
  `(bio + services + topics)` para perfiles auto-gestionados y desde
  `(bio + topics + recentActivity)` para builders con claim. La etiqueta de
  output es distinta: "Self-managed similarity" vs "Claimed similarity".

### 4b.9 — Cross-linking entre `/builders/$builderId` y `/u/$handle`

- [ ] **4b.9.1** — En `src/routes/builders/$builderId.tsx`, añadir una sección
  "People like this (self-managed)" que muestra hasta 3 perfiles
  auto-gestionados cuyo `services` o `topics` solape con el builder
  reclamado. Cada card lleva el chip "Self-managed".
- [ ] **4b.9.2** — En `src/routes/u/$handle.tsx`, si el perfil tiene
  `promotedToBuilderClaimId`, añadir una sección "Also active on" que
  renderiza el bloque de la claim correspondiente (ver Fase 5).
- [ ] **4b.9.3** — Sitemap (`src/shared/lib/sitemap.ts` o equivalente)
  incluye ambos tipos de URL, con su `changefreq` y `priority`
  correspondientes. Las URLs son disjuntas:
  `/builders/$builderId` (claim) y `/u/$handle` (auto-gestionado), nunca
  una misma URL apuntando a dos rutas.

### 4b.10 — Garantía común a todas las superficies

- [ ] **4b.10.1** — Componente único `<BuilderCard variant="self-managed">` en
  `src/modules/search/components/` que garantiza que el chip "Self-managed"
  aparece en cualquier superficie. Las 10 superficies anteriores consumen
  este componente; ninguna renderiza un resultado auto-gestionado con un
  componente ad-hoc.
- [ ] **4b.10.2** — Test de invariante: snapshot test por superficie que
  verifica que todo resultado con `metadata.isSelfManaged = true` renderiza
  el chip. Si se rompe, el test indica la superficie exacta.
- [ ] **4b.10.3** — Métricas segmentadas: para cada superficie, evento
  `surface_result_rendered` con `surface: <nombre>` y
  `kind: 'self-managed-person' | 'claimed-person'`. Permite medir
  engagement segmentado por superficie desde el día uno.

## Fase 4c — principio de cobertura universal

Esta fase codifica el principio "siempre que alguien o algo busque
coincidencias, los perfiles auto-gestionados deben estar en el pool".
No enumera superficies (eso ya está hecho en 4b); codifica la regla
para que sobreviva a futuras superficies no anticipadas.

- [ ] **4c.1** — Crear `src/lib/search/self-managed-coverage.ts` con la
  función `includeSelfManagedInResults(results, options)`:
  - firma `(results: FusedBuilder[], options: { query, perSurfaceToggle?,
    globalToggle?, userId? }): FusedBuilder[]`;
  - lee el toggle global `user_preferences.search.includeSelfManaged` y
    el toggle por superficie si existe;
  - consulta `selfManagedProfiles` con la query, respetando el toggle
    y la `visibility`;
  - deduplica contra los resultados existentes por `(source, sourceId)`;
  - inyecta en la posición correcta del ranking según `score + boosts`;
  - marca cada resultado con `metadata.isSelfManaged = true` y los
    campos que la UI necesita (`chip: 'Self-managed'`, `attachmentCount`,
    `services` resueltos).
- [ ] **4c.2** — Suite `tests/unit/search/self-managed-coverage.test.ts`
  con casos: dedup contra claim, toggle global off, toggle por
  superficie off, ranking preservado, `visibility != 'public'` excluido,
  `scanStatus = 'infected'` excluido, `scanStatus = 'pending_scan'`
  excluido, sync de bulk, concurrencia. Cobertura ≥ 90% del módulo.
- [ ] **4c.3** — Refactor de las 10 superficies de la Fase 4b para que
  consuman `includeSelfManagedInResults` en lugar de la lógica
  inline. La función se vuelve el único punto de inyección. Si una
  superficie ya tiene su propia lógica, se reemplaza por una llamada
  al helper. La reducción de código es un KPI de la fase (mide si
  realmente estamos consolidando).
- [ ] **4c.4** — Añadir checklist de 5 preguntas al
  `CODEOWNERS` (o `docs/operations/code-review-checklist.md` si existe
  un equivalente) para que cualquier PR que introduzca una nueva
  superficie de matching tenga que responder afirmativamente. La
  checklist referencia
  `spec.md` §"Principio de cobertura universal en matching".
- [ ] **4c.5** — Documentar en
  `docs/architecture/extensibility.md` (o archivo equivalente si
  existe) el principio de cobertura universal. La sección incluye
  las 5 preguntas y un índice de las superficies actuales. Cualquier
  plan futuro que introduzca matching referencia este archivo en
  su `spec.md`.
- [ ] **4c.6** — Añadir una nota en el `README.md` de cada plan de
  `phase-1` y `phase-2` que toque builders (`36-claimable-profiles`,
  `37-portfolio-builder`, `38-work-sample`, `02-segmentacion-usuarios`,
  `03-onboarding-segmentado`, `04-dashboard-personalizado`,
  `06-landing-segmentada`) referenciando este principio. El
  contenido de la nota es estándar: "Este plan hereda el principio
  de cobertura universal en matching definido en
  `phase-2/07-perfiles-autogestionados/spec.md`. Cualquier ruta o
  worker que liste builders debe considerar perfiles
  auto-gestionados."
- [ ] **4c.7** — Telemetría: el evento
  `self_managed_coverage_invoked` se emite cada vez que se llama a
  `includeSelfManagedInResults`, con `surface: <nombre>` y
  `resultCountAdded: number`. Permite auditar la cobertura real a
  lo largo del tiempo.

## Fase 5 — promoción a `builder_claims` verificada

- [ ] **5.1** — Endpoint `POST /api/self-managed/profile/$profileId/promote` que
  inicia el flujo de claim si el conector detecta que el dueño ya tiene
  actividad en una fuente indexable. No fuerza: sólo se ofrece si la
  `builder_claims` está verificada.
- [ ] **5.2** — En la página `/u/$handle`, si el dueño ya tiene una
  `builder_claims` verificada en cualquier fuente, mostrar el bloque "Verified
  claim" junto al bloque "Self-managed" con sus adjuntos.
- [ ] **5.3** — Asegurar que el upgrade a claim no duplica adjuntos: el
  portfolio (`37-portfolio-builder`) sigue renderizando desde
  `selfManagedAttachments` cuando la claim tiene `metadata.portfolio` y la
  fuente es auto-gestionada.
- [ ] **5.4** — Banner de sugerencia en el dashboard del segmento `building` si
  se cumple cualquiera de las condiciones de `spec.md` §"Modelo de decisión".

## Fase 6 — privacidad, GDPR y exports

- [ ] **6.1** — Ampliar `src/shared/lib/data-export/profile-export.ts` para que
  incluya `selfManagedProfiles` y `selfManagedAttachments` del usuario en el
  payload de export. Sin cambios de contrato.
- [ ] **6.2** — Ampliar `src/shared/lib/account/deletion.ts` para que un
  `delete-account` cascade el soft-delete a `selfManagedProfiles` y
  `selfManagedAttachments` del usuario, con la retention pass de 30 días
  existente.
- [ ] **6.3** — Consent explícito en el alta con checkbox doble
  ("visibility public" y "entiendo que mi contenido será público"). El
  consent se persiste en `user_consents` con `policyVersion` bumped.
- [ ] **6.4** — Reporte y suspensión: añadir acción admin para suspender un
  perfil auto-gestionado por violación de ToS. La suspensión pone
  `visibility = 'draft'` y registra motivo en `audit_log`.

## Fase 7 — onboarding segmentado y landing

- [ ] **7.1** — Bifurcar el paso "localiza tu perfil" en
  `03-onboarding-segmentado` para que detecte si el usuario ya tiene actividad
  pública indexable. Si no, ofrece la ruta `/me/profile/new`.
- [ ] **7.2** — Landing `/for/builders` menciona explícitamente "no necesitas
  tener un perfil de GitHub" en el hero, con CTA a `/me/profile/new`.
- [ ] **7.3** — Sección en `/for/builders` con ejemplo real de un perfil
  auto-gestionado (consentimiento de la persona incluida). Sin datos
  sintéticos: si no hay caso real, dejar la sección como coming-soon.
- [ ] **7.4** — Email post-onboarding a usuarios del segmento `building` que
  aún no han subido un adjunto: "tu perfil gana 3x más interacciones con al
  menos un work-sample" (verificable vía analytics).

## Fase 8 — calidad y rollout

- [ ] **8.1** — Tests unitarios de cada repository y endpoint; cobertura
  mínima 85% en `src/shared/lib/repositories/self-managed-*` y
  `src/shared/lib/storage/*`.
- [ ] **8.2** — Tests E2E con Playwright: alta → completar perfil → subir 3
  adjuntos → activar visibilidad pública → buscar y encontrar el propio
  perfil. La suite añade un nuevo archivo
  `tests/e2e/self-managed-profile.spec.ts`.
- [ ] **8.3** — Security test que verifique: (a) un usuario no puede listar
  adjuntos de otro usuario; (b) una URL firmada caducada no sirve contenido;
  (c) el endpoint `POST /api/self-managed/attachments` rechaza tipos fuera de
  la allowlist; (d) un blob `quarantined` se excluye del DTO público.
- [ ] **8.4** — Performance: el endpoint público `/u/$handle` debe responder
  en < 200 ms p95 con caché de 60 s. Medir antes y después con
  `bench/calendar-feed.mjs`-style script.
- [ ] **8.5** — Construir la bandera `self_managed_profiles_enabled` y su kill switch documentado en
  `docs/operations/` es trabajo de esta fase y sigue aquí. **El rollout gradual (5% → 25% → 100% en
  cohorts de 7 días) se movió a
  [`plans/phase-5/01-production-readiness-audit`](../../phase-5/01-production-readiness-audit/tasks.md)
  el 2026-08-05**: son 21 días de reloj en producción, y ninguna cantidad de ingeniería los acorta. La
  bandera se implementa y se despliega apagada, que es exactamente el principio — tener el feature y
  desactivarlo, no dejar de tenerlo.
- [ ] **8.6** — Actualizar `docs/operations/public-enrichment-source-register.md`
  con la nueva entrada `self-managed` y su lawful basis
  (legitimate interest cuando `visibility = 'public'`).
- [ ] **8.7** — Anuncio en `/changelog` con nota para builders actuales
  explicando que los perfiles auto-gestionados son una categoría nueva y
  separada, y que no cambian su propio claim.

## Dependencias cruzadas con planes adyacentes

- Antes de empezar la fase 4, [`02-segmentacion-usuarios`](../02-segmentacion-usuarios/spec.md)
  debe estar implementado: el campo `user_segment` y la taxonomía
  `hiring | investing | building | other` ya deben existir.
- Antes de empezar la fase 3,
  [`../phase-1/36-claimable-profiles/spec.md`](../../phase-1/36-claimable-profiles/spec.md)
  debe tener el DTO público de `builder_claims` finalizado, para que el chip
  "Self-managed" se renderice con paridad visual.
- Antes de empezar la fase 5,
  [`../phase-1/37-portfolio-builder/spec.md`](../../phase-1/37-portfolio-builder/spec.md)
  debe haber ampliado `portfolioSettings` para aceptar adjuntos de
  `selfManagedAttachments`.
- Antes de empezar la fase 7,
  [`../phase-1/38-work-sample/spec.md`](../../phase-1/38-work-sample/spec.md)
  debe haber separado "evidencias scrapeadas" de "adjuntos del dueño", para
  que la búsqueda no mezcle los dos sin etiqueta.
