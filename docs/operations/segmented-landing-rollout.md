# Rollout de la landing segmentada

Plan: [`plans/phase-2/06-landing-segmentada`](../../plans/phase-2/06-landing-segmentada/spec.md).
Contenido y reglas de copy: [`docs/marketing/phase-3-segment-message-matrix.es.md`](../marketing/phase-3-segment-message-matrix.es.md).

## El interruptor

`SEGMENTED_LANDING_ENABLED` — `false` por defecto.

| Estado | Qué ve el mundo |
|---|---|
| `false` | `/for/hiring-teams`, `/for/investors` y `/for/builders` **responden 404**. El selector no se renderiza en la home. El sitemap no las lista. |
| `true` | Las tres páginas existen, el selector aparece en su banda bajo el hero, y el sitemap las incluye. |

**404 y no otra cosa.** Un 200 con el contenido escondido es una URL pública apagada que se indexa
igual; un redirect a `/` le dice a un crawler que la página se mudó permanentemente a un sitio al que
no se mudó. La única respuesta cierta es que no existe.

Las tres superficies leen la misma bandera, y ahí está el riesgo real: **tres sitios que pueden
discrepar sobre si una página existe**, y la discrepancia es invisible hasta que alguien sigue una
entrada del sitemap hasta un 404. `tests/e2e/segmented-landing-flag.spec.ts` las comprueba las tres
en la misma corrida, contra un servidor cuyo entorno controla el harness.

### Por qué la bandera se resuelve en el servidor

`env.ts` le entrega al navegador un stub, y toda bandera que no esté explícitamente ahí se lee como
su default de zod. Una ruta que leyera `env.SEGMENTED_LANDING_ENABLED` directamente serviría la
página en un refresco y la 404-aría en un clic, con el mismo deploy y la bandera encendida todo el
rato. Por eso existe `src/shared/lib/segmented-landing-flag.ts`: un `createServerFn` que solo llaman
las cuatro rutas que lo necesitan — la home, por el selector, y las tres páginas, por su propia
existencia. El sitemap lee `env` directo porque su handler solo corre en el servidor.

## Encenderlo

```bash
SEGMENTED_LANDING_ENABLED=true
```

Es una variable de entorno, no una migración: encender y apagar es un reinicio del proceso, no un
deploy con esquema. `env` se congela al cargar el módulo, así que editar `.env` no hace nada hasta
que el proceso reinicia.

Antes de encenderlo en producción, comprobar que `pnpm sources:probe` no ha dejado el recuento de
fuentes desfasado: la copy de las tres páginas interpola `SEARCH_SOURCE_COUNT`, así que el número se
corrige solo, pero una fuente muerta y todavía registrada hace que la promesa cuente algo que no
responde.

## El embudo

Eventos nuevos, en el mismo stream first-party y bajo las mismas reglas — sin PII, sin texto libre,
sin SDK de terceros. Contrato en
[`conversion-events.ts`](../../src/shared/lib/conversion-events.ts).

| Evento | Surface | Qué responde |
|---|---|---|
| `segment_page_viewed` | `segment_page` | cuánta gente llega a cada página |
| `segment_selector_click` | `hero`, `segment_page` | quién elige desde la home (llegó sin decidir) y quién desde una página (aterrizó en la equivocada) |
| `segment_page_cta_click` | `segment_page` | cuántos de los que leen pulsan el CTA de esa página |
| `signup_submit` / `signup_complete` | `signup` | ya existían; es donde el embudo de landing se junta con el de alta |
| `segment_selected` | `onboarding` | ya existía; la primera vez que un segmento **se guarda** |
| `activation_reached` | `onboarding` | ya existía; primer valor real |

Los tres nuevos llevan el mismo `segment` context que los eventos de elección y **significan otra
cosa**: `next` es de qué página iba esto, nunca una preferencia guardada, y `source` es siempre
`landing`. Por eso el contrato mantiene las dos listas separadas — `SEGMENT_CHOICE_EVENTS` y
`SEGMENT_LANDING_EVENTS`. Un análisis que contara una vista de página como una elección reportaría un
segmento para cada visitante que leyó una página y no eligió nada.

### First-touch y last-touch

**No hay campo de atribución, a propósito.** Cada evento lleva `sessionId` — un UUID aleatorio en
`sessionStorage`, nunca la cookie de sesión ni nada derivado de un valor identificador — y eso basta
para las dos lecturas:

- **first-touch**: el `segment_page_viewed` más antiguo de una `sessionId`;
- **last-touch**: el último antes de su `signup_complete`.

Derivarlas en la consulta en vez de guardarlas es lo que impide que se contradigan. Un par de campos
`firstTouch` / `lastTouch` escritos por el cliente serían dos afirmaciones sobre el pasado hechas por
la única parte que no puede verlo entero, y la primera visita las escribiría iguales para siempre.

### Lo que el embudo todavía no dice

**Nada conecta una `sessionId` anónima con la cuenta que crea.** `signup_complete` cierra la sesión
del embudo y el `segment_selected` del onboarding empieza otra historia; unirlas requiere una
decisión de privacidad que este plan no toma. Hasta entonces, la pregunta "¿qué porcentaje de quien
leyó `/for/investors` acabó activando?" **no tiene respuesta en estos datos** — se pueden leer los
dos tramos por separado y no el arco entero.

No subir esto de rango sobre la promesa de medirlo después. Es exactamente lo que
[`personalized-dashboard-rollout.md`](./personalized-dashboard-rollout.md) advierte sobre los presets.

## Apagarlo

Poner `SEGMENTED_LANDING_ENABLED=false` y reiniciar. No hay datos que revertir: las páginas no
escriben nada, el hint nunca se persiste, y los eventos de conversión ya emitidos siguen siendo
válidos y describen un periodo en el que la feature estaba encendida.

Lo que sí sobrevive: los enlaces ya compartidos a `/for/*` empiezan a dar 404, y un buscador que ya
las indexó tardará en soltarlas. Si están indexadas, apagar es una decisión con cola — no es
reversible en el sentido en que lo es una bandera interna.
