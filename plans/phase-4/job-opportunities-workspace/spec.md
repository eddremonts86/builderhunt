# Especificación — workspace interno de ofertas de trabajo

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../implemented/phase-1/01-security-and-multitenancy/spec.md) (tenant principal, `withTenantContext`, RLS forzado, `organization_id NOT NULL` — CERRADO 2026-07-27), [`ai-expansion`](../../implemented/phase-1/21-ai-expansion/spec.md) (registro `AI_TASKS`, `wrapUntrusted`, cache, budget), [`stealth-scraping`](../../implemented/phase-1/42-stealth-scraping/spec.md) (`safeFetch`, robots, registro de políticas de fuente), [`stripe-billing-platform`](../../implemented/phase-1/30-stripe-billing-platform/spec.md) (`rate-cards.ts` + `feature-authorization.ts`: reserva/settle/release)
> **Blocks**: [`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md) (duro — consume `job_opportunity_versions` pinneadas), [`delegated-job-applications`](../delegated-job-applications/spec.md) (duro — misma dependencia, más el dedupe por owner)
> **Reality check**: No existe ninguna tabla, repositorio, ruta ni pantalla de ofertas de trabajo. Lo que SÍ existe y este plan reutiliza sin reinventar: `safeFetch`/`SafeFetchError` (`src/lib/enrichment/network.ts`), `validateExternalHttpUrl` (`src/shared/lib/security/url-policy.ts`), `isPathAllowedByRobots` con tri-estado (`src/lib/enrichment/robots.ts`), el registro `SOURCE_POLICIES` + `HARD_BLOCKED_CONNECTOR_IDS` (`src/lib/enrichment/policies.ts`), el patrón de lease de `enrichment_jobs` (`src/shared/lib/db/schema.ts:970`, `src/shared/lib/repositories/enrichment-worker.ts`), el worker HTTP idempotente (`src/routes/api/admin/alerts/run-worker.ts`), el registro de tareas IA (`src/shared/lib/ai/tasks.ts`, ya contiene `jd-parse`, que es OTRA cosa) y la reserva/settlement de créditos (`src/shared/lib/billing/feature-authorization.ts` + `src/shared/lib/billing/rate-cards.ts`). `candidate_submissions`, `candidate_documents` y `job_runs` pertenecen a entrevistas/operación: distinto sujeto, distinto consentimiento, no se tocan.

## Problema

Los flujos de CV adaptado y de candidatura delegada necesitan una fuente de verdad para las ofertas:
qué empresa publica, qué pide, cuándo se capturó, si cambió, si sigue abierta y de dónde procede.
Aceptar solo texto suelto o URLs dentro de cada generación produce duplicados, resultados no
reproducibles y candidaturas contra ofertas caducadas. Peor: un CV generado hoy contra una oferta
que mañana cambia deja de ser auditable, y el usuario no puede explicar por qué dijo lo que dijo.

`jd-parse` (`src/shared/lib/ai/tasks.ts:320`) ya extrae criterios de sourcing de una JD pegada, pero
es `local-first`, efímero, orientado a BUSCAR CANDIDATOS y su salida es `ExtractedCriteria`
(skills/roles/seniority). No crea catálogo, no persiste, no versiona y no sirve como contrato
downstream. Este plan no lo modifica ni lo sustituye.

## Objetivo

Un workspace privado donde una persona pueda registrar una oferta manualmente, pegar una
descripción, importar una URL, importar un lote de hasta 50 URLs o un CSV, revisar y corregir la
extracción, detectar duplicados y cambios, clasificar/archivar/eliminar, y ofrecer una **API estable
y versionada** a matching, CV tailoring y candidaturas.

## No objetivos

- **Crawler general de bolsas de trabajo.** El importador es deny-by-default sobre un registro de
  fuentes revisado a mano. Un host sin entrada no se descarga: falla con `source_not_allowed` antes
  de resolver DNS.
- **Republicar ofertas** en ninguna superficie pública, ni alimentar embeddings globales con ellas.
- **Entrenar modelos** con ofertas de un usuario.
- **Inferir salario, sponsorship o estado de apertura sin evidencia.** Un campo sin evidencia queda
  `null`; nunca se rellena con la media del mercado.
- **Aplicar a trabajos.** Eso es `delegated-job-applications`.
- **Compartir el workspace** con la organización de empresa, con empleadores o con otro usuario.
  Compartir requiere otro diseño y consentimiento explícito; no hay `visibility` en estas tablas.
- **Saltarse login, CAPTCHA, paywall, rate limits ni controles anti-bot.** Ninguno de estos se
  intenta ni se documenta como posible.
- **Soft delete / papelera.** `DELETE` es destructivo y en cascada; la alternativa no destructiva es
  `status = 'archived'`. Añadir una papelera es un plan posterior, no un detalle de este.
- **Cola de trabajos nueva.** El lote usa el patrón HTTP-cron existente (`app-reality.md`
  constraint 3), no BullMQ ni nada equivalente.

## Historias de usuario

1. Como **persona buscando trabajo**, pego el texto de una oferta y obtengo campos estructurados que
   puedo corregir antes de guardar; los campos que la IA no pudo justificar quedan vacíos, no
   inventados.
2. Como **la misma persona**, pego una URL de una fuente permitida y obtengo lo mismo, más la
   procedencia (URL final, fecha de captura, versión de la política aplicada).
3. Como **la misma persona**, pego 15 URLs, veo el coste máximo antes de empezar, y al terminar
   tengo 11 ofertas, 2 duplicados detectados y 2 errores exportables — y ninguno de los 11 éxitos se
   perdió por los 2 fallos.
4. Como **la misma persona**, cancelo un lote a mitad y los créditos de los items no procesados no
   se cobran.
5. Como **la misma persona**, refresco una oferta un mes después y veo el diff; el snapshot que usó
   mi CV de la semana pasada sigue existiendo, intacto.
6. Como **admin de la organización de empresa donde trabajo**, no veo absolutamente nada de esto:
   ni la lista, ni un 403 que confirme que existe. Recibo 404 / colección vacía.
7. Como **la misma persona**, cambio la organización activa de mi sesión a la de mi empresa y mi
   workspace de carrera sigue exactamente igual: no se duplica, no se mueve, no desaparece.

## Decisión de privacidad — tenant-private CON propietario individual

Cada fila lleva `organization_id` **y** `owner_user_id`, ambos `NOT NULL`. El predicado RLS es
`tenant AND owner`. El predicado de tenant por sí solo filtraría entre miembros de la misma
organización, que es exactamente el fallo que este dominio no puede permitirse.

- `organization_id` **siempre** es la organización personal del sujeto, resuelta en servidor por
  `personalOrganizationId(userId)` (`src/shared/lib/migration/backfill.ts`, ya usado por
  `ensurePersonalOrganization` en `src/shared/lib/auth/personal-organization.ts`).
- La organización activa de la sesión **no** se usa como selector, autoridad ni pagador.
- Un `organizationId` suministrado por el cliente se rechaza con `400 invalid_request`, aunque
  corresponda a una membresía válida.
- `owner`/`admin`/`member` de cualquier organización no obtienen acceso implícito.
- Si el usuario no tiene organización personal válida, el servidor la crea/repara con
  `ensurePersonalOrganization(userId)` antes de aceptar datos.

La forma a imitar es `drizzle/0085_candidate_documents_rls_grants.sql`, que camina hasta un
`owner_user_id` por esta misma razón. Aquí es más simple porque `owner_user_id` vive en la tabla
raíz; las hijas lo prueban con un `EXISTS` de un salto.

## Arquitectura

```
POST /api/jobs/import  ──┐
                         ├─► resolveJobSource (source-policies.ts, deny-by-default)
                         ├─► safeFetch (network.ts)  ──► robots (robots.ts, tri-estado)
                         ├─► extractReadableText (sin HTML activo)
                         ├─► reserveCredits('job_description_extract')
                         ├─► ai job-description-extract (server-only, untrusted-wrapped)
                         ├─► settleReservation(actual) | releaseReservation
                         └─► preview (NO persiste)  ──► POST /api/jobs (confirma)

POST /api/jobs/import/batch ──► job_import_batches + job_import_items (queued)
POST /api/admin/jobs/run-import-worker (cron)
       └─► claimJobImportItems (lease, per-host concurrency)
             └─► por item: el MISMO pipeline de arriba, en su propia transacción
```

Módulos nuevos:

- `src/shared/lib/jobs/contracts.ts` (new) — puro: enums, zod, state machines, límites.
- `src/shared/lib/jobs/normalize.ts` (new) — puro: canonicalización de URL, fingerprint, normalización de
  empresa/cargo.
- `src/shared/lib/jobs/dedupe.ts` (new) — puro: orden de señales y clasificación exact/probable.
- `src/shared/lib/jobs/extraction.ts` (new) — servidor: la tarea IA + cache + budget + fallback.
- `src/shared/lib/jobs/billing.ts` (new) — servidor: envoltorio delgado sobre `feature-authorization.ts`.
- `src/shared/lib/auth/career-principal.ts` (new) — `requireCareerPrincipal(request)`.
- `src/lib/jobs/source-policies.ts` (new) — registro de fuentes de oferta, deny-by-default.
- `src/lib/jobs/import-url.ts` (new) — un hop de importación (política → fetch → texto).
- `src/lib/jobs/import-worker.ts` (new) — el worker de lotes.
- `src/shared/lib/repositories/job-opportunities.ts` (new),
  `src/shared/lib/repositories/job-import.ts` (new),
  `src/shared/lib/repositories/job-import-worker.ts` (new).

## Modelo de datos

Cuatro tablas nuevas, todas **tenant-private con propietario individual**. Todas usan el convenio
del repo: `uniqueIndex('<tabla>_organization_id_id_unique')` para poder ser destino de FK compuesta,
FKs compuestas que arrastran `organization_id`, y `check(...)` en vez de enums de PG.

### `job_opportunities`

| Columna | Tipo | Nulabilidad | Nota |
| --- | --- | --- | --- |
| `id` | `uuid` | PK, `defaultRandom()` | |
| `organization_id` | `text` | NOT NULL | FK → `organizations.id` `ON DELETE CASCADE` |
| `owner_user_id` | `text` | NOT NULL | FK → `auth_users.id` `ON DELETE CASCADE`. Cascade y no `restrict`: la oferta es dato del sujeto, no recurso de la organización — al borrar la cuenta desaparece, no se reasigna a un centinela (contraste deliberado con `organization_builders.creator_user_id`, `app-reality.md` constraint 6) |
| `title` | `text` | NOT NULL | texto mostrado, sin normalizar |
| `company_name` | `text` | NOT NULL | texto mostrado, sin normalizar |
| `title_normalized` | `text` | NOT NULL | solo para búsqueda y fingerprint |
| `company_normalized` | `text` | NOT NULL | idem |
| `location_text` | `text` | NULL | |
| `country_code` | `text` | NULL | ISO-3166-1 alpha-2 mayúsculas |
| `remote_policy` | `text` | NULL | `onsite \| hybrid \| remote` |
| `employment_type` | `text` | NULL | `full_time \| part_time \| contract \| internship \| temporary` |
| `seniority` | `text` | NULL | `junior \| mid \| senior \| lead \| unknown` |
| `salary_min` | `integer` | NULL | unidades enteras de la moneda |
| `salary_max` | `integer` | NULL | |
| `salary_currency` | `text` | NULL | ISO-4217 mayúsculas |
| `salary_period` | `text` | NULL | `hour \| day \| month \| year` |
| `status` | `text` | NOT NULL `'draft'` | `draft \| active \| paused \| expired \| archived` |
| `source_type` | `text` | NOT NULL | `manual \| pasted_text \| url \| csv \| official_api` |
| `source_id` | `text` | NULL | id del registro de fuentes (`greenhouse`, `lever`, …) |
| `source_url` | `text` | NULL | tal como la escribió el usuario |
| `normalized_url` | `text` | NULL | canonicalizada, es la clave de dedupe |
| `source_external_id` | `text` | NULL | id de la oferta en la fuente, si la fuente lo publica |
| `content_fingerprint` | `text` | NOT NULL | `sha256` de `company_normalized \| title_normalized \| normalizedBodyDigest` |
| `current_version_id` | `uuid` | NULL | FK compuesta diferible → `job_opportunity_versions` |
| `language` | `text` | NULL | BCP-47 detectado, editable |
| `first_seen_at` | `timestamptz` | NOT NULL `now()` | |
| `last_verified_at` | `timestamptz` | NULL | último fetch que confirmó la oferta |
| `expires_at` | `timestamptz` | NULL | solo si la fuente lo publica |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL `now()` | |
| `version` | `integer` | NOT NULL `1` | contador de concurrencia optimista para PATCH |

Índices y restricciones:

```ts
uniqueIndex('job_opportunities_organization_id_id_unique').on(t.organizationId, t.id),
// Dedupe duro por propietario, no por organización: dos personas distintas guardando la misma
// oferta son dos filas legítimas. `where` parcial porque `normalized_url` es opcional.
uniqueIndex('job_opportunities_owner_normalized_url_unique')
  .on(t.organizationId, t.ownerUserId, t.normalizedUrl)
  .where(sql`${t.normalizedUrl} is not null`),
uniqueIndex('job_opportunities_owner_source_external_unique')
  .on(t.organizationId, t.ownerUserId, t.sourceId, t.sourceExternalId)
  .where(sql`${t.sourceExternalId} is not null`),
// El listado por defecto: mis ofertas, filtradas por estado, más recientes primero.
index('job_opportunities_owner_status_idx').on(t.organizationId, t.ownerUserId, t.status, t.updatedAt),
// Dedupe blando (candidato probable) y detección de cambio.
index('job_opportunities_owner_fingerprint_idx').on(t.organizationId, t.ownerUserId, t.contentFingerprint),
// Barrido de frescura del worker de retención/expiración: cruza organizaciones a propósito.
index('job_opportunities_expiry_idx').on(t.status, t.expiresAt),

check('job_opportunities_status_check',
  sql`${t.status} in ('draft','active','paused','expired','archived')`),
check('job_opportunities_source_type_check',
  sql`${t.sourceType} in ('manual','pasted_text','url','csv','official_api')`),
check('job_opportunities_remote_policy_check',
  sql`${t.remotePolicy} is null or ${t.remotePolicy} in ('onsite','hybrid','remote')`),
check('job_opportunities_employment_type_check',
  sql`${t.employmentType} is null or ${t.employmentType} in ('full_time','part_time','contract','internship','temporary')`),
check('job_opportunities_seniority_check',
  sql`${t.seniority} is null or ${t.seniority} in ('junior','mid','senior','lead','unknown')`),
check('job_opportunities_country_check',
  sql`${t.countryCode} is null or ${t.countryCode} ~ '^[A-Z]{2}$'`),
check('job_opportunities_currency_check',
  sql`${t.salaryCurrency} is null or ${t.salaryCurrency} ~ '^[A-Z]{3}$'`),
check('job_opportunities_salary_period_check',
  sql`${t.salaryPeriod} is null or ${t.salaryPeriod} in ('hour','day','month','year')`),
// Un rango de salario es coherente o no existe. Y un número sin moneda no es un salario.
check('job_opportunities_salary_range_check',
  sql`(${t.salaryMin} is null or ${t.salaryMin} >= 0)
      and (${t.salaryMax} is null or ${t.salaryMax} >= 0)
      and (${t.salaryMin} is null or ${t.salaryMax} is null or ${t.salaryMin} <= ${t.salaryMax})`),
check('job_opportunities_salary_currency_presence_check',
  sql`(${t.salaryMin} is null and ${t.salaryMax} is null) or ${t.salaryCurrency} is not null`),
// Una oferta que dice venir de una URL tiene URL. Una manual no la exige.
check('job_opportunities_url_presence_check',
  sql`${t.sourceType} not in ('url','csv','official_api') or ${t.normalizedUrl} is not null`),
check('job_opportunities_fingerprint_check', sql`${t.contentFingerprint} ~ '^[a-f0-9]{64}$'`),
check('job_opportunities_version_check', sql`${t.version} >= 1`),
```

`current_version_id` es una FK compuesta `(organization_id, current_version_id)` →
`job_opportunity_versions(organization_id, id)` con `ON DELETE SET NULL`. Es circular con la FK de
la hija, así que **se crea `DEFERRABLE INITIALLY DEFERRED`** para que insertar oferta+versión en una
sola transacción no falle. Esto se escribe a mano en la migración; drizzle-kit no lo emite.

### `job_opportunity_versions`

Snapshot **inmutable**. Es el contrato que los planes downstream pinnean.

| Columna | Tipo | Nulabilidad | Nota |
| --- | --- | --- | --- |
| `id` | `uuid` | PK `defaultRandom()` | |
| `organization_id` | `text` | NOT NULL | FK → `organizations.id` `ON DELETE CASCADE` |
| `opportunity_id` | `uuid` | NOT NULL | FK compuesta → `job_opportunities` `ON DELETE CASCADE` |
| `version_number` | `integer` | NOT NULL | 1, 2, 3… por oferta |
| `source_text` | `text` | NOT NULL | texto plano capturado; **nunca HTML** |
| `source_text_sha256` | `text` | NOT NULL | clave de cache y de detección de cambio |
| `extracted_fields` | `jsonb` | NOT NULL `'{}'` | snapshot validado por `jobExtractionSchema` |
| `evidence_spans` | `jsonb` | NOT NULL `'[]'` | `[{field, start, end}]` sobre `source_text` |
| `extractor` | `text` | NOT NULL | `manual \| ai \| ai_repaired \| fallback` |
| `extractor_version` | `text` | NOT NULL | `job-description-extract@1` o `manual@1` |
| `source_policy_version` | `text` | NOT NULL | versión del registro de fuentes aplicada |
| `fetched_url` | `text` | NULL | URL **final** tras redirecciones |
| `http_etag` | `text` | NULL | validador para el refresh condicional |
| `http_last_modified` | `text` | NULL | idem |
| `fetched_at` | `timestamptz` | NULL | |
| `review_status` | `text` | NOT NULL `'unreviewed'` | `unreviewed \| reviewed \| manual_required` |
| `reviewed_at` | `timestamptz` | NULL | |
| `changed_fields` | `jsonb` | NOT NULL `'[]'` | nombres de campo que difieren de la versión anterior |
| `created_at` | `timestamptz` | NOT NULL `now()` | |

```ts
uniqueIndex('job_opportunity_versions_organization_id_id_unique').on(t.organizationId, t.id),
uniqueIndex('job_opportunity_versions_opportunity_number_unique')
  .on(t.organizationId, t.opportunityId, t.versionNumber),
index('job_opportunity_versions_opportunity_idx')
  .on(t.organizationId, t.opportunityId, t.createdAt),
// El refresh pregunta "¿este contenido ya lo tengo?" antes de gastar IA.
index('job_opportunity_versions_content_idx')
  .on(t.organizationId, t.opportunityId, t.sourceTextSha256),
foreignKey({
  columns: [t.organizationId, t.opportunityId],
  foreignColumns: [jobOpportunities.organizationId, jobOpportunities.id],
  name: 'job_opportunity_versions_organization_opportunity_fk',
}).onDelete('cascade'),
check('job_opportunity_versions_number_check', sql`${t.versionNumber} >= 1`),
check('job_opportunity_versions_extractor_check',
  sql`${t.extractor} in ('manual','ai','ai_repaired','fallback')`),
check('job_opportunity_versions_review_status_check',
  sql`${t.reviewStatus} in ('unreviewed','reviewed','manual_required')`),
check('job_opportunity_versions_sha_check', sql`${t.sourceTextSha256} ~ '^[a-f0-9]{64}$'`),
check('job_opportunity_versions_reviewed_check',
  sql`(${t.reviewStatus} = 'reviewed') = (${t.reviewedAt} is not null)`),
// `source_text` acotado en base de datos, no solo en zod: es el input que paga la IA.
check('job_opportunity_versions_text_length_check',
  sql`length(${t.sourceText}) between 1 and 60000`),
```

**Inmutabilidad**: no hay `GRANT UPDATE` para ningún rol de runtime y no existe política `FOR
UPDATE`. Un intento de `UPDATE` desde `builderhunt_app` devuelve `42501`, no un no-op silencioso.
`review_status`/`reviewed_at` se fijan en el `INSERT` de la versión que el usuario confirma; marcar
como revisada una versión ya escrita crea una versión nueva con `extractor = 'manual'`.

### `job_import_batches`

| Columna | Tipo | Nulabilidad | Nota |
| --- | --- | --- | --- |
| `id` | `uuid` | PK `defaultRandom()` | |
| `organization_id` | `text` | NOT NULL | FK → `organizations.id` `ON DELETE CASCADE` |
| `owner_user_id` | `text` | NOT NULL | FK → `auth_users.id` `ON DELETE CASCADE` |
| `mode` | `text` | NOT NULL | `urls \| csv \| pasted_texts` |
| `status` | `text` | NOT NULL `'queued'` | `queued \| running \| partial \| succeeded \| failed \| cancelled` |
| `total_items` | `integer` | NOT NULL | |
| `succeeded_count` / `failed_count` / `skipped_count` / `cancelled_count` | `integer` | NOT NULL `0` | |
| `max_credit_units` | `integer` | NOT NULL | techo mostrado al usuario antes de empezar |
| `settled_credit_units` | `integer` | NOT NULL `0` | suma real liquidada |
| `source_policy_version` | `text` | NOT NULL | |
| `error_code` | `text` | NULL | código corto redactado, nunca mensaje de proveedor |
| `cancel_requested_at` | `timestamptz` | NULL | señal de cancelación cooperativa |
| `started_at` / `finished_at` | `timestamptz` | NULL | |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL `now()` | |

```ts
uniqueIndex('job_import_batches_organization_id_id_unique').on(t.organizationId, t.id),
index('job_import_batches_owner_status_idx').on(t.organizationId, t.ownerUserId, t.status, t.createdAt),
// Un solo lote activo por persona. Es un límite de producto y a la vez el freno de coste.
uniqueIndex('job_import_batches_owner_active_unique')
  .on(t.organizationId, t.ownerUserId)
  .where(sql`${t.status} in ('queued','running')`),
check('job_import_batches_mode_check', sql`${t.mode} in ('urls','csv','pasted_texts')`),
check('job_import_batches_status_check',
  sql`${t.status} in ('queued','running','partial','succeeded','failed','cancelled')`),
check('job_import_batches_total_check', sql`${t.totalItems} between 1 and 50`),
check('job_import_batches_counters_check',
  sql`${t.succeededCount} >= 0 and ${t.failedCount} >= 0 and ${t.skippedCount} >= 0
      and ${t.cancelledCount} >= 0 and ${t.settledCreditUnits} >= 0
      and ${t.succeededCount} + ${t.failedCount} + ${t.skippedCount} + ${t.cancelledCount} <= ${t.totalItems}`),
check('job_import_batches_finished_check',
  sql`${t.finishedAt} is null or ${t.startedAt} is not null`),
```

### `job_import_items`

| Columna | Tipo | Nulabilidad | Nota |
| --- | --- | --- | --- |
| `id` | `uuid` | PK `defaultRandom()` | |
| `organization_id` | `text` | NOT NULL | FK → `organizations.id` `ON DELETE CASCADE` |
| `batch_id` | `uuid` | NOT NULL | FK compuesta → `job_import_batches` `ON DELETE CASCADE` |
| `item_index` | `integer` | NOT NULL | índice estable 0..n-1, es lo que ve el usuario |
| `input_kind` | `text` | NOT NULL | `url \| text` |
| `input_url` | `text` | NULL | |
| `normalized_url` | `text` | NULL | |
| `input_host` | `text` | NULL | host registrable; gobierna la concurrencia por host |
| `input_text_sha256` | `text` | NULL | para `input_kind = 'text'`; el texto vive en la versión, no aquí |
| `status` | `text` | NOT NULL `'queued'` | `queued \| running \| succeeded \| duplicate \| failed \| skipped \| cancelled` |
| `opportunity_id` | `uuid` | NULL | FK compuesta → `job_opportunities` `ON DELETE SET NULL` |
| `error_code` | `text` | NULL | código corto de `SafeFetchErrorCode` o del importador |
| `attempt_count` | `integer` | NOT NULL `0` | |
| `available_at` | `timestamptz` | NOT NULL `now()` | backoff exponencial |
| `lease_token` | `text` | NULL | |
| `lease_expires_at` | `timestamptz` | NULL | |
| `reservation_id` | `text` | NULL | reserva de créditos de ESTE item |
| `settled_credit_units` | `integer` | NOT NULL `0` | |
| `started_at` / `finished_at` | `timestamptz` | NULL | |
| `created_at` / `updated_at` | `timestamptz` | NOT NULL `now()` | |

```ts
uniqueIndex('job_import_items_organization_id_id_unique').on(t.organizationId, t.id),
uniqueIndex('job_import_items_batch_index_unique').on(t.organizationId, t.batchId, t.itemIndex),
foreignKey({
  columns: [t.organizationId, t.batchId],
  foreignColumns: [jobImportBatches.organizationId, jobImportBatches.id],
  name: 'job_import_items_organization_batch_fk',
}).onDelete('cascade'),
foreignKey({
  columns: [t.organizationId, t.opportunityId],
  foreignColumns: [jobOpportunities.organizationId, jobOpportunities.id],
  name: 'job_import_items_organization_opportunity_fk',
}).onDelete('set null'),
// El escaneo del worker: cruza organizaciones a propósito (ver §RLS del worker).
index('job_import_items_worker_scan_idx')
  .on(t.status, t.availableAt, t.leaseExpiresAt),
// La ventana de concurrencia por host.
index('job_import_items_host_idx').on(t.inputHost, t.status),
index('job_import_items_batch_idx').on(t.organizationId, t.batchId, t.itemIndex),
check('job_import_items_status_check',
  sql`${t.status} in ('queued','running','succeeded','duplicate','failed','skipped','cancelled')`),
check('job_import_items_input_kind_check', sql`${t.inputKind} in ('url','text')`),
// Un item de URL tiene URL normalizada y host; uno de texto tiene hash. Nunca ambos vacíos.
check('job_import_items_input_presence_check',
  sql`(${t.inputKind} = 'url' and ${t.normalizedUrl} is not null and ${t.inputHost} is not null)
      or (${t.inputKind} = 'text' and ${t.inputTextSha256} is not null)`),
check('job_import_items_attempt_check', sql`${t.attemptCount} >= 0 and ${t.settledCreditUnits} >= 0`),
// Un lease es token + caducidad, o ninguno de los dos.
check('job_import_items_lease_check',
  sql`(${t.leaseToken} is null) = (${t.leaseExpiresAt} is null)`),
// Solo un item en curso puede tener lease.
check('job_import_items_lease_status_check',
  sql`${t.leaseToken} is null or ${t.status} = 'running'`),
// Un éxito produjo una oferta.
check('job_import_items_success_check',
  sql`${t.status} not in ('succeeded','duplicate') or ${t.opportunityId} is not null`),
// Un fallo tiene motivo.
check('job_import_items_error_check',
  sql`(${t.status} = 'failed') = (${t.errorCode} is not null)`),
```

El input crudo de un item **no se almacena en claro más allá de la URL normalizada y el hash del
texto**. El texto pegado de un item vive únicamente en la `job_opportunity_versions` que produce; si
el item falla, el texto no se persiste en ninguna parte.

### RLS — texto exacto de las políticas

Las cuatro tablas: `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`.

```sql
-- job_opportunities: tenant AND owner. El predicado de tenant solo filtra entre miembros.
CREATE POLICY job_opportunities_app_owner_all ON job_opportunities
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  )
  WITH CHECK (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND owner_user_id = nullif(current_setting('app.user_id', true), '')
  );

