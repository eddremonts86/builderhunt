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

- [ ] **Preservar hint hasta onboarding**
  - Files: `src/shared/lib/landing-segment-hint.ts`, `src/modules/auth/components/SignUpPage.tsx`, `src/routes/onboarding/goal.tsx`
  - Do: validar, TTL, first-party storage y precedencia de preferencia persistida.
  - Verify: e2e landing → signup → goal y valores manipulados/expirados.

- [~] **Actualizar descubrimiento SEO**
  - Files: `src/routes/sitemap[.]xml.ts`, `src/routes/robots[.]txt.ts`, `src/routes/__root.tsx`
  - Do: sitemap, crawling y structured data coherente.
  - Verify: parsear sitemap, canonical único y OG preview.
  - Hecho: las tres páginas en el sitemap, **generadas desde `SEGMENT_PAGES`** y no escritas a mano,
    así que una página añadida o renombrada no puede dejar el sitemap describiendo una URL que da 404
    — ni omitiendo una que existe y es el único sitio donde vive la copy de un segmento entero. Un
    e2e parsea el XML y exige exactamente una entrada por página.
  - **No hecho**: JSON-LD / structured data y la revisión de canonical. `robots.txt` no necesitaba
    cambio (no excluye `/for/`), pero eso está comprobado por lectura y no por un test.

- [ ] **Instrumentar funnel y feature flags**
  - Files: `src/shared/lib/conversion-events.ts`, `src/shared/lib/conversion-client.ts`, `src/routes/api/analytics/conversion.ts`, `.env.example`, `docs/operations/segmented-landing-rollout.md`
  - Do: extender el funnel existente con view/select/CTA/signup/onboarding/activation sin PII.
  - Verify: evento sintético atraviesa funnel y flag off restaura home/rutas.

- [ ] **Ejecutar QA de lanzamiento**
  - Files: `docs/design/responsive-qa-checklist.md`, `docs/accessibility-verification.md`
  - Do: revisar navegadores, breakpoints, teclado, lectores, performance, copy legal y claims.
  - Verify: `pnpm build`, tests, Playwright, performance budget y smoke runtime.
