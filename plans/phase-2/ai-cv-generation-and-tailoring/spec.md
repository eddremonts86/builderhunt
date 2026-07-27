# Especificación — generación y adaptación de CV con IA

> **Status**: `pending`
> **Depends on**: [`job-opportunities-workspace`](../job-opportunities-workspace/spec.md), [`ai-expansion`](../../phase-1/ai-expansion/spec.md), [`calendar-scheduling-interview-intelligence`](../../phase-1/calendar-scheduling-interview-intelligence/spec.md)
> **Blocks**: [`delegated-job-applications`](../delegated-job-applications/spec.md)
> **Reality check**: BuilderHunt tiene plataforma de IA, billing por créditos, perfiles reclamables
> y un plan de almacenamiento/extracción segura de PDF/DOCX/TXT para documentos de candidatos.
> No existe un perfil profesional canónico, editor de CV, renderer PDF/DOCX, comparación
> CV↔oferta, variantes ni procesamiento batch. `portfolio-builder` publica evidencia de un builder,
> pero no sustituye un CV privado orientado a una candidatura.

## Problema

Una persona puede describir su experiencia de forma desordenada o aportar un CV existente. Convertir
eso en un CV claro requiere estructurar hechos, seleccionar evidencia y presentar la información.
Adaptarlo a una oferta requiere priorizar lo relevante sin inventar experiencia. Repetirlo para 15
ofertas manualmente es lento y propenso a inconsistencias.

## Objetivo

Permitir que una persona:

- cree un perfil profesional canónico desde lenguaje natural o documentos;
- revise y confirme cada hecho;
- genere un CV base;
- compare su perfil/CV con una oferta;
- genere una variante específica y explicable;
- procese hasta 15+ ofertas como un lote cancelable;
- exporte PDF, DOCX y texto ATS-friendly;
- mantenga trazabilidad entre hechos, oferta, generación y documento final.

## Principio central: truth-first

La IA puede seleccionar, resumir, ordenar y reescribir. No puede:

- inventar empleadores, fechas, títulos, métricas, tecnologías, educación o certificaciones;
- aumentar años de experiencia;
- convertir exposición en dominio;
- ocultar gaps mediante fechas falsas;
- añadir keywords sin evidencia;
- afirmar autorización laboral, ubicación o disponibilidad no confirmadas.

Cada afirmación generada debe enlazar a uno o más hechos confirmados. Una frase sin soporte bloquea
la exportación hasta ser eliminada o confirmada explícitamente por el usuario como un nuevo hecho.

## Modelo mental

```text
inputs → extracted candidate facts → user confirmation → canonical career profile
                                                     ↓
job opportunity version → relevance analysis → tailored resume variant → render/export
```

El perfil canónico es la fuente de verdad; el CV importado no se sobrescribe y cada variante es una
versión derivada.

## Inputs

### Lenguaje natural

Wizard conversacional/formulario:

- identidad profesional y headline;
- experiencia, responsabilidades y logros;
- proyectos, open source y portfolio;
- skills con nivel/evidencia opcional;
- educación/certificaciones;
- idiomas;
- preferencias de formato.

La conversación produce propuestas de hechos, nunca los confirma automáticamente.

### CV existente

- PDF, DOCX y TXT en MVP;
- upload directo a storage privado mediante signed URL;
- antivirus/quarantine;
- extracción determinista con páginas/secciones;
- IA estructura el texto extraído;
- documento original permanece inmutable y descargable;
- OCR de imágenes/scans es una fase posterior salvo que el foundation ya lo soporte.

### Perfil BuilderHunt

El usuario puede importar proyectos/evidencia de su perfil reclamado. Solo campos públicos
seleccionados y confirmados entran en el CV; el sistema no copia scoring interno ni datos de terceros.

## Modelo de datos

Todos los recursos son tenant-private + `owner_user_id`, igual que el workspace de ofertas.

### `career_profiles`

- identidad profesional y preferencias;
- locale/timezone;
- schema version;
- status y timestamps.

### `career_facts`

- tipo: employment, project, education, certification, skill, language, achievement;
- datos estructurados;
- source/evidence reference;
- `proposed | confirmed | rejected | superseded`;
- sensitivity y timestamps.

### `resume_documents`

- storage key, checksum, media type, scan/extraction status;
- original filename sanitizado;
- retention y deletion state.

### `resume_templates`

Built-ins versionados. Custom templates quedan fuera del MVP.

### `resume_versions`

- `base | tailored`;
- profile version;
- template/version;
- locale;
- structured resume JSON;
- parent version;
- job opportunity/version nullable;
- render status y immutable content hash.

### `resume_generation_runs`

- task/mode/status;
- input fingerprints;
- model/prompt/schema versions;
- token/credit counters;
- error codes;
- created/finished timestamps.

### `resume_batch_runs` y `resume_batch_items`

- lista ordenada de job opportunity/version;
- progress/counters;
- result resume version;
- per-item error/retry;
- reservation y cancel state.

### `career_processing_consents`

- subject user, organization y notice version;
- purpose (`document_storage`, `document_extraction`, `external_ai_processing`);
- provider disclosure version;
- affirmative decision, timestamp y withdrawal;
- append-only evidence para cada cambio.

Subir un archivo no implica consentimiento indefinido para procesarlo con proveedores externos.
Antes de la primera extracción/generación se muestra qué datos salen del dispositivo, para qué
propósito, retención y cómo retirar futuras ejecuciones.

## Contrato de CV estructurado

El renderer consume un DTO versionado, no texto libre:

- header/contact;
- summary;
- work experience;
- projects;
- education;
- certifications;
- skills;
- languages;
- optional links.

Cada bullet incluye `factIds[]`. El contacto se minimiza y nunca se envía a IA si no es necesario.

