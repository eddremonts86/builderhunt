# Especificación — workspace interno de ofertas de trabajo

> **Status**: `pending`
> **Depends on**: [`security-and-multitenancy`](../../phase-1/security-and-multitenancy/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md)
> **Blocks**: [`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md), [`delegated-job-applications`](../delegated-job-applications/spec.md)
> **Reality check**: BuilderHunt no tiene tablas, repositorios, APIs ni UI para ofertas de trabajo.
> `jd-to-candidates-matching` acepta una descripción efímera para buscar candidatos, pero no crea un
> catálogo reutilizable. `candidate_submissions` y los `job_runs` de
> `src/shared/lib/db/schema.ts` pertenecen a entrevistas y procesos operacionales; no representan
> vacantes ni candidaturas de un usuario.

## Problema

Los workflows de CV adaptado y aplicación delegada necesitan una fuente de verdad para las ofertas:
qué empresa publica, qué pide, cuándo se capturó, si cambió, si sigue abierta y de dónde procede.
Aceptar únicamente texto suelto o URLs dentro de cada generación produciría duplicados, resultados
no reproducibles y aplicaciones contra ofertas caducadas.

## Objetivo

Crear un workspace privado donde una persona pueda:

- registrar una oferta manualmente;
- pegar una descripción en lenguaje natural;
- importar una URL;
- importar un lote de URLs o un CSV;
- revisar y corregir la extracción;
- detectar duplicados y cambios;
- clasificar, etiquetar, archivar y eliminar ofertas;
- ofrecer una API estable a matching, CV tailoring y aplicaciones.

## Decisión de privacidad

Las ofertas y candidaturas son **tenant-private con propietario individual**:

- toda fila incluye `organization_id` para RLS, billing y aislamiento;
- toda fila incluye `owner_user_id`;
- `organization_id` siempre es la organización personal del usuario, resuelta en servidor;
- la organización de empresa actualmente activa en la sesión no se usa como selector, autoridad ni
  pagador para el dominio de carrera;
- solamente el propietario puede leer o mutar su workspace de carrera;
- `owner/admin/member` de la organización no obtiene acceso implícito;
- si el usuario todavía no tiene organización personal válida, el servidor la crea/repara mediante
  el lifecycle existente antes de aceptar datos;
- compartir ofertas con un equipo requiere otro diseño y consentimiento explícito.

Esta doble restricción evita que un administrador de una organización profesional pueda ver que un
miembro está buscando otro empleo.

## Fuentes de entrada

### Entrada manual

Campos mínimos:

- cargo;
- empresa;
- descripción;
- URL opcional.

Los campos estructurados restantes pueden completarse manualmente o por extracción asistida.

### Texto libre

El usuario pega una oferta completa. El sistema conserva el texto original como snapshot privado y
propone una estructura editable. Ningún campo inferido se considera confirmado hasta revisión.

### URL individual

El servidor:

1. normaliza y valida URL;
2. resuelve DNS y bloquea destinos privados/metadata/loopback;
3. aplica el registro de políticas de fuente;
4. usa API oficial cuando exista;
5. solo usa crawling autorizado y respetuoso con robots/ToS;
6. limita redirecciones, tamaño, media type y tiempo;
7. extrae texto, descarta HTML activo y registra provenance.

No se eluden login, CAPTCHA, paywall, rate limits ni controles anti-bot.

### Lote

- hasta 50 items por importación en MVP; el caso prioritario son 15 URLs;
- URLs, texto separado o CSV con columnas documentadas;
- preview antes de iniciar;
- procesamiento asíncrono, cancelable e idempotente;
- progreso por item;
- éxito parcial;
- export de errores corregibles.

## Modelo de dominio

### `job_opportunities`

- `id`, `organization_id`, `owner_user_id`;
- `title`, `company_name`;
- `location_text`, `country_code`, `remote_policy`;
- `employment_type`, `seniority`, `salary_min`, `salary_max`, `salary_currency`;
- `status`: `draft | active | paused | expired | archived`;
- `source_type`: `manual | pasted_text | url | csv | official_api`;
- `source_url`, `normalized_url`, `source_external_id`;
- `current_version_id`;
- `first_seen_at`, `last_verified_at`, `expires_at`;
- timestamps.

Salario nunca se inventa; campos desconocidos permanecen `null`.

### `job_opportunity_versions`

Snapshot inmutable de:

- texto original/extractado;
- campos estructurados;
- fingerprint;
- extractor/policy version;
- URL final, HTTP validators y fetched-at;
- estado de revisión;
- cambios frente a la versión anterior.

El HTML bruto no se conserva.

### `job_import_batches`

- actor, modo, total y contadores;
- `queued | running | partial | succeeded | failed | cancelled`;
- policy version;
- timestamps y error agregado redacted.

### `job_import_items`

- batch + index estable;
- input cifrado o minimizado;
- oportunidad resultante;
- status/error code;
- attempt count y timestamps.

Las relaciones tenant-to-tenant usan FKs compuestas con `organization_id`.

## Normalización

- canonicalización segura de URL sin borrar identificadores significativos;
- empresa/cargo normalizados solo para búsqueda, preservando texto mostrado;
- fechas ISO y timezone explícita;
- lista controlada de employment/remote policy;
- requisitos separados en `required`, `preferred`, `responsibilities` y `benefits`;
- skills normalizadas con valor original conservado;
- idioma detectado y editable.

## Dedupe y cambios

Orden de señales:

1. source + external ID;
2. normalized URL;
3. fingerprint empresa + cargo + contenido;
4. candidato probable que requiere confirmación.

El sistema no fusiona automáticamente dos ofertas ambiguas. Una nueva versión actualiza el registro
existente sin perder el snapshot usado para un CV o aplicación anterior.

## API

- `GET/POST /api/jobs`;
- `GET/PATCH/DELETE /api/jobs/:id`;
- `POST /api/jobs/import`;
- `GET /api/jobs/import/:batchId`;
- `POST /api/jobs/import/:batchId/cancel`;
- `POST /api/jobs/:id/refresh`;
- `POST /api/jobs/:id/archive`;
- `POST /api/jobs/dedupe-preview`;
- `POST /api/jobs/:id/merge`.

Todas las requests usan DTOs Zod estrictos y resuelven `userId` y su organización personal en
servidor. Un `organizationId` del cliente se rechaza, incluso si corresponde a una membresía válida.

## UX

Nueva área `/jobs`:

- inbox/lista con búsqueda, filtros, orden y status;
- creación manual y paste;
- modal/import wizard para URL/CSV/lote;
- vista de progreso;
- detalle editable con source/provenance;
- diff de versiones;
- advertencia de stale/expired;
- acciones “Generate tailored CV” y “Add to application queue” deshabilitadas hasta que sus planes
  estén disponibles;
- bulk archive/delete con confirmación.

## IA

Task `job-description-extract`:

- `server-only` para persistencia consistente;
- entrada: texto del usuario o extracción web delimitada como untrusted;
- salida Zod estricta con campos y evidence spans;
- una reparación máximo;
- fallback determinista conserva texto y solicita edición manual;
- cache tenant-scoped por content hash, 30 días;
- nunca decide si el usuario “debe” aplicar.

## Billing y coste

- entrada manual sin IA: gratuita;
- extracción IA consume créditos solo después de preview/confirmación;
- el lote muestra coste máximo antes de empezar;
- reserva por batch, settlement por items procesados y release de sobrante;
- URL que falla antes de invocar IA no consume créditos de IA;
- límites configurados en el catálogo central, no hardcodeados en UI.

Estimación inicial a validar: una extracción por oferta, 2k–6k tokens de entrada y <1k de salida.
Un lote de 15 implica hasta 15 llamadas server-side; Phase 0 debe medir corpus real antes de fijar
créditos.

## Seguridad, privacidad y retención

- URLs se tratan como input hostil y contenido como prompt-injection hostil;
- RLS combina organización y propietario;
- billing, cache y workers usan la misma organización personal resuelta;
- rate limits por usuario, organización y host;
- no almacenar cookies ni credenciales del portal;
- export y account deletion incluyen ofertas, versiones y batches;
- retención configurable para input fallido; default 30 días;
- hard delete de una oferta conserva solo audit redacted cuando exista obligación operacional;
- logs nunca incluyen descripción, URL con tokens o contenido del CV.

## No objetivos

- crawler general de bolsas de trabajo;
- republicar ofertas públicamente;
- usar ofertas de un usuario para entrenar modelos;
- inferir salario, sponsorship o estado de apertura sin evidencia;
- aplicar a trabajos;
- compartir el workspace con empleadores;
- saltarse políticas de fuentes.

## Métricas

- ofertas creadas/importadas;
- import success/partial/failure por acquisition mode;
- dedupe rate;
- tiempo hasta primera oferta usable;
- porcentaje revisado por el usuario;
- stale/expired antes de downstream;
- coste/tokens por oferta;
- conversión oferta → CV → candidatura, agregada y sin texto privado.

## Criterios de aceptación

- una persona puede cargar 15 URLs y obtener resultados independientes/revisables;
- failures parciales no pierden éxitos;
- duplicados no crean candidaturas dobles;
- versiones históricas siguen resolviendo;
- usuario A y admin de su organización no leen el workspace privado de usuario B;
- cambiar el active organization de la sesión no cambia, duplica ni mueve el career workspace;
- SSRF, redirects y fuentes denegadas fallan antes de extracción/IA;
- ningún downstream recibe una oferta no confirmada sin status explícito;
- export, delete, retention, billing y observabilidad están probados.