-- job_opportunity_versions: la propiedad se hereda de la oferta, un salto (0085 hace tres).
-- No hay política FOR UPDATE en ningún rol: el snapshot es inmutable por construcción.
CREATE POLICY job_opportunity_versions_app_owner_select ON job_opportunity_versions
  FOR SELECT TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM job_opportunities o
      WHERE o.organization_id = job_opportunity_versions.organization_id
        AND o.id = job_opportunity_versions.opportunity_id
        AND o.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  );
CREATE POLICY job_opportunity_versions_app_owner_insert ON job_opportunity_versions
  FOR INSERT TO builderhunt_app
  WITH CHECK ( /* mismo predicado */ );
CREATE POLICY job_opportunity_versions_app_owner_delete ON job_opportunity_versions
  FOR DELETE TO builderhunt_app
  USING ( /* mismo predicado */ );

-- job_import_batches: tenant AND owner, igual que la raíz.
CREATE POLICY job_import_batches_app_owner_all ON job_import_batches
  FOR ALL TO builderhunt_app
  USING (organization_id = nullif(current_setting('app.organization_id', true), '')
         AND owner_user_id = nullif(current_setting('app.user_id', true), ''))
  WITH CHECK (organization_id = nullif(current_setting('app.organization_id', true), '')
              AND owner_user_id = nullif(current_setting('app.user_id', true), ''));

