# Tareas — roles internos de plataforma

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: nothing
> **Reality check**: Toda autorización admin actual deriva de `ADMIN_USER_IDS`.

- [ ] **Inventariar superficie administrativa**
  - Files: `docs/architecture/platform-authorization-matrix.md`
  - Do: enumerar cada página, API, método, efecto, datos y permiso propuesto.
  - Verify: `rg "api/admin|_dashboard/admin" src/routes` no produce endpoints ausentes de la matriz.

- [ ] **Definir roles y permisos**
  - Files: `src/shared/lib/auth/platform-permissions.ts`, `tests/unit/shared/lib/auth/platform-permissions.test.ts`
  - Do: enums, bundles, deny-by-default y exhaustividad.
  - Verify: tests por cada rol/permiso y permiso desconocido.

- [ ] **Crear tablas operacionales**
  - Files: `src/shared/lib/db/schema.ts`, `drizzle/0118_platform_staff_roles.sql`, `drizzle/migration-hashes.json`
  - Do: assignments, append-only audit, constraints y grants platform-only.
  - Verify: DB desechable demuestra que app/tenant roles no pueden leer tablas.

- [ ] **Implementar principal y guards**
  - Files: `src/shared/lib/auth/platform-principal.ts`, `tests/unit/shared/lib/auth/platform-principal.test.ts`
  - Do: require principal/permission, bootstrap allowlist y protección último super admin.
  - Verify: 401/403/200, revocado, último admin y cache invalidation.

- [ ] **Añadir shadow mode**
  - Files: `src/shared/lib/auth/platform-authorization-shadow.ts`, `.env.example`, `docs/operations/platform-rbac-rollout.md`
  - Do: comparar allowlist/RBAC, métricas redacted y feature flags.
  - Verify: discrepancias sintéticas se registran sin modificar respuesta.

- [ ] **Migrar rutas admin**
  - Files: `src/routes/api/admin/`, `src/routes/_dashboard/admin/`
  - Do: declarar permiso exacto en cada handler/beforeLoad y conservar guards de dominio.
  - Verify: tabla-driven HTTP tests cubren todos los endpoints y métodos.

- [ ] **Crear API de capabilities y roles**
  - Files: `src/routes/api/admin/capabilities.ts`, `src/routes/api/admin/roles/index.ts`, `src/routes/api/admin/roles/$userId.ts`
  - Do: lectura capabilities, asignación/revocación con reason y audit.
  - Verify: tests de privilege escalation, self-revoke y last-admin.

- [ ] **Crear UI de gestión**
  - Files: `src/routes/_dashboard/admin/roles.tsx`, `src/modules/dashboard/components/PlatformRolesPage.tsx`, `src/modules/dashboard/ui/shell/nav-config.ts`
  - Do: matriz, asignaciones, confirmación y audit trail; navegación por capability.
  - Verify: component tests accesibles y E2E por cada rol.

- [ ] **Activar enforcement y ensayar rollback**
  - Files: `docs/operations/platform-rbac-rollout.md`, `docs/operations/platform-rbac-break-glass.md`
  - Do: rollout por dominio, checkpoint y ejercicio de recuperación.
  - Verify: suite completa, security boundaries, smoke con cinco roles y evidencia del ensayo.

