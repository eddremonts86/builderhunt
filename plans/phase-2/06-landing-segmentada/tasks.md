# Tareas — landing segmentada

> **Status**: `pending`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md) — la dependencia de
> `01-investigacion-icp` se levantó el 2026-08-05 (sus entrevistas están en phase-5). El message matrix se
> escribe contra la taxonomía documentada; cada claim sigue obligado a enlazar a un feature real o a
> eliminarse, que es la verificación que de verdad protege la landing.
> **Blocks**: nothing
> **Reality check**: `HomePage.tsx`, sitemap y layouts públicos ya existen.

- [x] **Crear message matrix aprobada**
  - Files: `docs/marketing/phase-3-segment-message-matrix.es.md`
  - Do: JTBD, problema, promesa, evidencia, objeción, CTA y afirmaciones prohibidas por segmento.
  - Verify: cada claim enlaza a feature real o se elimina.
  - Result: [`docs/marketing/phase-3-segment-message-matrix.es.md`](../../../docs/marketing/phase-3-segment-message-matrix.es.md).
    Empieza por una tabla de lo que el producto hace **hoy**, a propósito: es la lista contra la que
    se valida todo lo demás, y escribir las promesas primero es cómo se cuela una que nadie sostiene.
  - La regla es una: **cada promesa enlaza a una feature que existe, o se borra.** Una landing es la
    única superficie donde una afirmación falsa no la corrige nadie — no hay estado vacío que la
    matice ni endpoint que la refute, y quien la creyó ya se registró.

- [x] **Crear configuración tipada de contenido**
  - Files: `src/modules/landing/content/segment-pages.ts`, `tests/unit/modules/landing/content/segment-pages.test.ts`
  - Do: contenido exhaustivo sobre `UserSegment` y metadata.
  - Verify: tests de segmentos, links, CTA y claims obligatorios.
  - Result: `src/modules/landing/content/segment-pages.ts` y 18 tests. Un `Claim` **no se puede
    escribir sin `evidence`**, una ruta a un fichero que lo sostiene: el compilador la pide y el test
    la abre con `existsSync`.
  - `FORBIDDEN_LANDING_CLAIMS` no es un filtro de marketing: cada entrada está porque un spec la
    prohíbe por su nombre — "deal flow" hasta que el producto modele inversión, visitas u
    oportunidades fabricadas para builders, disponibilidad inferida de la actividad.
  - **Su primera corrida marcó el propio descargo de la página investing** — "nothing here detects a
    round" — como violación. El escáner cubre lo que una página *promete*, no lo que *admite*:
    entrenar a alguien a borrar un descargo para poner un test en verde es exactamente al revés.
  - El recuento de fuentes se interpola desde `SEARCH_SOURCE_COUNT`. Nueve superficies dijeron "12
    fuentes" durante días tras retirar dos conectores, y todas eran un literal escrito a mano.

- [x] **Crear componentes compartidos**
  - Files: `src/modules/landing/components/SegmentSelector.tsx`, `src/modules/landing/components/SegmentLandingPage.tsx`, `tests/unit/modules/landing/components/SegmentSelector.test.tsx`
  - Do: selector/tab accesible, secciones y CTA reutilizables.
  - Verify: keyboard, screen reader, no-JS y component tests.
  - Result: `SegmentSelector.tsx` y `SegmentLandingPage.tsx`. El selector son **enlaces, no tabs**:
    es lo que lo hace funcionar sin JavaScript, lo que hace las tres páginas rastreables y lo que
    hace que un clic con la rueda haga lo obvio. Un widget de tabs habría tenido que reimplementar
    las tres cosas y habría escondido dos tercios de la copy a cualquier crawler.
  - Es un `<nav>` con nombre accesible, no una lista de enlaces bajo un heading: quien llega con
    lector de pantalla necesita saber que esto es una salida de la página y no un índice de lo que
    está leyendo. La página actual se marca con `aria-current="page"` en vez de ofrecerse.
  - `limits` **se renderiza**, bajo los claims y al mismo tamaño. Un matiz archivado como nota de
    revisión es un matiz que el lector no ve, lo que deja la promesa como lo único que lee.
  - Verificado en `tests/e2e/segmented-landing.spec.ts`: teclado (foco + Enter navega), landmark con
    nombre, `aria-current`, y HTML servido sin sesión ni JavaScript. No hay component test aparte —
    el e2e prueba las mismas propiedades contra el HTML real en vez de contra un render en jsdom.

