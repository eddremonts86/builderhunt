# Especificación — perfiles auto-gestionados (builders sin huella pública)

> **Status**: `pending`
> **Depends on**:
>   - [`02-segmentacion-usuarios`](../02-segmentacion-usuarios/spec.md) (typed user preference contract)
>   - [`03-onboarding-segmentado`](../03-onboarding-segmentado/spec.md) (segmento `building` ya definido)
>   - [`04-dashboard-personalizado`](../04-dashboard-personalizado/spec.md) (existing dashboard registry and preferences)
>   - [`06-landing-segmentada`](../06-landing-segmentada/spec.md) (typed building landing contract)
>   - [`../phase-1/36-claimable-profiles/spec.md`](../../implemented/phase-1/36-claimable-profiles/spec.md) (modelo de `builder_claims` y DTOs públicos)
>   - [`../phase-1/37-portfolio-builder/spec.md`](../../implemented/phase-1/37-portfolio-builder/spec.md) (superficie de portfolio público, esquema v1)
>   - [`../phase-1/38-work-sample/spec.md`](../../implemented/phase-1/38-work-sample/spec.md) (modelo de evidencias/adjuntos)
> **Blocks**: nothing
> **Reality check**: El segmento `building` se describe en
> `plans/phase-2/01-investigacion-icp/spec.md` y
> `plans/phase-2/03-onboarding-segmentado/spec.md`, pero ambos asumen que el builder tiene una
> huella pública que uno de los conectores activos indexó. `claimable-profiles` y
> `portfolio-builder` requieren ambos una tupla `(source, sourceId)` canónica. No existe
> ninguna ruta para una persona que no tiene perfil de GitHub, GitLab, Stack Overflow, ni
> ninguna de las fuentes activas. Esa persona queda excluida de BuilderHunt por construcción,
> aunque su trabajo (traducción, redacción, diseño, investigación, etc.) sea exactamente el
> tipo de evidencia que un reclutador o cliente busca.

## Problema

BuilderHunt indexa actividad pública de developer. Si una persona no ha publicado código,
preguntas, artículos, paquetes, modelos, ni nada en ninguna de las fuentes activas, el
sistema no tiene nada que mostrar. Esa persona queda invisible aunque sea exactamente el
perfil que un cliente busca: traductores es↔en↔fr con portfolio verificable, redactores
técnicos, ilustradores, investigadores, consultores, abogados tech, operadores de comunidad,
diseñadores sin Dribbble, fotógrafos con Behance pero sin actividad de "ship".

Los planes actuales cierran el caso de quien ya tiene huella (claim + portfolio), pero no
abren el caso de quien no la tiene y aun así quiere ser descubrible, demostrar trabajo y
recibir oportunidades.

## Objetivo

Permitir que un builder sin huella pública cree y mantenga un perfil propio en BuilderHunt
con la misma dignidad, descubribilidad y capacidad de curación que un builder con
`builder_claims` verificada. El perfil debe:

- poder crearse desde cero, sin tupla `(source, sourceId)`;
- permitir CV / bio / portfolio narrativo editable por su dueño;
- aceptar adjuntos verificables (PDF, imágenes, muestras de trabajo, certificados, etc.);
- ser descubrible por búsqueda, igual que cualquier otro builder;
- ser distinguible en lectura pública: un perfil auto-gestionado no es un perfil con
  `builder_claims` verificada, y la UI debe hacerlo explícito;
- ser migrable a perfil con claim más adelante, sin perder el trabajo ya hecho;
- respetar la misma capa de seguridad (carga de adjuntos, almacenamiento, consent, GDPR)
  que el resto de BuilderHunt.

## No-objetivos

- Sustituir `builder_claims` ni debilitar el "verified" badge de los perfiles reclamados.
  Un perfil auto-gestionado se presenta siempre como tal, nunca como verificado.
- Inventar señales de actividad pública. Si no hay huella, no la inventamos. La
  descubribilidad del perfil viene del contenido que el dueño sube y declara, y de la
  búsqueda por texto completo sobre ese contenido.
- Edición de campos que provengan de scraping (bio, avatar, location) para perfiles con
  fuente. Eso sigue siendo territorio de `claimable-profiles` y `enrichment`.
- Marketplace, mensajería, contratación, pagos. La transacción no entra en este plan.
- Portfolios multi-idioma. i18n del propio BuilderHunt se mantiene fuera.
- Self-rating o autoevaluaciones ("5 estrellas en español nativo"). El dueño declara
  habilidades, el sistema no las puntúa.

## Historias de usuario

1. Como persona sin huella pública indexable, puedo registrarme, declarar mi nombre y
   mi actividad profesional, y obtener un perfil público en `/u/$handle` (o equivalente).
2. Como dueño del perfil, puedo subir un CV en PDF y entre 1 y 12 muestras de trabajo
   (PDF, PNG, JPG, WEBP, MP3, MP4 con duración cap) con descripción y fecha por adjunto.
3. Como dueño, puedo escribir bio, headline, idiomas que manejo, servicios que ofrezco,
   y temas en los que me especializo, todo en formulario propio.