-- job_import_items: hereda del lote.
CREATE POLICY job_import_items_app_owner_all ON job_import_items
  FOR ALL TO builderhunt_app
  USING (
    organization_id = nullif(current_setting('app.organization_id', true), '')
    AND EXISTS (
      SELECT 1 FROM job_import_batches b
      WHERE b.organization_id = job_import_items.organization_id
        AND b.id = job_import_items.batch_id
        AND b.owner_user_id = nullif(current_setting('app.user_id', true), '')
    )
  )
  WITH CHECK ( /* mismo predicado */ );
```

**Worker.** El barrido de leases es necesariamente cross-organización: el worker busca items
vencidos sin saber de quién son, exactamente como `reclaimExpiredEnrichmentLeases`
(`src/shared/lib/repositories/enrichment-worker.ts:71-78`). Por eso las políticas de
`builderhunt_worker` son `USING (true)`, igual que las de `0085`:

```sql
CREATE POLICY job_import_items_worker_all ON job_import_items
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);
CREATE POLICY job_import_batches_worker_all ON job_import_batches
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);
CREATE POLICY job_opportunities_worker_all ON job_opportunities
  FOR ALL TO builderhunt_worker USING (true) WITH CHECK (true);
CREATE POLICY job_opportunity_versions_worker_insert ON job_opportunity_versions
  FOR INSERT TO builderhunt_worker WITH CHECK (true);
