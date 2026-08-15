# Tareas — dashboard personalizado por segmento

> **Status**: `partially-implemented`
> **Depends on**: [`02-segmentacion-usuarios`](../../implemented/phase-2/02-segmentacion-usuarios/spec.md), [`03-onboarding-segmentado`](../../implemented/phase-2/03-onboarding-segmentado/spec.md)
> **Blocks**: nothing
> **Reality check**: The registry, compositor primitives, customization UI and persistence are
> already implemented in `src/modules/dashboard/lib/widget-registry.ts`, `DashboardPage.tsx`,
> `DashboardCustomizeDialog.tsx` and `/api/dashboard/preferences`. Extend them; do not replace them.

- [ ] **Inventariar widgets y dependencias**
  - Files: `docs/architecture/dashboard-widget-inventory.md`
  - Do: listar widget ID, componente, endpoint, permiso, entitlement, coste y estado vacío.
  - Verify: cada widget actual aparece una sola vez.

- [ ] **Añadir presets al registro existente**
  - Files: `src/modules/dashboard/lib/widget-registry.ts`, `src/modules/dashboard/lib/dashboard-presets.ts`, `tests/unit/modules/dashboard/lib/dashboard-presets.test.ts`
  - Do: mantener el registro actual y añadir contratos exhaustivos para
    general/hiring/investing/building y fallback; `DashboardPage.HOME_WIDGETS` se mueve al registro
    compartido solo si el import no crea un ciclo.
  - Verify: unit tests para orden, IDs únicos, permiso y segmento desconocido.

- [ ] **Aplicar el preset en el compositor existente**
  - Files: `src/modules/dashboard/components/DashboardPage.tsx`, `src/modules/dashboard/lib/dashboard-presets.ts`
  - Do: reproducir el dashboard actual como preset general, resolver el preset antes de
    `orderedWidgets`, y conservar los test IDs y controles de personalización existentes.
  - Verify: visual baseline y E2E actuales sin regresión.

- [ ] **Exponer contexto de dashboard**
  - Files: `src/routes/api/dashboard/context.ts`, `src/shared/lib/dashboard-api.ts`
  - Do: devolver segmento, preset ID y capabilities, nunca datos no autorizados.
  - Verify: HTTP tests por null/segment/role/entitlement.

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
