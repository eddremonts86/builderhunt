# Tareas — dashboard personalizado por segmento

> **Status**: `pending`
> **Depends on**: [`02-segmentacion-usuarios`](../02-segmentacion-usuarios/spec.md), [`03-onboarding-segmentado`](../03-onboarding-segmentado/spec.md)
> **Blocks**: nothing
> **Reality check**: `DashboardPage.tsx`, bento y home widgets son superficies existentes.

- [ ] **Inventariar widgets y dependencias**
  - Files: `docs/architecture/dashboard-widget-inventory.md`
  - Do: listar widget ID, componente, endpoint, permiso, entitlement, coste y estado vacío.
  - Verify: cada widget actual aparece una sola vez.

- [ ] **Crear registro y presets**
  - Files: `src/modules/dashboard/ui/home/widget-registry.ts`, `src/modules/dashboard/ui/home/dashboard-presets.ts`, `tests/unit/modules/dashboard/ui/home/dashboard-presets.test.ts`
  - Do: contratos exhaustivos, general/hiring/investing/building y fallback.
  - Verify: unit tests para orden, IDs únicos, permiso y segmento desconocido.

- [ ] **Extraer compositor**
  - Files: `src/modules/dashboard/ui/home/DashboardComposer.tsx`, `src/modules/dashboard/components/DashboardPage.tsx`
  - Do: reproducir el dashboard actual como preset general antes de personalizar.
  - Verify: visual baseline y E2E actuales sin regresión.

- [ ] **Exponer contexto de dashboard**
  - Files: `src/routes/api/dashboard/context.ts`, `src/shared/lib/dashboard-api.ts`
  - Do: devolver segmento, preset ID y capabilities, nunca datos no autorizados.
  - Verify: HTTP tests por null/segment/role/entitlement.

- [ ] **Implementar presets**
  - Files: `src/modules/dashboard/ui/home/dashboard-presets.ts`, `tests/unit/modules/dashboard/ui/home/DashboardComposer.test.tsx`
  - Do: configurar contenido/CTA y empty states honestos por segmento.
  - Verify: component tests y screenshots mobile/desktop por preset.

- [ ] **Persistir overrides**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0117_dashboard_preferences.sql`, `src/routes/api/me/dashboard-preferences.ts`
  - Do: guardar orden/visibilidad versionados, validar IDs y soportar reset.
  - Verify: tests de aislamiento, layout inválido y cambio de preset.

- [ ] **Medir rendimiento y rollout**
  - Files: `scripts/check-performance-budgets.mjs`, `.env.example`, `docs/operations/personalized-dashboard-rollout.md`
  - Do: eventos por widget y flag para preset general/segmentado.
  - Verify: Lighthouse budgets, E2E settle signal y smoke con widget fallido.