CREATE POLICY job_opportunity_versions_worker_select ON job_opportunity_versions
  FOR SELECT TO builderhunt_worker USING (true);
```

El aislamiento del worker lo garantiza el código, no RLS: tras reclamar el lote de items, el worker
los agrupa por `organization_id` y procesa **cada organización en su propia transacción** vía
`withWorkerOrganization` (`src/shared/lib/repositories/alerts-worker.ts:14`), de modo que el fallo
de una organización no aborta ni contamina a otra (`security-policy.md` §AI y trabajo en segundo
plano). Esto se declara aquí porque es una relajación consciente respecto al app role, y la prueba
de que se respeta vive en `checkJobWorkspace()`.

### GRANTs por rol — explícitos

```sql
REVOKE ALL ON TABLE job_opportunities, job_opportunity_versions,
                    job_import_batches, job_import_items FROM PUBLIC;

-- builderhunt_app (runtime web). Sin TRUNCATE, sin REFERENCES.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE job_opportunities  TO builderhunt_app;
GRANT SELECT, INSERT,         DELETE ON TABLE job_opportunity_versions TO builderhunt_app; -- sin UPDATE: inmutable
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE job_import_batches TO builderhunt_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE job_import_items   TO builderhunt_app;

-- builderhunt_worker (importador de lotes). No borra nada.
GRANT SELECT, INSERT, UPDATE ON TABLE job_opportunities        TO builderhunt_worker;
GRANT SELECT, INSERT         ON TABLE job_opportunity_versions TO builderhunt_worker;
GRANT SELECT,         UPDATE ON TABLE job_import_batches       TO builderhunt_worker;
GRANT SELECT,         UPDATE ON TABLE job_import_items         TO builderhunt_worker;
```

Sin grants para `builderhunt_platform`, `builderhunt_capability`, `builderhunt_auth` ni
`builderhunt_readonly`. Justificación por rol:

- `builderhunt_platform` — la consola de plataforma no necesita leer búsquedas de empleo de nadie.
  Los dashboards de coste se construyen sobre el ledger de billing, que ya tiene sus propios grants.
- `builderhunt_capability` — es el rol del candidato sin cuenta en el flujo de entrevistas. Aquí no
  hay ningún actor sin cuenta.
- `builderhunt_auth` — solo tablas de auth/organización (`drizzle/0007_auth_broker.sql`). Un
  `UPDATE` desde ahí sería `42501` o, peor, un no-op silencioso.
- `builderhunt_readonly` — analítica; estas tablas no entran en analítica.

## Autorización de aplicación

`src/shared/lib/auth/career-principal.ts` (new) expone:

```ts
/** Resuelve SIEMPRE la organización personal del sujeto. Nunca lee session.activeOrganizationId. */
export async function requireCareerPrincipal(request: Request): Promise<TenantPrincipal>
```

Pasos: resolver la sesión Better Auth → `ensurePersonalOrganization(userId)` (idempotente, repara la
organización personal si falta) → devolver `{ userId, organizationId: personalOrganizationId(userId),
role: 'owner', requestId }`. Lanza `TenantAuthorizationError` sin sesión.

Cinco acciones nuevas en `PermissionAction` (`src/shared/lib/authorization/permissions.ts`):
`'job:read' | 'job:create' | 'job:update' | 'job:delete' | 'job:import'`. Las cinco resuelven
`resource.creatorUserId === principal.userId` y **nunca** consultan `elevated`, exactamente como las
acciones `calendar:*`/`candidate-data:read` que ya existen por la misma razón. Ser owner o admin de
una organización no otorga nada aquí.

## IA — `job-description-extract`

Task nueva en `src/shared/lib/ai/tasks.ts`. Este plan es su único dueño.

- `tier: 'server-only'` — el artefacto se persiste y es la base de decisiones downstream; la
  consistencia entre navegador y worker de lotes no es negociable.
- `inputSchema`: `z.object({ text: z.string().min(200).max(60000), sourceHint: z.string().max(120).optional() })`.
- `outputSchema` (`jobExtractionSchema`, exportado desde `src/shared/lib/jobs/contracts.ts` (new) e
  importado por `tasks.ts`, siguiendo el patrón de `extractedCriteriaSchema`):

```ts
export const evidenceSpanSchema = z.object({
  field: z.string().min(1).max(40),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
})
export const jobExtractionSchema = z.object({
  title: z.string().min(1).max(200).nullable(),
  companyName: z.string().min(1).max(200).nullable(),
  locationText: z.string().max(200).nullable(),
  countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
  remotePolicy: z.enum(['onsite', 'hybrid', 'remote']).nullable(),
  employmentType: z.enum(['full_time','part_time','contract','internship','temporary']).nullable(),
  seniority: z.enum(['junior','mid','senior','lead','unknown']).nullable(),
  salaryMin: z.number().int().min(0).nullable(),
  salaryMax: z.number().int().min(0).nullable(),
  salaryCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  salaryPeriod: z.enum(['hour','day','month','year']).nullable(),
  language: z.string().max(20).nullable(),
  required: z.array(z.string().min(1).max(300)).max(30),
  preferred: z.array(z.string().min(1).max(300)).max(30),
  responsibilities: z.array(z.string().min(1).max(300)).max(30),
  benefits: z.array(z.string().min(1).max(300)).max(30),
  skills: z.array(z.string().min(1).max(80)).max(40),
  evidence: z.array(evidenceSpanSchema).max(80),
})
```

- **Contenido no confiable**: `buildPrompt` envuelve el texto con `wrapUntrusted(input.text)`
  (`src/shared/lib/ai/tasks.ts:735`) y el `system` declara que el bloque `<untrusted>` es dato
  inerte, que ninguna frase imperativa dentro se obedece, que ningún campo se rellena sin evidencia
  literal en el texto y que el esquema de salida no cambia bajo ninguna instrucción.
- **Reparación**: una sola, la que ya implementa la plataforma (`ai-policy.md` regla 1). Si falla
  otra vez, `extractor = 'fallback'`.
- **Cache**: `tenantAiCacheKey({ organizationId, artifact: 'job-description-extract',
  input: sourceTextSha256 })` de `src/shared/lib/ai/cache.ts:5`. **No** se usa `cacheKeyFor`, que es
  `ai:cache:{taskId}:{hash}` global y compartiría extracciones entre organizaciones. TTL 30 días
  (`cacheTtlSeconds: 2_592_000`), coherente con `profile-enrich`.
- **Allowances**: `{ free: 5, pro: 100, team: 300 }`, `maxOutputTokens: 1400`.
- **IA deshabilitada** (`AI_DISABLED=true`, `AI_DISABLED_TASKS` incluye la task, o
  `MINIMAX_API_KEY` ausente): la importación NO falla. Se crea la versión con `extractor='fallback'`,
  `extracted_fields = '{}'`, `review_status='manual_required'`, `source_text` intacto, y la UI pide
  edición manual. Ninguna reserva de créditos se abre en este camino.
- La tarea **nunca** opina sobre si el usuario "debería" aplicar. Eso no está en el esquema.

## Adquisición de URL y defensas SSRF

`src/lib/jobs/source-policies.ts` (new) define `JOB_SOURCE_POLICIES`, deny-by-default, con la
misma disciplina que `src/lib/enrichment/policies.ts`: `id`, `acquisitionMode`
(`official_api | authorized_crawl`), `status`, `permissionReference`, `lawfulBasisReference`,
`reviewExpiresAt`, `allowedHosts`, `robotsRequired`, `maxRequestsPerMinute`. Un módulo separado y no
una extensión de `SOURCE_POLICIES` porque aquel lleva `allowedFields: EnrichmentField[]`, que
describe campos de perfil de persona y no tiene sentido aquí; mezclarlos obligaría a un tipo unión
en `SourcePolicy` y a que el registro de enriquecimiento tuviera entradas que sus conectores nunca
usan. `resolveJobSource(url)` importa y reevalúa `HARD_BLOCKED_CONNECTOR_IDS` de
`src/lib/enrichment/policies.ts`, de modo que LinkedIn/X/Facebook/Instagram no pueden entrar aquí
aunque alguien añada una entrada.

Defensas por hop, todas **fail-closed** (el error detiene la importación de ese item; nunca
degrada a "continuar sin comprobar"):

| # | Defensa | Dónde | Fallo produce |
| --- | --- | --- | --- |
| 1 | URL parseable, sin credenciales embebidas, esquema http/https | `validateExternalHttpUrl` | `invalid_url` |
| 2 | Host en `allowedHosts` de una política `enabled` y no caducada | `resolveJobSource` + `safeFetch({allowedHosts})` | `source_not_allowed` / `host_not_allowed` |
| 3 | Solo HTTPS | `safeFetch` (`network.ts:80`) | `host_not_allowed` |
| 4 | Resolución DNS y bloqueo de rangos privados/loopback/link-local/CGNAT/multicast, IPv4 e IPv6 incluidos los `::ffff:` mapeados | `isPrivateAddress` (`url-policy.ts:99`) | `private_network` |
| 5 | Endpoint de metadatos de nube (`169.254.169.254`) | cubierto por #4 (`a===169 && b===254`) | `private_network` |
| 6 | Redirecciones `manual`, máximo 3, **revalidando #1–#5 en cada hop** | bucle de `safeFetch` | `too_many_redirects` / `redirect_denied` |
| 7 | Timeout 10 s por hop | `AbortController` en `safeFetch` | `timeout` |
| 8 | Tamaño ≤ 2 MiB, comprobado por `content-length` **y** por bytes leídos en streaming | `readBoundedBody` | `too_large` |
| 9 | Content-type en `application/json \| text/html \| text/plain` | `safeFetch` | `unsupported_content_type` |
| 10 | robots.txt para `authorized_crawl` | `isPathAllowedByRobots` | ver abajo |
| 11 | 401/403 upstream → no se intenta autenticar, no se reintenta | `safeFetch` | `auth_required` |
| 12 | 429 upstream → backoff con `Retry-After`; nunca se elude | `safeFetch` | `rate_limited` |
| 13 | Rate limit propio por usuario, por organización y por host | `src/shared/lib/rate-limit.ts` | `rate_limited_local` |
| 14 | El HTML se convierte a texto plano descartando `<script>`, `<style>`, `<iframe>`, atributos `on*` y comentarios; nunca se guarda ni se renderiza HTML | `extractReadableText` en `import-url.ts` | — |

**robots tri-estado, resuelto explícitamente.** `isPathAllowedByRobots` devuelve
`'allowed' | 'disallowed' | 'unavailable'`, y `'unavailable'` es distinto de `'disallowed'`. Para
una política con `robotsRequired: true` (`acquisitionMode: 'authorized_crawl'`), **tanto
`'disallowed'` como `'unavailable'` detienen la importación** con `error_code = 'robots_denied'` y
`'robots_unavailable'` respectivamente. Fail-closed significa que la ausencia de permiso no es
permiso. Para `acquisitionMode: 'official_api'` (`robotsRequired: false`) no se consulta robots,
igual que `SOURCE_POLICIES.github`.

Fixtures que prueban cada uno (`tests/unit/lib/jobs/import-url.test.ts` (new)): `http://` en claro,
`https://user:pass@host`, `localhost`, `127.0.0.1`, `10.0.0.1`, `192.168.1.1`, `172.16.0.1`,
`169.254.169.254`, `[::1]`, `[fd00::1]`, `[::ffff:127.0.0.1]`, un host que resuelve a IP pública
pero no está en `allowedHosts`, un host de `HARD_BLOCKED_CONNECTOR_IDS`, una cadena de 4
redirecciones, una redirección de host público a `127.0.0.1`, un `content-length: 5000000`, un
cuerpo en streaming que supera 2 MiB sin `content-length`, `content-type: application/pdf`, un 401,
un 429 con `Retry-After: 120`, un `robots.txt` que devuelve `Disallow: /` y un origen cuyo
`robots.txt` da 500 (→ `unavailable` → parada).

