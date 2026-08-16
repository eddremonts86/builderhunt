# Message matrix por segmento

Lo que la landing puede decirle a cada segmento, y lo que no. Plan:
[`plans/phase-2/06-landing-segmentada`](../../plans/phase-2/06-landing-segmentada/spec.md).
La taxonomía es la de
[`user-segments.ts`](../../src/shared/lib/user-segments.ts): `hiring`, `investing`, `building`,
`other`.

## La regla

**Cada promesa enlaza a una feature que existe hoy, o se borra.**

No "está en el roadmap", no "próximamente", no una versión suavizada de algo que el producto no
hace. Una landing es la única superficie donde una afirmación falsa no la corrige nadie: no hay
estado vacío que la matice ni endpoint que la refute, y la persona que la creyó ya se registró.

La columna *Evidencia* de cada tabla es el fichero o la ruta que sostiene la promesa. Si no hay
fichero, no hay promesa. `tests/unit/modules/landing/content/segment-pages.test.ts` es lo que
mantiene esto honesto cuando el contenido se convierta en configuración tipada: cada claim lleva su
`evidence` y el test falla si alguno se queda sin ella.

## Lo que el producto hace de verdad, hoy

Escrito antes que las promesas, a propósito. Es la lista contra la que se valida todo lo demás.

| Capacidad | Dónde vive | Límite honesto |
|---|---|---|
| Búsqueda federada sobre 13 fuentes | `search-connectors.ts` | El número lo decide el registro, no la copy — nueve superficies dijeron "12 fuentes" durante días después de retirar dos |
| Puntuación por actividad reciente | `/api/search/builders` | Ordena por señal de actividad, no predice disponibilidad |
| Búsquedas guardadas que siguen corriendo | `/api/queries`, `feed_capabilities` | Tope por plan (`PLAN_LIMITS`) |
| Alertas por email o dashboard | `/api/alerts` | **De pago.** 402 sin `paidActionsAllowed` |
| Sourcing sprints | `/api/sprints` | Tope por plan (`SOURCING_SPRINT_LIMITS`) |
| Seguimiento de builders y shortlists | `/api/builders/track`, `/api/lists` | — |
| Claim de perfil con prueba pública | `/api/builders/$id/claim` | Solo GitHub, GitLab, Codeberg y DEV — el resto no tiene bio pública verificable |
| Portfolio publicable | `/api/me/builder-claims/$id/portfolio` | Requiere claim verificado |
| Entrevistas y calendario | `/api/interviews`, `/api/calendar` | — |
| Exports | `/api/export` | — |
| Recomendaciones | `/api/recommendations` | Derivadas de lo que ya sigues |

## Hiring

| | |
|---|---|
| **JTBD** | "Necesito encontrar gente que de verdad esté construyendo con mi stack, y no tengo forma de saber quién está activo ahora." |
| **Problema** | Los perfiles profesionales describen a quien los escribió hace dos años. Lo que la gente envía esta semana está en otro sitio. |
| **Promesa** | Encuentra personas por lo que han enviado, no por lo que dice su perfil. |
| **Evidencia** | 13 fuentes en `search-connectors.ts`; puntuación por actividad reciente en `/api/search/builders`; shortlists en `/api/lists` |
| **Objeción** | *"¿Otro sourcing tool que raspa LinkedIn?"* → No tocamos LinkedIn. Las fuentes son públicas y están listadas; las plataformas que lo prohíben no están conectadas |
| **CTA** | Buscar builders → `/search` |

### Prohibido decir

- **"Candidatos disponibles" o "abiertos a ofertas"** salvo que la persona lo haya puesto en su
  propio perfil reclamado (`openToStatus`). Actividad reciente no es disponibilidad, y presentarla
  como tal convierte una señal técnica en una afirmación sobre la vida de alguien.
- **"Contacto verificado"** o cualquier promesa de email. El producto no vende datos de contacto.
- **Un número de candidatos, de matches o de contrataciones.** No hay ninguna medición que lo
  sostenga.
- **"IA que encuentra al candidato perfecto".** Hay embeddings y búsqueda semántica; no hay un
  modelo que juzgue idoneidad, y decir lo contrario es exactamente la promesa que el producto no
  puede cumplir.

## Investing