4. Como visitante, puedo buscar por idioma, habilidad o tema y encontrar perfiles
   auto-gestionados mezclados con perfiles reclamados, con una marca visual que los
   distingue.
5. Como dueño, puedo pedir más tarde la verificación de un perfil auto-gestionado si
   consigo una huella pública, sin perder los adjuntos ni el contenido narrativo.
6. Como visitante que ve un perfil auto-gestionado, entiendo en un golpe de vista que
   "este perfil no tiene claims verificadas; el contenido es declarado por su dueño",
   sin tener que leer una página de caveats.

## Modelo canónico de datos

`claimable-profiles` define `builder_claims` con `UNIQUE (source, sourceId)`. Un perfil
auto-gestionado no tiene `(source, sourceId)`: lo que tiene es un handle único y un
`ownerUserId`. La relación entre las dos vías debe ser clara, sin obligar a que un
perfil auto-gestionado sea un `builder_claim` mal formado.

```ts
// Tabla nueva. Vive en la misma migración de este plan.
selfManagedProfiles = {
  id: string,                          // ULID, primary key
  handle: string,                      // único, ^[a-z0-9-]{3,32}$, reservable
  ownerUserId: string,                 // FK -> users.id
  displayName: string,                 // 1..80 chars
  headline: string | null,             // hasta 120 chars
  bio: string | null,                  // hasta 1200 chars
  locationCity: string | null,
  locationCountryCode: string | null,  // ISO 3166-1 alpha-2
  languages: string[],                 // BCP-47, max 12
  services: string[],                  // taxonomía controlada, ver §"Taxonomía de servicios"
  topics: string[],                    // mismas reglas que builder_claims.topics
  declaredAt: Date,
  updatedAt: Date,
  // El dueño puede retirar el perfil de la búsqueda pública sin borrarlo.
  visibility: 'public' | 'unlisted' | 'draft',
  // Si en el futuro se le concede una claim verificada, este campo lo recuerda
  // para preservar la narrativa del dueño sin perder metadatos.
  promotedToBuilderClaimId: string | null,
};

// Adjuntos. Un perfil puede tener hasta 12 work-samples activos.
selfManagedAttachments = {
  id: string,                          // ULID
  profileId: string,                   // FK -> self_managed_profiles.id
  kind: 'cv' | 'work-sample' | 'certificate' | 'other',
  title: string,                       // 1..120 chars
  description: string | null,          // hasta 600 chars
  storageKey: string,                  // S3 / R2 / local
  mimeType: string,                    // allowlist estricta, ver §"Adjuntos"
  sizeBytes: number,                   // <= 25 MB
  durationSeconds: number | null,      // solo para audio/video
  checksumSha256: string,
  uploadedAt: Date,
  deletedAt: Date | null,
};

// Handle reservado, evita squatting de handles populares antes de que el dueño exista.
selfManagedHandleReservations = {
  handle: string,                      // PK
  reservedByUserId: string,
  reservedAt: Date,
  expiresAt: Date                      // 7 días desde la reserva
};
```

Reglas:

- UNIQUE en `selfManagedProfiles.handle`, `selfManagedProfiles.ownerUserId`, en cada
  `selfManagedAttachments.storageKey`.
- Un usuario puede tener **a lo sumo un** perfil auto-gestionado activo; borrarlo es
  soft-delete con `deletedAt` y libera el handle tras 30 días.
- Si `promotedToBuilderClaimId IS NOT NULL`, el perfil se sigue renderizando desde la fila
  de `selfManagedProfiles` para preservar adjuntos y narrativa, pero el bloque de "claim
  verificada" se hidrata desde `builder_claims` con badge verificado.
- `visibility = 'draft'` excluye de búsqueda y de lectura pública salvo para su dueño.
- `visibility = 'unlisted'` permite `/u/$handle` directo pero excluye de búsqueda.

## Taxonomía de servicios (controlada, versionada)

Los campos abiertos (idiomas, temas) son libres porque la realidad no se deja encerrar;
los servicios ofertados deben estar en un set cerrado para que la búsqueda pueda filtrar
por ellos sin que cada usuario invente su nomenclatura.

```ts
const SERVICE_TAXONOMY = [
  { id: 'translation', label: 'Traducción', allowedKinds: ['es-en', 'en-es', 'fr-en', 'en-fr', 'es-fr', 'fr-es', 'multilingual'] },
  { id: 'copywriting', label: 'Redacción y copy' },
  { id: 'technical-writing', label: 'Documentación técnica' },
  { id: 'editing-proofreading', label: 'Edición y corrección' },
  { id: 'localization', label: 'Localización' },
  { id: 'transcription', label: 'Transcripción' },
  { id: 'interpretation', label: 'Interpretación' },
  { id: 'illustration', label: 'Ilustración' },
  { id: 'photography', label: 'Fotografía' },
  { id: 'video-editing', label: 'Edición de vídeo' },
  { id: 'design-product', label: 'Diseño de producto' },
  { id: 'design-graphic', label: 'Diseño gráfico' },
  { id: 'ux-research', label: 'Investigación UX' },
  { id: 'data-analysis', label: 'Análisis de datos' },
  { id: 'consulting', label: 'Consultoría' },
  { id: 'community-management', label: 'Gestión de comunidad' },
  { id: 'legal-tech', label: 'Asesoría legal tech' },
  { id: 'tax-finance', label: 'Asesoría fiscal y financiera' },
  { id: 'coaching-mentoring', label: 'Mentoría y coaching' },
  { id: 'other', label: 'Otro (describir en bio)' }
] as const;
```

