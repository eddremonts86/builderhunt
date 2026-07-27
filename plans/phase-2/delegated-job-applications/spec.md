# Especificación — búsqueda y preparación delegada de candidaturas

> **Status**: `pending`
> **Depends on**: [`job-opportunities-workspace`](../job-opportunities-workspace/spec.md), [`ai-cv-generation-and-tailoring`](../ai-cv-generation-and-tailoring/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md)
> **Blocks**: nothing
> **Reality check**: BuilderHunt no tiene dominio candidate-side de candidaturas. El kanban y ATS
> existentes/propuestos son employer-side y no deben mezclarse. El browser extension plan solo
> muestra información en GitHub; podría evolucionar como asistente de formularios, pero no es un
> prerequisito del MVP. No hay autorización para enviar formularios externos automáticamente.

## Problema

Una persona puede tener decenas de ofertas, pero compararlas, decidir cuáles merecen tiempo, adaptar
materiales y completar formularios consume horas. Delegar todo sin controles produciría spam,
errores factuales, respuestas sensibles inventadas y envíos externos irreversibles.

## Objetivo

Crear un agente de carrera que pueda, dentro de un mandato explícito:

- buscar/importar ofertas permitidas;
- filtrar requisitos incompatibles;
- puntuar fit con evidencia;
- priorizar oportunidades;
- generar el CV específico y un application kit;
- preparar respuestas de formulario;
- presentar una cola de revisión;
- registrar candidaturas que el usuario confirma y envía.

## Nivel de autonomía aprobado para MVP

El sistema automatiza discovery, scoring, preparación y prefill, pero **cada candidatura requiere
confirmación humana antes del envío externo**.

El MVP no pulsa el botón final en nombre del usuario. Una extensión futura puede rellenar campos
después de una acción explícita, pero:

- muestra todos los valores;
- deja preguntas desconocidas sin responder;
- nunca evita CAPTCHA/login;
- el usuario realiza el submit final en el portal.

La delegación automática por lote queda como fase futura que exigiría nuevo consentimiento,
política, source-specific authorization, incident controls y aprobación del producto.

## Mandato de búsqueda

`application_mandates` define:

- roles/títulos objetivo;
- skills/intereses;
- localizaciones y remote policy;
- salary floor/currency;
- employment types;
- seniority;
- sponsorship/work authorization **confirmado**;
- idiomas;
- industrias/empresas incluidas/excluidas;
- fuentes permitidas;
- máximo de nuevas ofertas/día;
- máximo de kits/día;
- fecha de expiración;
- auto-actions permitidas (`discover`, `score`, `prepare`; nunca `submit` en MVP).

El mandato es versionado, revocable y deny-by-default. Cambios no afectan runs históricos.

## Pipeline

```text
mandate
  → discover/import jobs
  → normalize/dedupe/freshness
  → deterministic hard filters
  → evidence-based fit score
  → shortlist/review
  → tailored resume + optional cover letter + answer draft
  → user approval
  → user submits externally
  → confirmation/status tracking
```

## Matching

### Hard filters deterministas

- empleo/location/remote incompatible;
- salario por debajo del mínimo cuando está publicado;
- sponsorship requerido/incompatible solo si ambos lados son conocidos;
- oferta expired/closed;
- empresa excluida;
- duplicado/already applied;
- requisito legal explícito no cumplido.

Unknown no equivale a fail.

### Fit analysis

Task `candidate-job-fit`:

- compara career facts confirmed con job version;
- devuelve requirement-by-requirement evidence;
- categorías `meets | partial | missing | unknown`;
- score 0–100 derivado por fórmula versionada sobre la salida estructurada;
- nunca usa edad, género, raza, discapacidad, religión, orientación, foto u otras características
  protegidas;
- nunca modifica hard filters;
- muestra razones y gaps.

El usuario puede ajustar pesos, pero no ocultar gaps factuales.

## Application kit

Por oportunidad:

- snapshot de oferta;
- score y evidencia;
- variante de CV aprobable;
- cover letter opcional, truth-linked;
- respuestas propuestas a preguntas conocidas;
- lista de preguntas que requieren usuario;
- checklist del portal;
- source URL y deadline;
- coste y provenance.

El kit puede generarse en batch, pero cada item se aprueba individualmente.

## Banco de respuestas

`application_answer_facts` guarda respuestas confirmadas:

- contacto;
- links;
- work authorization;
- sponsorship;
- salary expectations;
- notice period/start date;
- travel/relocation;
- respuestas personalizadas.

Reglas:

- PII/answers son owner-only;
- no inferir;
- fecha de confirmación y expiry;
- preguntas sensibles/voluntarias (demografía, discapacidad, veteran status, salud, antecedentes)
  nunca se autorellenan;
- respuestas legales o de declaración se muestran para confirmación cada vez;
- no generar aceptación de términos.

## Modelo de datos

Tenant-private + individual owner:

### `application_mandates`

Reglas versionadas, status `draft | active | paused | expired | revoked`.

### `application_runs`

Mandate version, trigger, status, counters, lease, costes y timestamps.

### `application_candidates`