## Billing

- Nueva rate card en `src/shared/lib/billing/rate-cards.ts`:

```ts
job_description_extract: {
  operation: 'job_description_extract', version: 1, maxUnits: 3, maxDurationSeconds: 120,
  settlementGraceSeconds: 60,
  // null y no 'pro': con STRIPE_BILLING_ENABLED en false nadie puede auto-subirse de plan, así que
  // un minimumTier convertiría la extracción en inalcanzable. El freno real son los créditos.
  minimumTier: null,
},
```

- **Un flujo, una reserva por extracción.** `reserveCredits` de `feature-authorization.ts` toma
  `maxUnits` de la rate card y el llamante NO puede pasar unidades, por diseño ("client input can
  never widen `maxUnits`"). Por eso se descarta reservar el lote entero con una card
  `job_import_batch` de `maxUnits: 150`: bloquearía 150 unidades a quien importa 3 URLs. El lote
  hace **una reserva por item, en el momento de reclamarlo**, con
  `reservationId = item.id` e `idempotencyKey = 'job-import-item:{itemId}:reserve'`.
- **Preflight de coste**: al crear el lote se calcula `max_credit_units = 3 × totalItems`, se
  compara contra `getAvailableCreditBalance` y se muestra al usuario. Si no alcanza, el lote se
  rechaza con `402 insufficient_credits` **antes** de crear ninguna fila de item.
- **Liquidación**: extracción correcta → `settleReservation(actualUnits)`; el resto de la reserva
  vuelve solo. Extracción que no llegó a llamar al proveedor (fetch fallido, robots, duplicado
  detectado antes de IA, IA deshabilitada) → `releaseReservation(reason)` completo, cero unidades.
  Fallo del proveedor a mitad → `releaseReservation('provider_failure')`; nunca se cobra un
  resultado que el usuario no recibió.
- **Cancelación**: `cancel_requested_at` se comprueba (a) antes de reclamar un item y (b) justo
  antes de reservar. Los items ya `running` con reserva abierta terminan su hop y liquidan lo real;
  los `queued` pasan a `cancelled` sin reserva, luego sin coste.
- **Éxito parcial**: cada item liquida o libera independientemente.
  `batch.settled_credit_units = sum(items.settled_credit_units)`, y el estado final es `succeeded`
  si `failed_count = 0`, `partial` si hay éxitos y fallos, `failed` si no hay ningún éxito.
- **Reconciliación del ledger**: al cerrar el lote, el worker verifica que ningún item quedó con
  `reservation_id` no nulo y reserva en estado `reserved`. Un item huérfano (crash entre reservar y
  liquidar) lo recoge el barrido de leases: al reclamarlo con el mismo `idempotencyKey`,
  `reserveCredits` replica la reserva existente en vez de abrir otra, y el hop reintentado la cierra.
- Los límites se leen del catálogo central; la UI muestra la estimación derivada de la rate card,
  nunca un número escrito a mano.

Estimación a validar en Fase 0: 2k–6k tokens de entrada y <1k de salida por oferta; un lote de 15
implica hasta 15 llamadas server-side. La rate card se ajusta (subiendo `version`) tras medir el
corpus real.

## Dedupe, versionado y frescura

Orden de señales, evaluado en `src/shared/lib/jobs/dedupe.ts` (new):

1. `(source_id, source_external_id)` → **exact**. Es la identidad que publica la propia fuente.
2. `normalized_url` → **exact**. Lo impone además el índice único parcial.
3. `content_fingerprint` idéntico → **exact**.
4. `company_normalized` igual + similitud de `title_normalized` por trigram ≥ 0.8 → **probable**.

Un **exact** en un lote marca el item `duplicate`, lo enlaza a la oferta existente y **no** consume
IA. Un **probable** crea la oferta igualmente y devuelve el candidato en la respuesta; el sistema
nunca fusiona dos ofertas ambiguas por su cuenta. `POST /api/jobs/:id/merge` requiere que el usuario
nombre explícitamente el `targetId` y la versión superviviente.

**Semántica de versión pinneada — esto es el contrato downstream.**

- Un `job_opportunity_versions` es inmutable. No hay `UPDATE` posible (ni grant ni política).
- Un refresh **inserta una versión nueva** con `version_number = max + 1`, calcula `changed_fields`
  contra la anterior y mueve `job_opportunities.current_version_id`. **No toca** la versión
  anterior. Un CV generado contra la versión 2 sigue resolviendo la versión 2 palabra por palabra
  después de tres refrescos.
- Si el contenido descargado tiene el mismo `source_text_sha256` que la versión actual, el refresh
  **no crea versión**: solo actualiza `last_verified_at` y los validadores HTTP. Un `304 Not
  Modified` hace lo mismo sin descargar cuerpo y sin gastar IA.
- `expires_at` pasado, o `last_verified_at` con más de 30 días, marcan la oferta como *stale* en la
  UI y en el DTO (`stale: true`). No cambian `status` automáticamente: caducar la oferta de otro es
  una decisión del usuario, no del sistema.
- Borrar la oferta borra sus versiones en cascada. Los planes downstream **no** deben poner una FK
  `restrict` contra `job_opportunity_versions` (haría a la oferta indeleteable). Ver §Contrato
  publicado.

## API

Todas las rutas resuelven `requireCareerPrincipal(request)` y corren bajo `withTenantContext`. Todos
los cuerpos y query strings son DTOs zod estrictos (`.strict()`), y todas las respuestas son listas
de campos explícitas — nunca una fila de ORM extendida.

| Ruta | Método | Nota |
| --- | --- | --- |
| `/api/jobs` | GET | `?status=&q=&cursor=&limit=` (≤ 50). Cursor `(updated_at, id)` |
| `/api/jobs` | POST | crea manual o confirma un preview; `Idempotency-Key` obligatorio |
| `/api/jobs/$jobId` | GET | oferta + versión actual + resumen de versiones |
| `/api/jobs/$jobId` | PATCH | `If-Match: <version>`; desajuste → `409 version_conflict` |
| `/api/jobs/$jobId` | DELETE | destructivo, cascada a versiones |
| `/api/jobs/$jobId/archive` | POST | `status = 'archived'`, no destructivo |
| `/api/jobs/$jobId/refresh` | POST | condicional con ETag/Last-Modified |
| `/api/jobs/$jobId/versions` | GET | lista; `?compare=a,b` devuelve el diff |
| `/api/jobs/$jobId/merge` | POST | `{ targetId, keepVersionId }`, explícito |
| `/api/jobs/import/preview` | POST | manual/paste/URL. **No persiste, no cobra** salvo la reserva de la extracción, que se liquida o libera en la misma request |
| `/api/jobs/dedupe-preview` | POST | señales sin escribir |
| `/api/jobs/import/batch` | POST | crea lote + items; devuelve `maxCreditUnits` |
| `/api/jobs/import/batch/$batchId` | GET | progreso por item |
| `/api/jobs/import/batch/$batchId/cancel` | POST | idempotente |
| `/api/jobs/import/batch/$batchId/errors.csv` | GET | errores corregibles, reimportables |
| `/api/admin/jobs/run-import-worker` | POST | `tryCronPrincipal ?? requirePlatformAdminPrincipal` |

Códigos: `401` sin sesión; `404` para cualquier id ajeno (nunca `403` — un `403` confirmaría que la
fila existe); `409` en conflicto de versión o de lote activo; `402 insufficient_credits`;
`422` en zod; `429` en rate limit.

## Worker de lotes

`POST /api/admin/jobs/run-import-worker` clona `src/routes/api/admin/alerts/run-worker.ts` en
estructura exacta: `tryCronPrincipal(request) ?? await requirePlatformAdminPrincipal(request)`,
envuelto en `withJobRun({ jobKey: 'jobs.import' })`, con
`auditPlatformAdminAction({ action: 'admin.worker.run', targetId: 'jobs-import' })`. Sin cola nueva.

`claimJobImportItems(limit, leaseSeconds)` en `src/shared/lib/repositories/job-import-worker.ts` (new)
(nuevo), modelado sobre `claimEnrichmentJobs`:

```sql
WITH candidate AS (
  SELECT i.id,
         row_number() OVER (PARTITION BY i.input_host ORDER BY i.available_at, i.item_index) AS host_rank
  FROM job_import_items i
  JOIN job_import_batches b
    ON b.organization_id = i.organization_id AND b.id = i.batch_id
  WHERE i.status = 'queued'
    AND i.available_at <= now()
    AND b.status IN ('queued', 'running')
    AND b.cancel_requested_at IS NULL
    -- Respeta la concurrencia por host contando lo que ya está en vuelo.
    AND (SELECT count(*) FROM job_import_items r
         WHERE r.input_host = i.input_host AND r.status = 'running'
           AND r.lease_expires_at > now()) < $perHostConcurrency
  ORDER BY i.available_at, i.item_index
  FOR UPDATE SKIP LOCKED
  LIMIT $limit
)
UPDATE job_import_items SET
  status = 'running', lease_token = $token,
  lease_expires_at = now() + make_interval(secs => $leaseSeconds),
  attempt_count = attempt_count + 1, started_at = coalesce(started_at, now()), updated_at = now()
WHERE id IN (SELECT id FROM candidate WHERE host_rank <= $perHostConcurrency)
RETURNING *;
```

- **Lease**: `lease_token` (uuid) + `lease_expires_at`. `JOB_IMPORT_LEASE_SECONDS`, default **120**
  (el techo de un hop es 10 s de fetch + una llamada IA de hasta 120 s de `maxDurationSeconds`; 120
  cubre el caso normal y deja que un cuelgue se recupere en dos minutos, no en veinte).
- **Reinicio a mitad de lote**: `reclaimExpiredJobImportLeases()` devuelve a `queued`
  (`lease_token = null`) todo item `running` con `lease_expires_at < now()` y
  `attempt_count < JOB_IMPORT_MAX_ATTEMPTS` (default 3), aplicando backoff
  `available_at = now() + 2^attempt × 30 s`. Superado el máximo → `failed` con
  `error_code = 'lease_exhausted'`. Si el item tenía `reservation_id`, el reintento reusa la misma
  `idempotencyKey` y `reserveCredits` replica la reserva en vez de duplicarla.
- **Concurrencia**: `JOB_IMPORT_PER_HOST_CONCURRENCY` default **1**, `JOB_IMPORT_BATCH_SIZE` default
  **5** items por invocación. Cadencia de cron: cada 2 minutos.
- **Doble disparo del cron**: `FOR UPDATE SKIP LOCKED` más el lease hacen que la segunda invocación
  simplemente no vea los items reclamados. No se duplica trabajo ni gasto.
- **Cierre del lote**: cuando no queda ningún item en `queued`/`running`, el worker fija
  `status`, `finished_at` y `settled_credit_units`, en la transacción de esa organización.

## Integración UX

Nueva área `Career` en `src/modules/dashboard/ui/shell/nav-config.ts` (`NAV_AREAS`), con
`routes: ['/jobs']` y un ítem `{ to: '/jobs', label: 'Job opportunities', icon: Briefcase }`. El
área es propia y no un ítem dentro de `Discover` porque `/jobs` es el sujeto-persona buscando
trabajo, no la organización buscando gente, y los planes downstream añadirán `/cv` y
`/applications` a la misma área.

Pantallas (`src/modules/jobs/`):

- `JobsPage.tsx` — inbox: buscador, filtros por `status`/`source_type`/`remote_policy`, orden,
  estado vacío que explica los cuatro modos de entrada, badge *stale*, acciones masivas de archivar
  y borrar con confirmación.
- `JobEditor.tsx` — detalle editable con procedencia visible (URL final, `fetched_at`, política y
  extractor aplicados) y los campos sin evidencia claramente marcados como vacíos, no como cero.
- `JobImportDialog.tsx` — pegar texto / URL / CSV; muestra el coste máximo antes de confirmar; el
  preview es editable y nada se persiste hasta confirmar.
- `JobImportBatchPage.tsx` — progreso por item, errores descargables, reintentar seleccionados.
- `JobVersionDiff.tsx` — diff campo a campo entre dos versiones.
- Las acciones "Generate tailored CV" y "Add to application queue" se renderizan **deshabilitadas**
  con un tooltip que nombra el plan que las traerá. No se enlaza a rutas inexistentes.

Accesibilidad: el wizard de importación es navegable por teclado completo, el progreso del lote se
anuncia en una región `aria-live="polite"`, y el diff no depende solo del color.

## Contrato publicado para planes downstream

Esto es lo que `ai-cv-generation-and-tailoring` y `delegated-job-applications` pueden asumir sin
preguntar. Cambiarlo requiere modificar los tres planes a la vez.

1. **Referencia estable**: la tupla `(organization_id, opportunity_id, opportunity_version_id)`.
   Nunca `opportunity_id` a secas para un artefacto generado: eso pierde la reproducibilidad.
2. **FK a usar**: compuesta `(organization_id, job_opportunity_version_id)` →
   `job_opportunity_versions(organization_id, id)` con **`ON DELETE SET NULL`**, más una copia
   desnormalizada de `title` y `company_name` en la tabla downstream. `restrict` haría la oferta
   indeleteable y convertiría el derecho de borrado del usuario en un bug.
3. **Inmutabilidad**: una versión pinneada nunca cambia de contenido. Ni un refresh, ni un merge, ni
   una revisión la mutan. Si `current_version_id` cambia, la pinneada sigue ahí.
4. **Frescura**: el DTO expone `stale: boolean` y `currentVersionId`. Un plan downstream que quiera
   avisar "esta oferta cambió desde tu CV" compara su versión pinneada con `currentVersionId`.
5. **Campos garantizados no nulos** en la versión: `source_text`, `source_text_sha256`,
   `extracted_fields` (puede ser `{}`), `extractor`, `extractor_version`, `review_status`,
   `version_number`. Todo lo demás puede ser `null` y hay que tratarlo como tal.
6. **`review_status`** es la señal de confianza. Un downstream que genere un artefacto público o
   costoso a partir de una versión `unreviewed` o `manual_required` debe avisar al usuario; nunca
   se le entrega una versión no confirmada sin ese estado explícito.
7. **Principal**: el downstream usa el mismo `requireCareerPrincipal`. No crea su propia resolución
   de organización personal.
8. **Prohibido**: escribir en `pipeline_*`, `candidate_submissions`, `organization_builders` o
   tablas de ATS desde el dominio de carrera. Distinto sujeto, distinto consentimiento.
9. **Ids de task IA**: este plan posee `job-description-extract` y ninguno más. `career-facts-extract`,
   `resume-*` y `candidate-job-fit`/`application-cover-letter` pertenecen a los otros dos.

## Seguridad, privacidad y retención

- URLs = input hostil; contenido descargado = prompt-injection hostil. Ambas cosas asumidas por
  defecto, no comprobadas caso a caso.
- Billing, cache IA y worker usan la **misma** organización personal resuelta en servidor.
- Nunca se almacenan cookies, tokens ni credenciales de portales de empleo. No hay columna donde
  ponerlos.
- `loadAccountExportSource` (`src/shared/lib/repositories/account-privacy.ts:72`) incorpora ofertas,
  versiones, lotes e items del sujeto. `hardDeleteAccountSubject` los elimina por cascada de
  `owner_user_id`; el test de la cascada es parte del release gate.
- Retención del input fallido: los items `failed` de un lote cerrado se purgan a los
  `JOB_IMPORT_FAILED_RETENTION_DAYS` (default 30) por el barrido del propio worker de importación.
- Logs: nunca descripción, ni URL con query string (se registra solo `input_host`), ni contenido de
  CV. Solo `taskId`, proveedor, latencia, tokens, `error_code` y correlación redactada
  (`security-policy.md` §AI y trabajo en segundo plano).
- Cambios en autorización y clasificación de datos → revisión de seguridad dedicada, según
  `security-policy.md` §Review ownership. Este plan la requiere: añade cinco `PermissionAction` y un
  principal nuevo.

## Métricas de éxito

- ≥ 80 % de los lotes de 10–15 URLs terminan en `succeeded` o `partial`, nunca en `failed`.
- Tiempo hasta la primera oferta usable < 90 s desde `/jobs` vacío (medido en el E2E).
- ≥ 60 % de las versiones creadas por IA acaban en `review_status = 'reviewed'` — si la gente no
  revisa, la extracción no es lo bastante buena y el downstream hereda basura.
- Tasa de dedupe > 0 en lotes reales, y cero fusiones automáticas.
- Coste mediano por oferta ≤ 3 unidades de crédito (el `maxUnits` de la rate card).
- Cero lecturas cross-tenant y cross-owner en `pnpm test:api-isolation:local`.
- Cero reservas huérfanas (`reserved` sin item vivo) tras un lote cerrado.

## Casos límite resueltos

- **Usuario sin organización personal** (hook de signup con carrera, organización borrada):
  `requireCareerPrincipal` llama `ensurePersonalOrganization`, que es idempotente y usa la función
  `bootstrap_personal_organization` ya desplegada. No se acepta ningún dato antes.
- **Sesión con organización de empresa activa**: irrelevante. El principal de carrera ignora
  `activeOrganizationId`. El E2E cambia la organización activa a mitad de sesión y comprueba que
  `/api/jobs` devuelve exactamente lo mismo.
- **Admin de la organización del usuario**: `GET /api/jobs` devuelve su propia colección (vacía);
  `GET /api/jobs/:idAjeno` devuelve **404**, no 403. Verificado por el test negativo obligatorio.
- **Dos pestañas editando la misma oferta**: `If-Match` con `version` → `409 version_conflict` con
  el `version` actual; la UI recarga en vez de pisar.
- **Refresh que devuelve el mismo contenido**: no crea versión, no gasta IA, actualiza
  `last_verified_at`.
- **Refresh que devuelve 404/410 en la fuente**: `status = 'expired'`, sin borrar nada, con una
  versión nueva `extractor = 'fallback'` que registra el hecho.
- **Refresh concurrente sobre la misma oferta**: la inserción de versión toma
  `SELECT ... FOR UPDATE` sobre la fila de oferta; el segundo refresh ve el hash nuevo y no duplica
  `version_number` (además del índice único que lo impediría).
- **CSV con columnas desconocidas o encoding raro**: se rechaza en el preview con el número de fila,
  antes de crear el lote. Máximo 50 filas; la 51 no crea un segundo lote silenciosamente.
- **Lote con las 15 URLs del mismo host**: la concurrencia por host lo serializa; tarda más, no
  falla, y no se rate-limita al host ajeno.
- **Crash del proceso a mitad de item**: el lease vence, el item vuelve a `queued`, el reintento
  reusa la reserva por `idempotencyKey`. Ningún crédito se pierde ni se cobra dos veces.
- **Cancelar un lote que ya terminó**: `cancel` es idempotente y devuelve `200` con el estado final;
  no revierte lo hecho.
- **Duplicado exacto detectado antes de IA**: item `duplicate`, enlazado a la oferta existente,
  reserva liberada, coste cero.
- **IA deshabilitada a mitad de lote**: los items restantes producen versiones
  `manual_required`; el lote termina `partial`, no `failed`.
- **Oferta borrada mientras un plan downstream la usa**: la FK downstream es `SET NULL` y el
  artefacto conserva su copia desnormalizada de título y empresa. No hay error, hay una referencia
  rota declarada.