La taxonomía se almacena en código con `schemaVersion: 1`. Cualquier adición requiere
migración. Se persiste junto al perfil solo el `id`; el `label` se resuelve en render.

## Adjuntos — capa de seguridad

Los adjuntos son el riesgo principal: uploads maliciosos son vectores clásicos. La capa
debe ser consistente con la de enrichment, no improvisada.

**Contrato actualizado contra HEAD (2026-08-07):** BuilderHunt ya tiene la implementación
completa en `src/lib/storage/`, `src/lib/scheduling/document-worker.ts` y las rutas de documentos
de scheduling. Este plan añade una política/tipo de propietario sobre esas primitivas. No crea
`safeDeliverBlob`, `upload-validator`, `av-scan` ni un segundo árbol de storage.

- Subida vía endpoint autenticado `POST /api/self-managed/attachments` con multipart,
  validado por Zod y por magic bytes (no solo por la extensión declarada).
- Allowlist MIME estricta:
  `application/pdf`, `image/png`, `image/jpeg`, `image/webp`,
  `audio/mpeg`, `audio/wav`, `video/mp4`.
- Tamaño máximo 25 MB por adjunto, 12 adjuntos por perfil.
- Almacenamiento mediante `src/lib/storage/object-keys.ts`: primero bajo `quarantine/`, después
  bajo `clean/`; la key usa IDs opacos y nunca el filename ni otro PII.
- Descarga mediante el provider existente: URL firmada de cinco minutos solo para una fila `clean`
  cuya object key también está bajo `clean/`; nunca se lista el bucket.
- Antivirus / scan de malware: integra con el servicio ya presente en BuilderHunt (ver
  `docker/clamav/`) en cola asíncrona; adjuntos recién subidos quedan en estado
  `pending` y no se sirven hasta que el scan devuelva `clean`.
- Hash SHA-256 obligatorio; al subir el mismo checksum dos veces, el segundo intento
  apunta al storageKey existente (deduplicación).
- Soft delete con `deletedAt`; el archivo físico se purga tras 30 días por una
  retention pass consistente con la de `enrichment`.
- `kind = 'cv'` permite exactamente un adjunto activo; los CVs anteriores quedan
  históricos.

## Rutas y superficies

- `GET /u/$handle` — perfil público, sin auth. Renderiza desde `selfManagedProfiles`.
  Si `promotedToBuilderClaimId` está set, incluye además el bloque de claim verificada.
- `GET /me/profile` — editor autenticado. Misma UI base que el editor de builder
  existente en `src/routes/_dashboard/me/index.tsx` cuando aplique; añade campos
  propios.
- `POST /api/self-managed/profile` — crear; valida handle, reserva si hace falta.
- `PATCH /api/self-managed/profile/$profileId` — editar; valida ownership.
- `DELETE /api/self-managed/profile/$profileId` — soft-delete; libera handle a los 30
  días, conserva adjuntos hasta entonces con `deletedAt`.
- `POST /api/self-managed/attachments` — subir adjunto.
- `DELETE /api/self-managed/attachments/$id` — soft-delete.
- `POST /api/self-managed/handle/$handle/reserve` — reservar handle (TTL 7 días,
  rate-limited a 5 por día por usuario).
- `PATCH /api/self-managed/visibility` — cambiar `public` / `unlisted` / `draft`.

## Superficies de búsqueda y descubrimiento — cobertura integral

La regla es: cualquier superficie de la app que hoy devuelve un builder con
`builder_claims` debe poder devolver también un perfil auto-gestionado, identificado
con el chip "Self-managed". La integración no es opcional en ninguna de las rutas
existentes. Esta sección enumera cada superficie, su contrato de integración y los
riesgos específicos.

### 1. Búsqueda federada en vivo

- **Ruta**: `POST /api/search/builders` → `searchBuilders()` en `src/lib/search.ts`.
- **Integración**: añadir `'self-managed'` al enum `SOURCE_NAMES` en
  `src/lib/sources/types.ts`. Crear `src/lib/sources/self-managed.ts` con un connector
  que **no hace red** — lee directamente de `selfManagedProfiles` con
  `visibility = 'public'` y `scanStatus = 'clean'` (o `null` para perfiles sin
  adjuntos). Cada perfil emitido es un `RawBuilder` con `kind: 'person'`,
  `source: 'self-managed'`, `sourceId: profile.id`, `username: profile.handle`,
  `displayName`, `bio`, `topics`. El `metadata` incluye el handle, el conteo de
  adjuntos, los `services` resueltos y el flag `isSelfManaged: true`.
