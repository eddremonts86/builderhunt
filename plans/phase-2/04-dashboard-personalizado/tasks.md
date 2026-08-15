# Tareas — dashboard personalizado por segmento

> **Status**: `partially-implemented`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md), [`03-onboarding-segmentado`](../../implemented/phase-2/03-onboarding-segmentado/spec.md)
> **Blocks**: nothing
> **Reality check**: The registry, compositor primitives, customization UI and persistence are
> already implemented in `src/modules/dashboard/lib/widget-registry.ts`, `DashboardPage.tsx`,
> `DashboardCustomizeDialog.tsx` and `/api/dashboard/preferences`. Extend them; do not replace them.

- [x] **Inventariar widgets y dependencias**
  - Files: `docs/architecture/dashboard-widget-inventory.md`
  - Do: listar widget ID, componente, endpoint, permiso, entitlement, coste y estado vacío.
  - Verify: cada widget actual aparece una sola vez.
  - Result: [`docs/architecture/dashboard-widget-inventory.md`](../../../docs/architecture/dashboard-widget-inventory.md)
    con los 21 widgets, y `tests/unit/modules/dashboard/dashboard-widget-inventory.test.ts` (4 tests)
    que lo compara contra `HOME_WIDGETS`. Un documento derivado que nadie verifica es exacto justo
    hasta que alguien toca el dashboard, así que el test es lo que lo mantiene cierto.
  - **Lo encontró su propio test**: el primer borrador tenía 18 widgets, no 21. Los tres `stat-*` se
    generan desde una lista con spread en vez de escribirse, así que leer el registro no los enseña.
  - Dieciséis de veintiuno no cuestan petición propia: leen secciones de un único
    `GET /api/dashboard/overview`. Los cinco que sí (`sprints`, `recommendations`, `alerts`,
    `saved-searches`, `recent-builders`) son los que un preset puede encarecer — no al promoverlos,
    sino al **desocultarlos**.
  - **Ningún widget está gateado por plan, y es deliberado.** El entitlement se aplica en cada fuente
    de datos, así que un widget en un workspace gratuito enseña su estado honesto en vez de
    desaparecer. Un preset no puede convertirse en una segunda superficie de entitlement: ocultar
    `alerts` diría que la función no existe, que es un mensaje distinto del verdadero.

- [x] **Añadir presets al registro existente**
  - Files: `src/modules/dashboard/lib/widget-registry.ts`, `src/modules/dashboard/lib/dashboard-presets.ts`, `tests/unit/modules/dashboard/lib/dashboard-presets.test.ts`
  - Do: mantener el registro actual y añadir contratos exhaustivos para
    general/hiring/investing/building y fallback; `DashboardPage.HOME_WIDGETS` se mueve al registro
    compartido solo si el import no crea un ciclo.
  - Verify: unit tests para orden, IDs únicos, permiso y segmento desconocido.
  - Result: `src/modules/dashboard/lib/dashboard-presets.ts` y 22 tests, contra el registro real y no
    contra un fixture — un preset es una lista de IDs de widget, y el fallo que importa es justo que
    esos IDs dejen de coincidir con el dashboard, que un fixture ocultaría por definición.
  - **Un preset es una instrucción parcial**, no un layout: nombra con qué empieza la ruta y qué
    esconde, y lo que no menciona conserva su posición en el registro. Un preset que listara los 21
    widgets serían cuatro copias casi idénticas del registro, y la diferencia entre rutas — lo único
    que merece revisión — quedaría invisible.
  - **`general` no nombra nada**, así que resolverlo es demostrablemente la identidad y el dashboard
    que todo el mundo tiene hoy no se mueve. `other`, segmento nulo, petición fallida y un valor de
    un build futuro caen ahí.
  - `HOME_WIDGETS` **no** se movió al registro compartido: se exporta desde `DashboardPage` y el
    preset se valida ahí mismo con `assertPresetsMatchRegistry`, al cargar el módulo. Mover 600
    líneas de JSX para que un fichero de datos pudiera importarlas habría sido un refactor con
    riesgo y sin lector.