- [x] **Crear páginas públicas**
  - Files: `src/routes/_landing/for/hiring-teams.tsx`, `src/routes/_landing/for/investors.tsx`, `src/routes/_landing/for/builders.tsx`
  - Do: SSR, head/canonical/OG/structured data y contenido específico.
  - Verify: HTTP 200 SSR y screenshots mobile/desktop.
  - Result: las tres rutas, **estáticas y no `/for/$slug`**. El sitemap, el crawler y el router
    necesitan saber que esos tres paths existen, y un segmento dinámico que acepta exactamente tres
    valores parece abierto a todos ellos.
  - Verificado con `request.get` y no con una visita de navegador: lo que importa es lo que recibe un
    crawler, y un navegador hidrataría y taparía la diferencia entre una página servida y un
    cascarón. Cada claim y cada límite aparece en el HTML crudo, y ninguna de las tres comparte
    título con otra.
  - **No cubierto**: structured data (JSON-LD). Sí hay `<title>`, description y OG por página.

- [x] **Integrar selector en home**
  - Files: `src/modules/landing/components/HomePage.tsx`
  - Do: mantener mensaje principal y añadir selector/enlaces sin layout shift.
  - Verify: visual regression, reduced motion y Lighthouse.
  - Result: banda propia bajo el hero. **No dentro del hero**: ese documenta un tope de cuatro
    elementos de texto más un CTA primario y uno secundario (§4.7), y tres enlaces más lo rompían.
    Al tener banda propia nada de lo de arriba se mueve — la captura del fallo visual lo confirma:
    encabezado, copy y botones en la misma posición exacta.
  - Dos baselines regeneradas (landing desktop y mobile), y solo esas dos de las 44.
  - Encontrado por el navegador: edité primero `HeroGlass.tsx`, que **no lo importa nadie**. Es código
    muerto y el cambio quedó revertido; la home tiene su propio hero en `HomePage.tsx`.

- [x] **Preservar hint hasta onboarding**
  - Files: `src/shared/lib/landing-segment-hint.ts`, `src/modules/auth/components/SignUpPage.tsx`, `src/routes/onboarding/goal.tsx`
  - Do: validar, TTL, first-party storage y precedencia de preferencia persistida.
  - Verify: e2e landing → signup → goal y valores manipulados/expirados.
  - Result: `stashSegmentHint` / `consumeSegmentHint` en `landing-segment-hint.ts`. El hueco era el
    formulario: el CTA de la página de segmento llevaba `?goal=`, y **la query muere en `/auth/sign-up`**
    — otra página, otra URL. El hint espera en `sessionStorage` mientras alguien rellena el formulario.
  - `sessionStorage` y **no una cookie**: una cookie viaja al servidor en cada request, lo que convierte
    una preselección en algo que el backend puede leer y usar, y lo único que este valor no puede hacer
    nunca es entrar en una decisión. Tampoco `localStorage`, que sobreviviría a la visita y decidiría un
    onboarding empezado semanas después desde un enlace que nadie recuerda haber pulsado.
  - TTL de 30 minutos **escrito dentro del valor**, no delegado a lo que el navegador decida conservar.
    Una entrada sin `expiresAt` cuenta como caducada — es la forma obvia de intentar hacer una permanente.
  - **Un solo uso, y se borra antes de validarse.** Un hint que falla la validación es un hint que ya se
    ha visto; dejarlo ahí significaría reparsear la misma basura en cada pantalla posterior que pregunte.
  - Se revalida al leer: `sessionStorage` lo escribe cualquier cosa que corra en el origen, así que lo que
    sale de ahí no merece más confianza que lo que salía de la URL. Nueve formas forjadas cubiertas en
    unit tests, tres de ellas también en el navegador.
  - **Precedencia: elección guardada > URL > stash.** Lo guardado es algo que esta persona dijo; un hint
    es una suposición leída de una URL, y la URL es la mitad que controla otro. Lo peor que puede hacer
    un enlace fabricado es ofrecer un cambio que aún hay que confirmar con Continue. La preferencia llega
    por fetch, después del primer paint, y **solo pisa un formulario que nadie ha tocado**.
  - Verificado en `tests/e2e/onboarding-goal.spec.ts`: la cadena entera en navegador — página pública,
    formulario de alta real, y el paso de objetivo con la URL desnuda al otro lado — más caducado,
    forjado, un solo uso, y las dos reglas de precedencia. La cuenta nueva termina con `primary_segment`
    a `null`: sigue siendo solo una preselección.