- **Ranking**: el score del connector usa `relevanceScore` ya calculado en
  `relevance_search_index` o, si no existe, un score base 0.5 con boost por
  match en `services` (×1.4) y `topics` (×1.2). Sin boost por recency de actividad
  pública (no aplica); se usa la fecha `updatedAt` del perfil como fallback.
- **Rate limit**: el connector es local pero debe respetar el
  `CONNECTOR_TIMEOUT_MS` (8 s, ver `src/lib/search.ts`) y devolver
  `{ health: 'failed', detail: 'self-managed query timeout' }` si excede.
- **Dedup**: extender `deduplicateBuilders()` en `src/lib/dedup.ts` para que
  los perfiles auto-gestionados no se fusionen con builders con claim por
  coincidencia de username. La clave de dedup es
  `(source, sourceId)` para auto-gestionados, no `(displayName, source)`.
- **Filtro de suppressed**: `filterSuppressed()` en
  `src/shared/lib/profile-suppression.ts` debe cubrir también
  `selfManagedProfiles.deletedAt IS NOT NULL`.

### 2. Búsqueda semántica

- **Ruta**: `POST /api/search/semantic` (ver `src/routes/api/search/semantic.ts` y
  `src/lib/semantic/`).
- **Integración**: el connector `self-managed` llama a
  `upsertEmbeddingStubs()` en `src/lib/semantic/index-writer.ts` con los mismos
  campos que un builder con claim (`id`, `displayName`, `topics`, `services`,
  texto del bio). El `kind` se setea a `self-managed-person` para que el
  `semantic-search.ts` lo pueda etiquetar en los resultados.
- **Re-indexación**: trigger por evento (insert/update de perfil o adjunto con
  `scanStatus = 'clean'`). El `discovery worker` nocturno corrige los
  `pending_scan` que pasen a `clean`.

### 3. Recomendaciones "For you"

- **Ruta**: `GET /api/recommendations/` (ver `src/routes/api/recommendations/index.ts`).
- **Integración**: tras re-ejecutar las saved queries via `searchBuilders()`, el
  filtrado por `trackedBuilderIds` debe excluir solo builders ya seguidos, no
  perfiles auto-gestionados. La capa de dedup post-query los acepta sin cambios.
- **Toggle**: añadir query param `includeSelfManaged: boolean` (default `true`).
  Si el usuario lo desactiva, el filtrado aplica
  `result.kind !== 'self-managed-person'` antes del ranking. El toggle se persiste
  en `user_preferences` (existente) bajo la key
  `recommendations.includeSelfManaged`.

### 4. Sourcing sprints — generación de shortlist

- **Ruta**: `src/lib/sprints/results.ts` y `src/routes/api/sprints/`.
- **Integración**: el `sprint.queries[]` re-ejecuta `searchBuilders()` por query, y
  el shortlist se construye por intersección + scoring. Los perfiles
  auto-gestionados entran al mismo pool y compiten por slots.
- **Configuración por sprint**: añadir `sprintConfig.includeSelfManaged: boolean`
  (default `true`). Si `false`, el shortlist se filtra por
  `result.metadata?.isSelfManaged !== true`.
- **UI**: el sprint summary muestra cuántos slots vienen de builders con claim
  verificada y cuántos de auto-gestionados. Métrica para que el recruiter entienda
  la composición de su shortlist.

### 5. Alert matching — saved search alerts

- **Ruta**: `src/lib/alerts/worker.ts`.
- **Integración**: cuando un perfil auto-gestionado se crea o actualiza con
  `visibility = 'public'`, el worker de alerts evalúa todas las saved searches
  y dispara alertas según las mismas reglas que para builders con claim.
- **Trigger de "novedad"**: para builders con claim, el alert se basa en
  "este builder no estaba en el shortlist la última vez que se ejecutó la query".
  Para auto-gestionados, el evento relevante es `insert/update` con
  `visibility` que pasa a `public` o un cambio material (nuevo adjunto `clean`,
  cambio en `services` o `topics`). El worker de alerts escucha los triggers de
  DB o el outbox de eventos de self-managed.
- **Suppression**: aplicar la misma ventana de supresión (default 7 días) para
  evitar alert-spam cuando un usuario edita su propio perfil.

### 6. Discovery worker — indexación proactiva

- **Ruta**: `src/lib/discovery/worker.ts` + `src/lib/discovery/matrix.ts`.
- **Integración**: ya cubierta en spec §"Indexación y búsqueda". El `SOURCE_NAMES`
  recibe `'self-managed'` y el `DISCOVERY_MATRIX` añade una entrada para
  `topics = ['translation', 'design', 'writing', 'consulting', ...]` con
  `sources: ['self-managed']`. La celda se ejecuta como las demás y respeta el
  `DISCOVERY_DAILY_STUB_CAP`.

### 7. Solutions — inteligencia de soluciones

- **Ruta**: `/api/solutions/briefs`, `/api/solutions/generate`,
  `src/lib/solutions/sources/*` (jobindex, npm, huggingface, etc.).
