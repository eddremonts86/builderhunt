# Rollout de perfiles auto-gestionados

Plan: [`plans/phase-2/07-perfiles-autogestionados`](../../plans/phase-2/07-perfiles-autogestionados/spec.md).

Un perfil auto-gestionado es una página que su dueño escribe: sin `(source, sourceId)`, sin claim,
sin nada verificado. Existe porque BuilderHunt indexa actividad pública de developer, y una persona
cuyo trabajo es traducir, redactar, ilustrar o investigar no aparece en ningún conector — quedaba
excluida por construcción.

## El interruptor

`SELF_MANAGED_PROFILES_ENABLED` — `false` por defecto, como todas las banderas de `env.ts`:
producción no hereda `.env` ni `.env.example`, así que encenderlo para gente real es un acto
deliberado en Coolify y no el efecto lateral de un merge.

| Estado | Qué existe |
|---|---|
| `false` | El editor `/me/profile` no renderiza. `/u/<handle>` responde **404**. Las diez rutas de API responden **404**. El origen de búsqueda no se contacta ni pidiéndolo por su nombre. La reconciliación semántica no indexa. La rama "escribe tu propia página" no se ofrece en onboarding. |
| `true` | Todo lo anterior existe. |

Una sola bandera para toda la feature, no una por superficie: varias dejarían al despliegue en
estados que nadie diseñó — una página pública de perfiles que nadie puede editar, o un índice de
filas que ya no tienen superficie.

### Qué **no** apaga, deliberadamente

**El export de datos y el borrado de cuenta siguen funcionando con la bandera en `false`.** El
derecho de una persona a ver y borrar lo que se guarda sobre ella no es una feature; una vuelta
atrás que se lo llevara convertiría una decisión operativa en una de cumplimiento.
`tests/e2e/self-managed-flag.spec.ts` lo afirma.

**El worker de escaneo sigue corriendo.** Solo mueve bytes ya aceptados hacia un veredicto, y
pararlo dejaría subidas sin escanear en cuarentena durante toda la vuelta atrás. Lo que sí para es
la indexación, que es lo que el plan pide: nada escribe filas para una superficie inalcanzable.

## Apagar es una vuelta atrás, no un borrado

Las filas se quedan donde están. Volver a encender restaura lo que había en lugar de empezar de
cero, y ningún write se cuela por una pestaña que alguien dejó abierta — las rutas responden 404
antes de mirar el cuerpo.

Por eso apagar es `SELF_MANAGED_PROFILES_ENABLED=false` y un reinicio, sin migración de vuelta.

## Antes de encender

1. **Migraciones aplicadas**: `0175` (tablas + RLS), `0176` (estado de escaneo + políticas de
   worker), `0177` (grants y políticas de handle), `0178` (entity kind semántico), `0179` (DELETE
   sobre `builder_embeddings` para el rol de la app), `0180`/`0181` (preferencias de inclusión),
   `0182` (una claim, una página). `pnpm test:migration-integrity` las verifica.
2. **Storage y antivirus**: la feature reutiliza el pipeline de documentos —
   `INTERVIEW_R2_*` y `INTERVIEW_CLAMAV_*`. Sin ellos, `getStorageProvider()` y `getVirusScanner()`
   fallan cerrado por diseño: no hay modo degradado, y una subida sin escáner nunca se sirve.
3. **Workers agendados**: `self-managed.attachment-scan` (cada 5 min) y
   `self-managed.semantic-index` (nocturno) están en `OPERATIONAL_SCHEDULES` y se disparan por
   `POST /api/admin/self-managed/run-worker` con `x-cron-secret`. No hay cron de sistema en este
   despliegue; un scheduler externo hace el POST.

## Qué mirar cuando esté encendido

| Señal | Dónde | Qué significa que se rompa |
|---|---|---|
| `scannedInfected` > 0 sostenido | respuesta del run-worker, `job_runs` | Alguien está subiendo malware. La cuarentena aguanta; el volumen es lo que decide si hace falta cerrar el alta. |
| `scanRejected` con `scan_unavailable` | igual | ClamAV no responde. **Nada pasa a `clean`** mientras dure: un escáner caído nunca produce un veredicto limpio. |
| `truncated: true` en el índice | `job_runs`, log `self_managed_index_truncated` | El corpus pasó el techo de una pasada. No es un fallo, es la señal de subir `maxPerRun` o acortar la cadencia. |
| Adjuntos `pending` envejeciendo | `select scan_status, count(*) from self_managed_attachments group by 1` | El worker no se está disparando. La cola no se limpia sola. |
| `purged` siempre 0 con filas viejas borradas | run-worker | El barrido de retención no está llegando al object store; los bytes siguen ahí a los 30 días. |

### Condiciones de parada

- Cualquier perfil auto-gestionado renderizado con el badge *verified* → apagar. Es la única
  promesa que esta feature no puede romper.
- Un adjunto servido en estado distinto de `clean` → apagar.
- Un perfil `draft` o borrado alcanzable en `/u/<handle>` → apagar.

## Evidencia de runtime

Local, contra Postgres, MinIO y ClamAV reales:

- `tests/e2e/self-managed-profile.spec.ts` — 21 specs con la bandera **encendida**: subida limpia
  con descarga firmada byte a byte, EICAR rechazado en validación y en el escáner, 404 cruzado en
  todos los handlers, cuotas, ciclo de vida del perfil, reserva de handle, retención del handle a 30
  días, indexado semántico y su borrado, política de inclusión con opt-out, promoción reversible, y
  el recorrido landing → onboarding → editor → página pública.
- `tests/e2e/self-managed-flag.spec.ts` — 5 specs con la bandera **apagada**: las diez rutas 404, el
  editor no renderiza, la página pública 404 sin filtrar su copy, el origen de búsqueda ausente
  aunque se pida por nombre, las filas intactas, y export y borrado accesibles.
- `pnpm ci:local` verde (41 pasos).

Lo que **no** está cubierto y hay que hacer con la bandera encendida en producción: el rollout en sí
—rampa, observación de D7 y postmortem— necesita ventana y aprobación explícita. Nada en este
documento sustituye eso.