- [x] **Actualizar descubrimiento SEO**
  - Files: `src/routes/sitemap[.]xml.ts`, `src/routes/robots[.]txt.ts`, `src/routes/__root.tsx`
  - Do: sitemap, crawling y structured data coherente.
  - Verify: parsear sitemap, canonical único y OG preview.
  - Result: las tres páginas en el sitemap, **generadas desde `SEGMENT_PAGES`** y no escritas a mano,
    así que una página añadida o renombrada no puede dejar el sitemap describiendo una URL que da 404
    — ni omitiendo una que existe y es el único sitio donde vive la copy de un segmento entero. Un
    e2e parsea el XML y exige exactamente una entrada por página.
  - `src/modules/landing/content/segment-page-head.ts`: un único constructor de `<head>` para las
    tres rutas. **Módulo aparte de `segment-pages.ts` a propósito** — ese es contenido y nada más, que
    es lo que permite a un spec de Playwright (un proceso Node sin `.env`) importarlo para comprobar
    la copy contra la que asierta. Este alcanza `site-url.ts` y por tanto `env.ts`.
  - Las tres rutas escribían `title` / `og:*` a mano y **se dejaban `twitter:*` fuera**, que es
    exactamente la deriva que `pageMeta` existe para evitar: una página correcta en la pestaña del
    navegador y en Google, y que en X previsualiza la home. Ahora sale todo del mismo sitio, lo que
    además impide que el JSON-LD describa una página distinta de la que describen los meta.
  - Structured data: `WebPage` + `BreadcrumbList`, enganchados por `@id` al `#website` y
    `#organization` que ya publica la raíz — la página se une a ese grafo en vez de declarar un
    segundo sitio y un segundo publisher propios.
  - **Sin `FAQPage`**, aunque cada página renderiza exactamente una pregunta con su respuesta. Ese
    tipo dice que la página *es* una lista de preguntas, y no lo es: la objeción es un bloque entre
    cinco. Marcarlo igualmente sería describir la página como algo que no es para optar a un rich
    result, que es el mismo movimiento que una promesa sin evidencia detrás. El e2e lo asierta sobre
    el texto de la pregunta, no sobre la ausencia del tipo — la raíz publica un `FAQPage` propio, de
    ámbito de producto.
  - Canonical: **ninguna ruta emite el suyo.** La raíz lo deriva del pathname con `canonicalUrlFor`, y
    una ruta que emitiera el propio produciría *dos*, que los buscadores descartan en vez de
    reconciliar. `goal` no está en `CANONICAL_SEARCH_PARAMS`, así que un enlace compartido con hint
    canonicaliza al path desnudo — verificado con `?goal=investing&utm_source=x`, que es la URL que
    la gente pega de verdad.
  - `robots.txt` no necesitaba cambio: no excluye `/for/`.