- **Integración conceptual**: Solutions es la superficie de la app donde un usuario
  describe un problema o necesidad y recibe un paquete que combina AI tools,
  documentación, feeds de empleo y **personas que pueden ejecutar el trabajo**.
  Los perfiles auto-gestionados son la pieza de "personas que pueden ejecutar
  el trabajo" para briefs que mencionan habilidades no técnicas (traducción,
  redacción, diseño, mentoring, etc.).
- **Cómo se añade**: el composer de solutions
  (`src/lib/solutions/composer/`) recibe una nueva fuente `self-managed` con
  `kind: 'people'`. Cuando un brief se genera, el composer incluye personas
  auto-gestionadas cuyo `services` intersecta con los `brief.requirements[]`.
- **Visibilidad en el brief output**: las personas auto-gestionadas se renderizan
  en una sección "People who can do this" con su chip "Self-managed" y un
  disclaimer "These profiles are not source-verified; review attached work
  samples before engaging". El cliente del brief puede hacer click en cada
  perfil para ir a `/u/$handle`.
- **Regla de oro**: las personas auto-gestionadas **nunca** aparecen como
  reemplazo de AI tools o de documentación en un brief; son una categoría
  adicional, no una sustitución.

### 8. Sourcing workspace y talent market intelligence

- **Ruta**: `plans/phase-4/sourcing-*` y
  `plans/phase-4/talent-market-intelligence`. Pendientes de implementación
  a la fecha de este plan.
- **Integración esperada**: ambos agregan builders en series temporales y
  distribuciones. Los perfiles auto-gestionados deben contar en los totales
  con un breakdown separado. La métrica "active builders in X" debe tener
  siempre un componente "with verified claim" y otro "self-managed", nunca
  fusionarlos.
- **Acción contractual para planes futuros**: cuando estos planes se
  redacten, deben referenciar este spec y consumir el
  `kind: 'self-managed-person'` sin asumir que todo builder tiene
  `builder_claims`.

### 9. Look-alike sourcing

- **Ruta**: `plans/phase-4/look-alike-sourcing`. Pendiente.
- **Integración esperada**: cuando un usuario marca "encuéntrame gente
  parecida a este builder", el algoritmo debe considerar perfiles
  auto-gestionados cuyo vector (bio + services + topics) sea similar. La
  confianza del match se etiqueta explícitamente como "Self-managed
  similarity" vs "Claimed similarity".

### 10. Builder profile pages y cross-links

- **Ruta actual**: `src/routes/builders/$builderId.tsx` (perfiles con claim).
- **Ruta nueva**: `src/routes/u/$handle.tsx` (perfiles auto-gestionados).
- **Cross-linking**: una página de perfil con claim puede tener una sección
  "People like this (self-managed)" que muestra hasta 3 perfiles
  auto-gestionados cuyo `services` o `topics` solape. Un perfil
  auto-gestionado puede tener una sección "Also active on" que apunta a su
  `builder_claims` cuando exista.
- **SEO**: el sitemap incluye ambos tipos. Las URLs canónicas son
  `/builders/$builderId` (claim) y `/u/$handle` (auto-gestionado), nunca
  se mezclan.

### Garantía común a todas las superficies

- Cualquier resultado `kind: 'self-managed-person'` se renderiza con el
  chip "Self-managed" sin excepción. El chip nunca se omite por error
  visual.
- Los resultados auto-gestionados se pueden filtrar pero **nunca se
  ocultan por defecto** en una superficie donde antes aparecía el
  universo completo de builders. Para excluir, el usuario debe hacerlo
  explícitamente (toggle o query param).
- Las métricas D7/D30 de cada superficie deben segmentar
  auto-gestionados vs claimed desde el día uno, para que el equipo
  pueda detectar si la introducción diluye engagement o lo amplía.

## Principio de cobertura universal en matching

> Esta sección codifica una regla de arquitectura. Aplica a este plan y a
> cualquier plan futuro de BuilderHunt que introduzca una nueva superficie
> de matching. No es una lista cerrada: es un principio que obliga a
> responder una pregunta antes de cerrar cualquier feature de
> descubrimiento.

**Regla**: cualquier código, ruta, worker, brief, agente o job que
produzca una lista de "candidatos", "matches", "personas relevantes" o
cualquier conjunto ordenado de builders, **debe considerar perfiles
auto-gestionados** (`selfManagedProfiles` con `visibility = 'public'`)
como fuente de datos válida, con las mismas reglas de inclusión,
exclusión, dedup, ranking, y marca visual que los builders con
`builder_claims` verificada.

La regla aplica tanto a un usuario humano buscando en la UI como a
un agente o worker ejecutando un job en background. No hay diferencia
de trato por quién inicia el matching.

### Por qué es un principio, no una lista

Las superficies de matching no se descubren de antemano. Un plan
nuevo en phase-3 o phase-4 puede introducir un "JD-to-candidates
matcher" o un "collaboration graph" sin que este plan pueda
anticiparlo. Documentar 10 superficies es un snapshot; un principio
es una invariante que sobrevive a la introducción de futuras
superficies. Sin el principio, cada plan futuro puede olvidar
silenciosamente la cobertura de auto-gestionados.