Run + job/version, hard-filter result, fit analysis/version, rank y disposition.

### `job_applications`

- owner/org/job/job-version;
- status:
  `discovered | shortlisted | preparing | needs_review | approved | ready_to_submit |
   submitted_by_user | confirmed_submitted | rejected | withdrawn | failed | archived`;
- resume version;
- submitted URL/time/source confirmation;
- external reference opcional;
- timestamps.

### `application_kits`

Versiones inmutables del CV/letter/answers/checklist con provenance.

### `application_answer_facts`

Respuesta confirmada, categoría, sensitivity, valid-from/until y source.

### `application_events`

Append-only audit de transiciones y acciones; payload minimizado.

## Ingestión externa

Discovery usa:

1. ofertas ya guardadas;
2. APIs oficiales configuradas;
3. feeds públicos autorizados;
4. URLs proporcionadas por el usuario.

No existe crawler abierto. Cada fuente entra al source registry y al workspace de ofertas. Las
credenciales externas, si llegan en fases futuras, se cifran y aíslan según el patrón ATS.

## Background y scheduling

- run manual o schedule máximo diario;
- HTTP worker idempotente con leases;
- cada tenant/user batch en su propio contexto;
- budgets y límites antes de discovery/AI;
- pause/revoke detiene nuevos items;
- un item ya enviado por el usuario nunca se reenvía;
- dedupe global por owner + opportunity/source.

## Confirmación y envío

MVP:

- “Open application” abre source URL segura;
- copy/download kit;
- extensión opcional puede prefill tras click;
- usuario revisa y pulsa submit;
- vuelve y marca submitted, opcionalmente aportando reference/confirmation;
- email scraping o mailbox access no se incluye.

El estado `confirmed_submitted` requiere evidencia explícita del portal o integración oficial; una
marca manual usa `submitted_by_user`.

## Cover letters

Task opcional `application-cover-letter`:

- hechos confirmed y job evidence;
- no adulación o afirmaciones sobre cultura sin evidencia;
- editable;
- desactivable por mandato;
- no generar si la oferta no la pide y el usuario prefiere omitirla.

## Prevención de spam y daño

- caps diarios bajos por defecto;
- no aplicar dos veces;
- company/domain exclusions;
- quality threshold configurable;
- stale job recheck antes de preparar;
- approval individual;
- withdrawal y audit;
- no manipulación de diversidad/self-ID;
- no ocultar uso de IA cuando el formulario lo pregunte;
- no responder pruebas técnicas, assessments o preguntas que deban ser trabajo del candidato.

## Billing y coste

- discovery/import se factura según su plan;
- scoring batch server-side y tailoring usan créditos;
- deterministic hard-filter evita llamadas innecesarias;
- fit cache por career-profile-version + job-version;
- el usuario ve coste máximo por run y por kit;
- reserva por run y settlement por trabajo real;
- cancel/failure libera sobrante.

Estimación inicial: 1 fit call por job que pasa hard filters; 2–3 calls adicionales por kit
(tailor, optional letter, answer mapping). Un run de 50 ofertas puede reducirse a 10 kits mediante
hard filters/threshold. Phase 0 debe validar coste y default caps.

## UX

Nueva área `/career/applications`:

- mandate wizard;
- inbox de ofertas calificadas;
- explainable fit;
- filters y exclusions;
- run progress;
- application kanban personal;
- kit review con diff y unresolved questions;
- approval/open portal;
- status/timeline;
- pause/revoke/delete/export.

## Privacidad y seguridad

- owner-only además de tenant RLS;
- career data y job descriptions como untrusted provider input;
- no enviar contact/sensitive answers al LLM salvo necesidad;
- answer bank cifrado/controlado;
- CSRF en mutations;
- open redirects/source URLs validados;
- logs sin CV, answers, email o URLs tokenizadas;
- account export/delete y retention;
- portal credentials nunca almacenadas en MVP.

## Métricas

- jobs discovered → passed hard filters → scored → shortlisted;
- kits prepared/reviewed/approved;
- portal opens;
- submitted_by_user vs confirmed_submitted;
- duplicate/stale prevented;
- unresolved question rate;
- user edits before approval;
- cost and latency per run/kit;
- interview outcome solo si el usuario lo registra voluntariamente;
- quality/complaint/incorrect-answer incidents.

## No objetivos

- auto-submit server-side;
- CAPTCHA solving;
- credential sharing/storage;
- aplicar sin aprobación;
- responder assessments;
- fabricar facts;
- inferir protected/sensitive answers;
- leer email;
- employer-side ATS pipeline;
- guarantee interviews/jobs.

## Criterios de aceptación

- mandate revocable limita exactamente acciones/volumen/fuentes;
- hard filters son explicables y unknown no rechaza silenciosamente;
- scores citan facts y job requirements;
- cada kit usa una versión fija de CV/oferta;
- ningún submit externo ocurre desde servidor;
- preguntas sensibles quedan vacías;
- duplicado/already-applied bloquea;
- pause/cancel/retry/billing convergen;
- user/org A/B, audit, export/delete y source policy pasan release gates.