## Tasks de IA

### `career-facts-extract`

- server-only, persistido;
- extrae hechos propuestos con evidence spans;
- no genera CV.

### `resume-base-compose`

- server-only;
- usa únicamente hechos confirmed;
- produce DTO estructurado con `factIds`;
- sin cache cross-user; tenant/profile fingerprint.

### `resume-job-fit-analyze`

- server-only;
- compara profile facts con una versión de oferta;
- salida: matched, partial, missing, unknown, priority y evidence;
- missing nunca se convierte en claim.

### `resume-tailor`

- server-only;
- reorganiza/reescribe un CV base para una oferta;
- cada frase mantiene provenance;
- no cambia hechos.

### `resume-quality-review`

- preferentemente determinista + server AI opcional;
- valida consistencia, longitud, repetición, fechas, unsupported claims y ATS hygiene;
- no produce un “ATS score garantizado”.

Todas usan Zod estricto, un repair retry, prompt injection defense y kill switch.

## Adaptación a oferta

La pantalla muestra:

- requisitos detectados;
- evidencia compatible;
- gaps reales;
- secciones/bullets promovidos o reducidos;
- keywords usadas con fact support;
- diff respecto al CV base;
- advertencias;
- razones para cada cambio.

El usuario puede editar y bloquear secciones antes de generar. Ediciones manuales que crean hechos
nuevos pasan por confirmación y quedan diferenciadas de sugerencias IA.

## Batch de 15 ofertas

1. seleccionar hasta el límite del plan;
2. fijar CV base, template, idioma y reglas;
3. congelar versiones de ofertas;
4. preflight de disponibilidad, duplicados y coste máximo;
5. reservar créditos;
6. ejecutar con concurrencia limitada;
7. permitir cancelación;
8. mostrar éxito parcial;
9. revisar cada variante individualmente;
10. exportar ZIP solo con documentos aprobados.

Dos URLs que resuelven a la misma oferta no generan dos CVs. Un cambio de la oferta no modifica una
variante ya generada; se ofrece regenerar contra la nueva versión.

## Rendering

- HTML interno sanitizado desde DTO;
- PDF determinista server-side;
- DOCX con estilos reales, no HTML renombrado;
- TXT ATS-friendly;
- fuentes embebidas/licencia compatible;
- enlaces seguros;
- nombres de archivo sanitizados;
- snapshots visuales por template.

No se promete compatibilidad con todos los ATS. Se garantiza estructura simple, texto seleccionable,
headings convencionales y ausencia de tablas/columnas en el template ATS.

## UX

Nueva área `/career/resumes`:

- perfil profesional y completeness;
- facts inbox para confirmar/rechazar;
- documentos originales;
- CV base editor/preview;
- selector de template/locale;
- tailoring desde una oferta;
- batch progress;
- versiones, compare, restore y export;
- delete/export privacy controls.

## Privacidad

CVs contienen PII de alto riesgo:

- cifrado/controles del storage foundation;
- signed URLs cortas y nunca públicas;
- content/security scan;
- provider input minimizado;
- no usar para entrenamiento;
- no exponer a org admins;
- consentimiento/transparencia versionados antes de procesamiento externo;
- retirar consentimiento detiene nuevas ejecuciones pero no falsea el historial de documentos ya
  exportados por el usuario;
- account export/delete y retention;
- logs solo hashes/IDs/tokens, nunca contenido;
- contacto se añade en render después de la generación cuando sea posible.

## Coste

Este workflow es server-only porque produce artefactos persistidos y batch/background.

Estimación inicial a validar:

- ingestión: 1 llamada, 4k–12k input + 1k–3k output;
- CV base: 1 llamada, 4k–10k input + 1.5k output;
- por oferta: fit + tailor, 2 llamadas, 5k–12k input total + 2k–4k output;
- lote de 15: hasta 32 llamadas incluyendo base, antes de retries.

El preflight muestra créditos máximos; billing reserva máximo y liquida uso real. Cachear fit por
profile/job fingerprint reduce regeneraciones; drafts creativos no se reutilizan entre usuarios.

## Calidad y evaluación

Dataset sanitizado con:

- CVs cortos/largos, distintos idiomas y formatos;
- ofertas simples/ambiguas/adversariales;
- hechos contradictorios;
- métricas y fechas;
- 15-job batches.

Gates:

- unsupported claim rate = 0 en corpus release;
- fact citation coverage = 100%;
- parse/render success;
- date/numeric fidelity;
- human usefulness review;
- PDF/DOCX/TXT round-trip;
- latency/cost p50/p95.

## No objetivos

- inventar o “mejorar” credenciales;
- aplicar automáticamente;
- cartas de recomendación falsas;
- headshots;
- ATS ranking universal;
- OCR avanzado en MVP;
- marketplace público de CVs;
- compartir CVs con employers sin acción explícita;
- optimizar por características protegidas.

## Métricas

- perfil completado y facts confirmados;
- tiempo hasta primer CV base;
- variantes creadas/aprobadas/exportadas;
- batch success/cancel/retry;
- edits por sección y unsupported-claim blocks;
- coste/latencia;
- oferta → variante → candidatura;
- delete/export completion.

## Criterios de aceptación

- natural language y documento crean facts propuestos, nunca confirmados silenciosamente;
- todo bullet exportado tiene facts confirmed;
- una oferta no puede introducir una credencial inexistente;
- 15 ofertas producen variantes independientes con partial success;
- cambiar/eliminar un profile fact invalida o marca stale las variantes afectadas;
- PDF/DOCX/TXT son legibles y ATS-friendly;
- aislamiento usuario A/B, provider minimization, delete/export y billing pasan gates.