### Cómo se aplica en código

- **Helper único**: cualquier nueva superficie consume
  `includeSelfManagedInResults(results, options)` definido en
  `src/lib/search/self-managed-coverage.ts`. El helper inyecta los
  perfiles auto-gestionados relevantes en la posición correcta del
  ranking, aplica el toggle si está desactivado, y garantiza que cada
  resultado `kind: 'self-managed-person'` lleva el campo
  `metadata.isSelfManaged = true` y los flags que la UI necesita.
- **Test de invariante**: la suite
  `tests/unit/search/self-managed-coverage.test.ts` verifica que
  `includeSelfManagedInResults` cumple el contrato para al menos los
  siguientes escenarios: dedup contra builders con claim, toggle
  `includeSelfManaged = false`, ranking preservado, exclusion por
  `visibility != 'public'`, exclusion por `scanStatus = 'infected'`.
- **Checklist de review**: cualquier PR que añada un nuevo endpoint
  o worker de matching debe incluir un test que verifica la cobertura
  de self-managed. El checklist se aplica en `CODEOWNERS` y en el
  review template de GitHub.

### Cómo se aplica en planes futuros

Todo plan de phase-3 o phase-4 que introduzca una superficie de
matching debe responder estas cinco preguntas en su `spec.md`. Si
alguna respuesta es "no aplica", debe justificarse explícitamente.

1. ¿La nueva superficie incluye `selfManagedProfiles` con
   `visibility = 'public'` en su pool de candidatos?
2. ¿El output renderiza cada resultado `kind: 'self-managed-person'`
   con el chip "Self-managed"?
3. ¿Existe un toggle (`includeSelfManaged: boolean`, o equivalente)
   para que el usuario pueda excluirlos, y el default es `true`?
4. ¿La telemetría de la superficie emite el evento
   `surface_result_rendered` con `kind` segmentado?
5. ¿Existe al menos un test E2E o de integración que verifica la
   cobertura?

El conjunto de cinco preguntas se referencia desde este spec como
**"checklist de cobertura universal en matching"**. Sucesión de
planes que la adopten: cualquier plan que cierre una nueva superficie
de matching con respuestas afirmativas a las cinco preguntas hereda
automáticamente la compatibilidad con perfiles auto-gestionados.

### Reglas derivadas explícitas

- **No hay "auto-gestionado vs AI tools"** en un brief. En la
  superficie de `solutions`, las personas auto-gestionadas conviven
  con AI tools y documentación, pero como **categoría disjunta** (ver
  Fase 4b.6). El principio de cobertura universal no rompe la
  separación de categorías: una persona no es una AI tool, ni
  viceversa.
- **Las constraints de privacidad se respetan siempre**. Un usuario
  con `visibility = 'draft'` o con su `delete-account` en proceso
  nunca aparece en ninguna superficie, aunque el principio
  obligue a considerarlos. La cobertura se aplica sobre el conjunto
  de filas elegibles, no sobre todas las filas.
- **El toggle global de cobertura existe en `user_preferences`**
  bajo `search.includeSelfManaged` (default `true`). Si el usuario
  lo desactiva, todas las superficies lo respetan. La métrica
  segmentada sigue emitiendo, pero los valores para
  `self-managed-person` se reportan como 0 para ese usuario.
- **El toggle por superficie sigue funcionando**. Una superficie
  concreta puede tener su propio toggle más granular (por ejemplo
  `recommendations.includeSelfManaged`). El toggle global solo se
  aplica si el toggle por superficie no está definido.

### Anti-patterns explícitos (no hacer)

- **No** iterar el pool de builders y aplicar `WHERE
  builder_claims.verified_at IS NOT NULL` para "asegurar" la
  calidad. Eso excluye a los auto-gestionados.
- **No** cachear un snapshot del pool que no incluye
  `selfManagedProfiles`. La caché invalida por evento o tiene TTL
  documentado y se invalida en cada insert/update de
  `selfManagedProfiles`.
- **No** asumir `kind: 'person'` para builders; verificar también
  `kind: 'self-managed-person'`. Las dos ramas deben estar cubiertas.
- **No** usar la palabra "verified" o el badge verde para
  auto-gestionados en ningún contexto (UI, copy, telemetría,
  exports). La marca "Self-managed" es exclusiva.
- **No** devolver auto-gestionados en una superficie sin un toggle
  para excluirlos. La regla opuesta también es un anti-pattern: no
  excluir por defecto.

### Cómo este principio se conecta con planes existentes

- `phase-1/36-claimable-profiles/spec.md`: añade al final una nota
  referenciando este principio. La nota dice: "cualquier ruta que
  liste builders con claim debe, por el principio de cobertura
  universal, considerar también perfiles auto-gestionados. Ver
  phase-2/07-perfiles-autogestionados/spec.md §Principio de
  cobertura universal en matching."