- [x] **Aplicar el preset en el compositor existente**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`, `src/modules/dashboard/lib/dashboard-presets.ts`
  - Do: reproducir el dashboard actual como preset general, resolver el preset antes de
    `orderedWidgets`, y conservar los test IDs y controles de personalización existentes.
  - Verify: visual baseline y E2E actuales sin regresión.
  - Result: `resolvePresetLayout` se resuelve antes de `orderedWidgets`, así que la elegibilidad por
    rol y por dependencia sigue corriendo primero — un preset puede promover un widget que el rol no
    ve, y la respuesta es que gana el rol. Un preset es presentación y no concede nada.
  - **El preset aplica a lo que nadie ha ordenado, dimensión a dimensión.** Un único flag de "¿está
    personalizado?" tiraría el preset entero en cuanto alguien fijara un tile; fusionar los oculto
    haría imposible restaurar un widget que la ruta esconde, y "Restaurar" es un control que el
    diálogo ya ofrece. Vaciar una lista es cómo vuelve el default de la ruta — sin segunda API y sin
    segunda tabla, que es justo lo que pide la tarea 6.
  - Verificado: 20 e2e de dashboard y **44 baselines visuales** verdes sin regenerar una sola imagen.

- [x] **Exponer contexto de dashboard**
  - Files: `src/routes/api/dashboard/context.ts`, `src/shared/lib/dashboard-api.ts`
  - Do: devolver segmento, preset ID y capabilities, nunca datos no autorizados.
  - Verify: HTTP tests por null/segment/role/entitlement.
  - Result: `src/routes/api/dashboard/context.ts`, `src/shared/lib/dashboard-api.ts`,
    `src/modules/dashboard/lib/use-dashboard-context.ts` y
    `tests/e2e/api/dashboard-context.spec.ts` (8 specs, los cuatro ejes que pide el Verify).
  - Pequeño a propósito: el spec prohíbe un endpoint gigante por segmento, así que este contesta
    **qué ruta** y cada widget sigue leyendo la fuente que ya leía. Un preset cambia el orden de la
    página, nunca lo que la página pide.
  - **El segmento sale del servidor, nunca de la petición.** No hay campo con el que un cliente pueda
    nombrar segmento, rol u organización, y un e2e lo prueba mandando ambos en la query string.
  - Las capabilities ahora se sirven en vez de solo compilarse: "esto ha salido" es un hecho del
    despliegue que atiende la petición, y un cliente que lo decidiera solo se quedaría con su
    respuesta a través de un rollback.
  - El plan viaja para que el dashboard pueda decir "eso es de otro plan" en vez de esconder el
    widget. Esconderlo diría que la función no existe.

- [ ] **Implementar presets**
  - Files: `src/modules/dashboard/ui/home/dashboard-presets.ts`, `tests/unit/modules/dashboard/ui/home/DashboardComposer.test.tsx`
  - Do: configurar contenido/CTA y empty states honestos por segmento.
  - Verify: component tests y screenshots mobile/desktop por preset.

- [ ] **Integrar presets con las preferencias ya persistidas**
  - Files: `src/shared/lib/dashboard/preferences-contract.ts`, `src/shared/lib/repositories/dashboard-preferences.ts`, `src/routes/api/dashboard/preferences.ts`, `tests/e2e/dashboard-and-navigation.spec.ts`
  - Do: conservar `revision`, `schemaVersion`, `hiddenWidgetIds`, `pinnedWidgetIds` y
    `orderedWidgetIds`; definir cómo un cambio de segmento mantiene o restaura el layout sin crear
    una segunda API ni una segunda tabla.
  - Verify: los tests existentes de aislamiento/conflicto siguen verdes y un e2e cambia de segmento,
    conserva layout, restaura preset y refresca la página.

- [ ] **Medir rendimiento y rollout**
  - Files: `scripts/check-performance-budgets.mjs`, `.env.example`, `docs/operations/personalized-dashboard-rollout.md`
  - Do: eventos por widget y flag para preset general/segmentado.
  - Verify: Lighthouse budgets, E2E settle signal y smoke con widget fallido.
