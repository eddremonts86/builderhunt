# Especificación — perfiles auto-gestionados (builders sin huella pública)

> **Status**: `pending`
> **Depends on**:
>   - [`03-onboarding-segmentado`](../03-onboarding-segmentado/spec.md) (segmento `building` ya definido)
>   - [`../phase-1/36-claimable-profiles/spec.md`](../../phase-1/36-claimable-profiles/spec.md) (modelo de `builder_claims` y DTOs públicos)
>   - [`../phase-1/37-portfolio-builder/spec.md`](../../phase-1/37-portfolio-builder/spec.md) (superficie de portfolio público, esquema v1)
>   - [`../phase-1/38-work-sample/spec.md`](../../phase-1/38-work-sample/spec.md) (modelo de evidencias/adjuntos)
> **Blocks**:
>   - [`04-dashboard-personalizado`](../04-dashboard-personalizado/spec.md) (necesita widgets para el segmento `building` que hoy no existen)
>   - [`06-landing-segmentada`](../06-landing-segmentada/spec.md) (la página `/for/builders` promete un flujo que este plan concreta)
> **Reality check**: El segmento `building` se describe en
> `plans/phase-2/01-investigacion-icp/spec.md` y
> `plans/phase-2/03-onboarding-segmentado/spec.md`, pero ambos asumen que el builder tiene una
> huella pública que el conector de una de las 15 fuentes indexó. `claimable-profiles` y
> `portfolio-builder` requieren ambos una tupla `(source, sourceId)` canónica. No existe
> ninguna ruta para una persona que no tiene perfil de GitHub, GitLab, Stack Overflow, ni
> ninguna de las fuentes activas. Esa persona queda excluida de BuilderHunt por construcción,
> aunque su trabajo (traducción, redacción, diseño, investigación, etc.) sea exactamente el
> tipo de evidencia que un reclutador o cliente busca.

## Problema

BuilderHunt indexa actividad pública de developer. Si una persona no ha publicado código,
preguntas, artículos, paquetes, modelos, ni nada en ninguna de las 15 fuentes activas, el
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

- Subida vía endpoint autenticado `POST /api/self-managed/attachments` con multipart,
  validado por Zod y por magic bytes (no solo por la extensión declarada).
- Allowlist MIME estricta:
  `application/pdf`, `image/png`, `image/jpeg`, `image/webp`,
  `audio/mpeg`, `audio/wav`, `video/mp4`.
- Tamaño máximo 25 MB por adjunto, 12 adjuntos por perfil.
- Almacenamiento en object storage (S3 / R2) bajo prefijo
  `self-managed/{userId}/{attachmentId}/{filename}`, nunca en el mismo bucket que
  datos de builder con claim.
- Sirviente pasa por `safeFetch`-equivalente (`safeDeliverBlob`): URL firmada de corta
  duración (15 min), sin listar el bucket, sin redirects al bucket original.
- Antivirus / scan de malware: integra con el servicio ya presente en BuilderHunt (ver
  `docker/clamav/`) en cola asíncrona; adjuntos recién subidos quedan en estado
  `pending_scan` y no se sirven hasta que el scan devuelva `clean`.
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