- `phase-1/37-portfolio-builder/spec.md`: añade nota análoga
  referenciando el principio.
- `phase-1/38-work-sample/spec.md`: añade nota análoga.
- `phase-2/02-segmentacion-usuarios/spec.md`: el segmento `building`
  cubre las dos sub-modalidades (con y sin huella). La cobertura
  universal es un corolario.
- `phase-2/03-onboarding-segmentado/spec.md`: el flujo bifurcado
  garantiza que el usuario sin huella llega a la nueva ruta sin
  quedar excluido.
- `phase-2/04-dashboard-personalizado/spec.md`: el segmento
  `building` debe tener widgets que muestren también perfiles
  auto-gestionados propios del usuario y ajenos relevantes.
- `phase-2/06-landing-segmentada/spec.md`: la página `/for/builders`
  menciona la cobertura universal como promesa de producto.

### Cómo este principio se conecta con planes futuros

- `phase-4/jd-to-candidates-matching`: el matching debe incluir
  perfiles auto-gestionados cuyo `services` y `topics` matcheen
  con el JD. La confianza del match se etiqueta explícitamente
  como "self-managed" vs "claimed".
- `phase-4/look-alike-sourcing`: ver Fase 4b.8. Vector de similitud
  distinto por tipo, etiqueta de output distinta, pero ambos en
  la misma lista de resultados.
- `phase-4/collaboration-graph`: el grafo de colaboración incluye
  aristas a perfiles auto-gestionados cuando hay match en
  `services` o `topics` comunes. Las aristas llevan la marca
  "self-managed" en su tooltip.
- `phase-4/match-evidence-panel`: cuando un match incluye un
  perfil auto-gestionado, el panel muestra los adjuntos limpios
  como evidencia, con la marca "declarado por el dueño".
- `phase-4/talent-market-intelligence`: ver Fase 4b.7. Métricas
  segmentadas por `kind`.
- Cualquier plan nuevo que introduzca matching: el `spec.md` debe
  responder las cinco preguntas de la checklist.

### Una nota sobre el nombre

Este plan usa el término **"perfiles auto-gestionados"** para
referirse a `selfManagedProfiles`. En el copy de producto y en
conversaciones informales, también aparece como **"self-hosted
profiles"** (aclaración del propietario del producto). Ambos
términos designan la misma entidad. En el código, en los
identificadores, en la taxonomía de `kind` y en la documentación
técnica se usa **"self-managed"** por consistencia con la
nomenclatura inglesa del codebase. En el copy de UI se puede
usar "Self-managed" como chip visible para el usuario.

## Indexación y búsqueda

El perfil auto-gestionado se inyecta en el mismo índice de búsqueda que los builders
con claim, con un campo `kind: 'self-managed'` para que la UI pueda etiquetarlo. La
búsqueda full-text sobre bio, headline, descripción de adjuntos, topics y services
debe ser parangonable a la búsqueda sobre builders reclamados; ningún favoritismo ni
penalización silenciosa.

El `discovery worker` debe conocer el nuevo origen: se añade un pseudo-source
`self-managed` al `SOURCE_NAMES` enum, con `acquisitionMode: 'user_submitted'` en el
registro de políticas. La frecuencia de re-indexación es por evento (insert/update de
perfil o adjunto) más una pasada nocturna por adjuntos `pending_scan` que hayan
pasado el scan.

## Marca visual y honestidad epistémica

El distintivo "verified" pertenece a `builder_claims` con `verifiedAt IS NOT NULL`.
Un perfil auto-gestionado no tiene claims y, por tanto, no debe poder ganarse ese badge.
Se introduce un chip "Self-managed" (color secundario, no verde) que aparece junto al
display name en:

- resultados de búsqueda;
- página `/u/$handle`;
- tarjetas en listas y sprints;
- agregados en dashboards.

El color del chip es deliberadamente distinto al verde de "verified" para no inducir a
error. La accesibilidad WCAG AA se mantiene: contraste mínimo 4.5:1.

Si en el futuro el dueño consigue una `builder_claims` y la verifica, el chip
"Self-managed" se sustituye por el badge "verified" sin perder los adjuntos. La página
puede llevar ambos bloques: "Self-managed profile" (sección editable por el dueño) y
"Verified claim" (sección derivada de `builder_claims`).

## Privacidad y GDPR

El perfil auto-gestionado contiene PII declarada por el dueño (nombre, ciudad, país,
foto si sube, email de contacto opcional). Las obligaciones son las mismas que para
cualquier builder de BuilderHunt:

- consent explícito en el alta: el usuario acepta que el contenido que suba será
  público según la `visibility` que elija;
- right to erasure: `DELETE` dispara borrado de perfil, adjuntos físicos a los 30 días
  y tombstone de búsqueda inmediata;
- data export: `GET /api/me/data-export` ya existe y debe incluir
  `selfManagedProfiles` y `selfManagedAttachments` del usuario sin cambios de
  contrato;
- lawful basis: legitimate interest (Art. 6.1.f GDPR) cuando el perfil es público;
  contract cuando es el campo de un workspace privado;
