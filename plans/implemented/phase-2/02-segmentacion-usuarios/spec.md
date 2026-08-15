# Especificación — fundamento de segmentación de usuarios

> **Status**: `implemented`
> **Depends on**: nothing — the documented taxonomy is an explicitly provisional product hypothesis;
> post-launch research may revise it but does not block implementation.
> **Blocks**: [`03-onboarding-segmentado`](../../../phase-2/03-onboarding-segmentado/spec.md), [`04-dashboard-personalizado`](../../../phase-2/04-dashboard-personalizado/spec.md), [`06-landing-segmentada`](../../../phase-2/06-landing-segmentada/spec.md)
> **Reality check**: `auth_users` y `onboarding_progress` existen en
> `src/shared/lib/db/schema.ts`; `/me` existe en `src/routes/_dashboard/me/index.tsx`. No existe un
> segmento de usuario. `submitSegmentsResponseSchema` en `src/shared/lib/interview-api.ts` solo
> confirma secuencias de transcripción.

## Objetivo

Crear una fuente de verdad explícita, versionable y segura para el objetivo principal del usuario,
exponerla en settings y convertirla en contexto consumible por onboarding, dashboard y landing.

## Contrato propuesto

```ts
export const USER_SEGMENTS = ['hiring', 'investing', 'building', 'other'] as const
export const userSegmentSchema = z.enum(USER_SEGMENTS)
export type UserSegment = z.infer<typeof userSegmentSchema>
```

Una decisión posterior de investigación cambia la taxonomía mediante una migración versionada; no
reinterpreta valores históricos.

## Modelo de datos

Nueva tabla account-subject `user_preferences`:

- `user_id`: PK y FK a `auth_users.id`, cascade delete;
- `primary_segment`: nullable durante migración;
- `segment_source`: `onboarding | settings | landing | migration`;
- `segment_schema_version`: entero;
- `segment_selected_at`, `created_at`, `updated_at`.

El segmento es inicialmente personal, no tenant-private. Una persona conserva su objetivo al
cambiar de organización. Si evidencia real demuestra objetivos distintos por workspace, se diseñará
una preferencia organizacional posterior; no se añade ahora.

## API

- `GET /api/me/preferences`: devuelve preferencias del usuario autenticado.
- `PATCH /api/me/preferences`: acepta solamente campos allowlisted y validados.
- no acepta `userId` ni `organizationId` del cliente;
- respuesta compartida mediante Zod;
- actualizaciones idempotentes y auditables mediante eventos de producto sin PII.

## UX

Añadir a `/me` una sección “Objetivo principal”:

- explica por qué se solicita;
- muestra nombres humanos, no enum internos;
- permite cambiar sin borrar búsquedas, builders, alertas o historial;
- informa que modifica recomendaciones, no permisos ni billing;
- `other` permite continuar y opcionalmente capturar feedback no estructurado separado.

## Analítica

Eventos mínimos:

- `segment_prompt_viewed`;
- `segment_selected`;
- `segment_changed`;
- `segment_skipped`;
- `activation_reached`, con `activation_type`.

Propiedades permitidas: segmento anterior/nuevo, origen, versión de flujo y timestamp. No incluir
email, nombre, query literal ni datos de candidatos.

## Compatibilidad

- usuarios existentes empiezan con `null`;
- todo consumidor debe soportar `null` y usar preset general;
- rollback de UI no elimina preferencias;
- cambiar enum requiere migración explícita, nunca reinterpretar valores históricos.

## Seguridad y privacidad

- el usuario solo lee/escribe su propio registro;
- el segmento no entra en `TenantPrincipal`;
- no participa en `can()` ni en guards de rutas;
- administradores internos pueden ver agregados, no usar el segmento como dato sensible de soporte
  salvo necesidad documentada;
- eliminación de cuenta elimina preferencias.

## No objetivos

- múltiples segmentos simultáneos;
- inferencia automática por actividad;
- permisos por segmento;
- pricing por segmento;
- sincronización con CRM en esta fase.

## Criterios de aceptación

- contrato único importado por todos los consumidores;
- API rechaza IDs y valores desconocidos;
- settings persiste y recupera el valor;
- null fallback funciona;
- tests prueban aislamiento entre usuarios;
- métricas segmentadas no contienen PII.