| | |
|---|---|
| **JTBD** | "Quiero enterarme de qué se está construyendo en un espacio antes de que sea evidente." |
| **Problema** | Para cuando algo aparece en las listas, ya lo han visto todos. |
| **Promesa** | Guarda una tesis como búsqueda y entérate de lo que encuentra, sin volver a mirar. |
| **Evidencia** | Búsquedas guardadas en `/api/queries`; alertas en `/api/alerts`; enlace de feed privado vía `feed_capabilities` para plan gratuito |
| **Objeción** | *"¿Esto es una base de datos de startups?"* → No. Rastrea personas y lo que envían |
| **CTA** | Guardar una búsqueda → `/search` |

### Prohibido decir

- **"Deal flow".** El producto no modela compañías, rondas, cap tables ni relaciones de inversión, y
  el spec de la fase lo prohíbe por nombre hasta que las modele. Está asertado en un test unitario y
  en un e2e.
- **"Detecta la próxima ronda" / "señales de financiación".** No hay ninguna fuente de financiación
  conectada.
- **"Alertas en tiempo real"** sin decir que las alertas por email son de pago. Una cuenta nueva está
  en `free` y recibe 402: la promesa gratuita honesta es el enlace de feed, no el email.
- **Cualquier cifra de retorno, de acierto o de "startups descubiertas".**

## Building

| | |
|---|---|
| **JTBD** | "Quiero que lo que construyo sea encontrable por las personas correctas, sin tener que venderme." |
| **Problema** | Tu trabajo está repartido en cinco plataformas y ninguna lo junta. |
| **Promesa** | Reclama el perfil que ya hemos indexado y decide tú qué dice. |
| **Evidencia** | Claim con prueba pública en `/api/builders/$id/claim`; portfolio publicable; `openToStatus` y temas en `/me` |
| **Objeción** | *"¿Tenéis mis datos sin que yo lo sepa?"* → Sí, de actividad pública, y por eso existe el claim y también la retirada de perfil (`PROFILE_REMOVAL_ENABLED`) |
| **CTA** | Encontrar mi perfil → `/onboarding/building` |

### Prohibido decir

- **"Consigue ofertas" / "te contactarán recruiters" / "aumenta tu visibilidad".** El spec lo prohíbe
  con estas palabras: *no fabricar visitas ni oportunidades*. El producto no genera ninguna de las
  dos, y una landing que las prometa está vendiendo el comportamiento de terceros.
- **Cualquier número de visitas al perfil** salvo que venga de `profile-view-analytics`, y entonces
  es un dato de esa cuenta y no una promesa de landing.
- **"Verificado" a secas.** El claim verifica que controlas *esa cuenta externa*, no tu identidad,
  ni tu experiencia, ni nada que hayas afirmado.
- **Sugerir que reclamar mejora el ranking.** No lo hace.

## Other, y quien no elige

Sin página propia. Es la home tal cual, que es exactamente lo que el resto del producto hace con
`other` — la experiencia general, no una cuarta variante.

Una landing segmentada que obligara a elegir antes de enseñar nada convertiría una pregunta opcional
en un peaje. El selector propone; la home sigue respondiendo sola.

## Afirmaciones prohibidas en todos los segmentos

- **Números sin fuente.** Usuarios, contrataciones, empresas, precisión. No hay ninguno medido, y una
  cifra inventada en una landing es la clase de afirmación que nadie corrige después.
- **Logos de clientes o testimonios** que no existan.
- **Comparativas nominales con competidores.**
- **"Cumple con el RGPD"** como eslogan. Hay una política de privacidad y un flujo de retirada de
  perfil; el cumplimiento es un estado legal, no una feature.
- **Un recuento de fuentes escrito a mano.** Lee `SEARCH_SOURCE_COUNT`. Nueve superficies dijeron
  "12 fuentes" después de que el número cambiara, y por eso el registro es quien lo decide.

## Cómo se revisa un claim nuevo

1. Nómbrame el fichero o la ruta que lo sostiene. Si no lo hay, no entra.
2. Comprueba si describe algo que hace el producto o algo que hace un tercero. Lo segundo nunca
   entra.
3. Comprueba si sobrevive a una cuenta gratuita y vacía. Una promesa que solo es cierta con datos y
   con plan de pago es una promesa condicionada, y la condición va escrita.