- [x] **Instrumentar funnel y feature flags**
  - Files: `src/shared/lib/conversion-events.ts`, `src/shared/lib/conversion-client.ts`, `src/routes/api/analytics/conversion.ts`, `.env.example`, `docs/operations/segmented-landing-rollout.md`
  - Do: extender el funnel existente con view/select/CTA/signup/onboarding/activation sin PII.
  - Verify: evento sintético atraviesa funnel y flag off restaura home/rutas.
  - Result: tres eventos nuevos — `segment_page_viewed`, `segment_selector_click`,
    `segment_page_cta_click` — y una superficie nueva, `segment_page`. Tres y no uno porque la
    pregunta del embudo es en cuál de los tres pasos se para la gente; un solo `landing_view` para
    las tres páginas no responde ninguno.
  - Llevan el mismo `segment` context que los eventos de elección y **significan otra cosa**: `next`
    es de qué página iba esto, nunca una preferencia guardada. Lista aparte (`SEGMENT_LANDING_EVENTS`)
    en vez de meterlos en `SEGMENT_CHOICE_EVENTS`, porque un análisis que contara una vista como una
    elección reportaría un segmento para cada visitante que leyó y no eligió nada.
  - **Atribución sin campo de atribución.** `sessionId` ya está en cada evento, y first-touch es el
    `segment_page_viewed` más antiguo de esa sesión, last-touch el último antes de `signup_complete`.
    Derivarlas en la consulta es lo que impide que se contradigan: un par de campos escritos por el
    cliente serían dos afirmaciones sobre el pasado hechas por la única parte que no lo ve entero.
  - `SEGMENTED_LANDING_ENABLED`, `false` por defecto. Apagado significa **ausente en las tres
    superficies a la vez**: `/for/*` responde 404, el selector no se renderiza, y el sitemap no las
    lista. No un 200 con el contenido escondido — una URL pública apagada que se indexa igual — ni un
    redirect a `/`, que le dice a un crawler que la página se mudó a un sitio al que no se mudó.
  - La bandera se resuelve en el servidor (`segmented-landing-flag.ts`, un `createServerFn`). `env.ts`
    le da al navegador un stub, así que una ruta que la leyera directa **serviría la página en un
    refresco y la 404-aría en un clic**, con la bandera encendida todo el rato. Es la misma trampa que
    `getIsAppAdmin` documenta en `auth-session.ts`.
  - Verificado apagado en `tests/e2e/segmented-landing-flag.spec.ts`, sobre un servidor por worker
    cuyo entorno controla el harness: las tres 404, el selector ausente, y el sitemap sin las tres
    entradas pero todavía siendo un sitemap. Tres superficies leyendo una bandera son tres
    oportunidades de discrepar, y la discrepancia es invisible hasta que alguien sigue una entrada del
    sitemap hasta un 404.
  - `playwright.config.ts` fija `SEGMENTED_LANDING_ENABLED='true'` en el servidor compartido: con el
    default, `segmented-landing.spec.ts` entero probaría una feature apagada. Es seguro fijarlo ahí
    por lo mismo que explica la nota de `ACCESS_ALLOWLIST_ENABLED` en negativo — dotenvx solo pisa
    claves que existen en `.env`, y esta vive solo como default en `env.ts`.
  - **No cubierto, y escrito en el runbook**: nada une una `sessionId` anónima con la cuenta que crea,
    así que "qué porcentaje de quien leyó `/for/investors` acabó activando" no tiene respuesta en
    estos datos. Se leen los dos tramos por separado, no el arco entero.

- [~] **Ejecutar QA de lanzamiento**
  - Files: `docs/design/responsive-qa-checklist.md`, `docs/accessibility-verification.md`
  - Do: revisar navegadores, breakpoints, teclado, lectores, performance, copy legal y claims.
  - Verify: `pnpm build`, tests, Playwright, performance budget y smoke runtime.
  - Hecho: `pnpm ci:local` completo, 39/39 pasos. Estructura, teclado y responsive registrados en
    [`accessibility-verification.md`](../../../docs/accessibility-verification.md) y
    [`responsive-qa-checklist.md`](../../../docs/design/responsive-qa-checklist.md), ambos con fecha y
    con lo que **no** se comprobó escrito al lado.
  - **El embudo no grababa nada, y el 200 lo tapaba.** El CHECK de `conversion_events` rechazaba los
    tres eventos nuevos y la superficie `segment_page` con `23514`, y la ruta de ingesta loguea y
    responde `{ok:true}`. Es exactamente el fallo de la fase 02 repitiéndose, y por eso el smoke fue
    contra la tabla y no contra el código de estado. `drizzle/0174_segmented_landing_funnel.sql` lo
    arregla; probado con inserciones directas antes (`23514` en `conversion_events_name_check`) y
    después (las cuatro combinaciones aceptadas).
  - Smoke de runtime real: con `CONVERSION_EVENTS_ENABLED=true` en local, leer `/for/hiring-teams`,
    pulsar "I'm investing" y luego el CTA deja **tres filas** en `conversion_events` —
    `segment_page_viewed` (hiring), `segment_selector_click` (`prev=hiring next=investing`,
    `src=landing`) y `segment_page_viewed` (investing). La segunda vista confirma que el efecto va
    keyed por segmento: sin eso, moverse entre las tres páginas contaría como una sola visita.
  - **El gate encontró una divergencia real**: `SEGMENTED_LANDING_ENABLED` estaba en `.env` y ausente
    del job de calidad, así que "local está verde" no habría significado que CI lo estuviera. Añadido
    a los tres bloques `env` de `quality.yml` y a `advisory.yml` y `visual-baselines.yml`, que
    `check-step-parity` exige idénticos.
  - **Pendiente**: pase real con lector de pantalla sobre las tres páginas. Lo automático comprueba
    estructura, nombre accesible y orden de foco; no puede decir si "I'm investing" seguido de un
    cambio de encabezado se anuncia como una navegación que funcionó. Es la razón de que esta tarea
    quede en `- [~]` y no en `- [x]`.