- retention: 30 días tras soft-delete para adjuntos; indefinido para el perfil si
  está activo, configurable por el usuario en un futuro plan de configuración de
  privacidad.

## Compatibilidad con planes existentes

- `36-claimable-profiles`: la fila de `builder_claims` no cambia. Si en el futuro el
  dueño quiere reclamar, se crea una fila adicional, no se reemplaza el perfil
  auto-gestionado.
- `37-portfolio-builder`: el esquema `portfolioSettings` se amplía con un nuevo
  discriminador: cuando la claim viene de un perfil auto-gestionado, el portfolio
  hereda los adjuntos del perfil además de los `featuredProjects` clásicos.
- `38-work-sample`: este plan es la fuente de verdad para adjuntos auto-gestionados;
  `38-work-sample` queda para evidencias scrapeadas/verificadas de builders con
  claim. No se duplica el storage ni el `safeFetch`-equivalente.
- `03-onboarding-segmentado`: el paso "localiza tu perfil" se bifurca. Si el usuario
  tiene actividad pública, ruta actual. Si no, ruta nueva a `/me/profile/new`.
- `04-dashboard-personalizado`: el segmento `building` gana widgets nuevos (resumen
  de perfil, adjuntos pendientes de scan, solicitudes de claim pendientes).
- `06-landing-segmentada`: la página `/for/builders` menciona explícitamente "no
  necesitas tener un perfil de GitHub" como mensaje de inclusión.

## Modelo de decisión — cuándo recomendar migrar a claim

El sistema sugiere al dueño solicitar una `builder_claims` cuando se cumple **una** de
las siguientes condiciones, sin ser invasivo (un solo banner en el dashboard):

- tiene ≥ 3 adjuntos de tipo `work-sample` con ≥ 90 días de antigüedad declarada;
- la búsqueda que recibe su perfil tiene ≥ 10 visitas por mes durante 2 meses
  consecutivos;
- el dueño actualiza `services` o `topics` con valores que también aparecen en
  al menos uno de los conectores activos.

La sugerencia se desactiva si el dueño la descarta. No se fuerza nunca.

## Riesgos y mitigaciones

- **Riesgo**: perfiles auto-gestionados terminan superando en número a los builders
  con claim y diluyen la propuesta de valor de "proof of work".
  **Mitigación**: la búsqueda muestra siempre el chip "Self-managed"; los
  resultados auto-gestionados nunca se intercalan en posiciones que
  los builders con claimVerifiedAt reciente merecerían por recency. Algoritmo
  específico en `04-dashboard-personalizado` y en el ranking del `discovery worker`.
- **Riesgo**: adjuntos con malware o material con copyright del que el dueño no es
  titular.
  **Mitigación**: antivirus obligatorio, escaneo async, y cláusula de
  responsabilidad en el alta + un botón "report" en la página pública.
- **Riesgo**: handles reservados para squatting.
  **Mitigación**: TTL 7 días + rate-limit 5 reservas/día por usuario. Si tras 30
  días no se ha creado el perfil, el handle vuelve al pool.
- **Riesgo**: perfiles auto-gestionados usados para fraude (falso diploma, falsas
  referencias).
  **Mitigación**: la marca "Self-managed" no admite ambigüedad; los adjuntos
  se etiquetan como "declarado por el dueño" en cualquier preview; y los admins
  pueden reportar y suspender (sigue el flujo ya previsto en
  `claimable-profiles/spec.md` para revocación).

## Criterios de éxito verificables

- Una persona sin huella pública puede completar el alta y tener perfil público
  visible en BuilderHunt en menos de 5 minutos.
- Un usuario con claim que entra a `/u/$handle` de un perfil auto-gestionado entiende
  en menos de 3 segundos que ese perfil no está verificado.
- Un perfil auto-gestionado con adjuntos y bio aparece en búsqueda full-text cuando
  el query matchea cualquiera de los campos declarados.
- Un perfil auto-gestionado puede migrar a `builder_claims` verificada sin perder
  adjuntos, bio, ni handle.
- Ningún perfil auto-gestionado se renderiza con el badge verde de "verified" en
  ninguna parte de la UI.
- Todos los adjuntos pasan el scan antivirus antes de ser servidos; cualquier scan
  que devuelva `infected` o `suspicious` deja el adjunto en `quarantined` y fuera
  de la página pública.
- `data-export` y `delete-account` incluyen los datos auto-gestionados sin
  necesidad de cambios adicionales al contrato existente.

## Out of scope explícito

- Perfiles auto-gestionados para empresas (no personas físicas). Eso entra en
  `phase-4/job-opportunities-workspace` u otro plan futuro, con KYC.
- Mensajería entre reclutador y perfil auto-gestionado. El `Contact` del perfil es
  email declarado o link externo, sin chat in-app.
- Pago o escrow entre cliente y perfil auto-gestionado. Ni在本 plan ni en
  planes adyacentes de phase-2.
- Reputación derivada de proyectos cerrados. Eso pertenece a planes de marketplace
  o de feedback post-contratación, que no entran en phase-2.
