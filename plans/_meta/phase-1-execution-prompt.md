# Prompt: ejecutar phase-1 completa, planes 01 → 54

Documento de entrega. Todo lo que hay entre las líneas de abajo es el prompt: cópialo tal cual
como primer mensaje de una sesión nueva en este repositorio.

Escrito 2026-07-29. Los tres hechos de infraestructura que lo condicionan están verificados a esa
fecha: el workflow `Deploy to Coolify` sólo se dispara con `branches: [master]`, el workflow
`Quality` sólo corre en push para `master` y `codex/security-multitenancy`, y `phase-1` tenía 146
tareas abiertas en 27 de sus 54 planes.

---

# Ejecuta phase-1 completa: planes 01 → 54

Trabajas en `/Users/edd/Projects/eddremonts86/builderhunt` (TanStack Start + React 19,
Drizzle + postgres.js, PostgreSQL 16 con pgvector, Redis, MinIO, ClamAV, Ollama).

Tu tarea es recorrer `plans/phase-1/` en orden numérico, del 01 al 54, y cerrar cada tarea
abierta. Hay ~146 abiertas y ~600 ya cerradas. **Ejecutas de forma continua hasta terminar: no
preguntas nada, no pides confirmación, no te detienes a reportar avances intermedios.**

## Rama de trabajo

Todo el trabajo va en una rama dedicada, nunca en `master`.

```bash
git checkout master && git pull --ff-only
git checkout -b phase-1-execution
git push -u origin phase-1-execution
```

- **Un commit por tarea cerrada, y un `git push` inmediatamente después de cada commit.** El push
  es tu copia de seguridad: esta ejecución es larga y no debe existir sólo en un disco.
- **Nunca hagas merge, rebase ni push a `master`. Nunca abras un pull request.** Si alguien quiere
  integrar esto, lo decide una persona leyendo el resultado.
- Empujar esta rama es seguro y no despliega nada: `Deploy to Coolify` está limitado a
  `branches: [master]`.
- Empujar esta rama **tampoco ejecuta CI remoto**: `Quality` sólo corre en push para `master` y
  `codex/security-multitenancy`. Por eso `pnpm ci:local` no es una comodidad, es la única puerta
  que existe. `pnpm ci:local` replica el entorno del job `quality` de forma literal, incluidas las
  variables que deja sin definir.
- Antes de cada commit, comprueba que sigues donde crees: `git branch --show-current`. Este
  repositorio ha tenido un proceso en segundo plano que guardaba el trabajo en curso con `git stash`
  y hacía merges a `master` en mitad de una sesión. Si desaparecen ediciones o cambias de rama sin
  haberlo pedido, mira `git stash list` y `git reflog` antes de rehacer nada.

## Antes de tocar nada, lee estos cuatro ficheros

1. `plans/_meta/phase-1-order.md` — el orden canónico 01→54 y las dependencias. Es el mapa. Sus
   contadores de tareas están desfasados en ~6; confía en el orden, no en los números.
2. `plans/_meta/conventions.md` — cómo se escribe y se cierra un plan. Es normativo.
3. `plans/_meta/operator-queue.md` — las tareas que una persona debe hacer, no tú.
4. `CLAUDE.md` y `plans/_meta/app-reality.md` — lo que realmente existe en `src/`.

## Bucle por plan

Para cada plan `NN-slug`, en orden:

1. Lee `spec.md`, `plan.md` y `tasks.md` completos antes de escribir código.
2. Audita la realidad: la cabecera `Reality check` puede estar obsoleta. Si una tarea ya está
   implementada en `src/`, márcala `[x]` con el path real y sigue. No la reimplementes.
3. Ejecuta las tareas abiertas en el orden del fichero. Cada una tiene `Files:`, `Do:` y `Verify:`;
   ejecuta el `Verify:` literalmente.
4. Cierra cada tarea sólo cuando se cumplan las tres condiciones de "Qué significa hecho".
   Commit + push por tarea.
5. Al terminar el plan, actualiza su `tasks.md` y su `Status`, añade la línea al registro de
   ejecución, y pasa al plan siguiente sin detenerte.

## Qué significa "hecho" (las tres condiciones, sin excepción)

1. **`pnpm ci:local` en verde, todos los pasos.** El único fallo tolerado es `schema-audit`, que el
   propio workflow marca `continue-on-error` — aun así, lee su salida. Un paso rojo es parada dura
   para esa tarea: no commitees encima de un rojo. Para reintentar un paso concreto:
   `pnpm ci:local --from <nombre-del-paso>`.
2. **Un spec e2e en `tests/e2e/`** que ejercite el comportamiento por la app real: Postgres real,
   roles reales vía el harness, HTTP real. Un unit test que prueba que una función devuelve la forma
   correcta no demuestra que un usuario pueda hacer la cosa.
3. **El flujo probado a mano en el navegador por ti**, con la evidencia escrita en la línea
   `Verify:` de la tarea. Los tests codifican lo que se nos ocurrió comprobar; el pase manual es lo
   que caza lo que no.

## Navegador: cómo hacer el pase manual

Nunca arranques un servidor con Bash. Usa las herramientas del panel Browser:

- `preview_start` con `{name: "builderhunt-dev"}` (definido en `.claude/launch.json`, puerto 3010).
- `read_page` para verificar contenido y estructura; `computer` para clicar y teclear; `form_input`
  para formularios; `resize_window` para responsive y modo oscuro.
- `read_console_messages` y `preview_logs` para errores; `read_network_requests` para APIs.
- `computer {action: "screenshot"}` como evidencia de cambios visuales.

Si encuentras un fallo: lee el código fuente, corrígelo en el fuente, recarga y vuelve a comprobar.
`javascript_tool` es sólo para depurar, nunca para implementar.

## Reglas que no puedes romper

**Nunca preguntes nada.** Si una tarea lleva línea `Operator:`, sáltala, deja la casilla sin marcar
y anótala para el informe final. No esperes, y sobre todo no la marques porque "la parte de código
está hecha". El plan `54-waitlist-launch` es entero un runbook manual del fundador con 9 casillas y
sin líneas `Operator:`: sáltalo completo y anótalo igual.

**Nunca edites una migración ya aplicada.** `drizzle-kit` hashea el contenido de `drizzle/*.sql`,
así que cambiar hasta un comentario la vuelve a ejecutar en producción. Excluye `drizzle/` de
cualquier barrido masivo de ficheros.

**Migraciones nuevas, según el tipo:**

- Cambio de esquema (columna, tabla, índice): edita `src/shared/lib/db/schema.ts` y ejecuta
  `pnpm exec drizzle-kit generate --name=<nombre>`. Genera el SQL, el snapshot y la entrada del
  journal correctamente.
- Sólo políticas, grants, triggers o funciones: escribe el `.sql` a mano, copia el snapshot anterior
  con `id` y `prevId` nuevos (`prevId` = el `id` del snapshot previo), añade la entrada a
  `drizzle/meta/_journal.json` y el par `{sql, snapshot}` de SHA-256 a `drizzle/migration-hashes.json`.
- Después, **siempre las dos verificaciones, cada una con su exit code por separado**:
  `pnpm exec drizzle-kit check` (valida la cadena de padres) y `pnpm test:migration-integrity`
  (valida ficheros, journal y hashes). Comprueban cosas distintas: una pasa sin la otra.
- Aplica en local con `pnpm db:migrate`.

**Los unit tests conectan como superusuario de migración, así que ignoran GRANTs y RLS.** Un hueco
de privilegios o de política pasa en verde en `pnpm test` y sólo aparece en el harness e2e, que
corre como `builderhunt_app` / `_worker` / `_capability`. Para cualquier cosa que toque grants,
políticas o el alcance de un rol, la evidencia es un spec e2e o `scripts/db/verify-rls-local.mjs`.
Nunca un unit test.

**Un test que inspecciona estado de base de datos usa `observerSql()`** de
`tests/e2e/harness/observer-sql.ts`, no `postgres(process.env.DATABASE_URL)`. El rol de app no tiene
grant sobre `auth_users` ni `auth_sessions`, y está sujeto a RLS sin contexto de tenant: leer desde
ahí devuelve vacío y parece que la feature está rota cuando lo único mal puesto es el observador.

**Nunca exportes desde un módulo de `src/routes/` un helper que toque la capa de servidor.** Eso
mete el driver `postgres` en el bundle de cliente y mata todas las páginas, mientras `tsc`, `lint`,
los 4400+ tests y `vite build` siguen pasando. Los helpers viven fuera de `src/routes/`. Tras un
build, comprueba que `dist/client/assets/*.js` no contiene el driver — usa `grep -a`, porque sin
`-a` grep trata esos ficheros como binarios y no imprime nada aunque haya coincidencias.

**Captura exit codes, no pipes.** `cmd | tail` devuelve el código de `tail`. Redirige a un fichero,
lee `$?` inmediatamente, y luego inspecciona el fichero.

**Registros compartidos** que hay que editar al añadir superficie, o los tests de integridad fallan:
`NAV_AREAS` (`src/modules/dashboard/ui/shell/nav-config.ts` — hay que editar tanto `items` como el
prefijo en `routes`), `SOURCE_NAMES` (`src/lib/sources/types.ts`), `OPERATIONAL_SCHEDULES`
(`src/shared/lib/operational-schedules.ts`, `jobKey` único y envuelto en `withJobRun`), y
`SEO_SURFACES` (`src/shared/lib/seo/surfaces.ts`).

**Entorno:** `.env` es la única fuente; `.env.local` está vacío a propósito. `DATABASE_URL` conecta
como `builderhunt_app`, no como superusuario — no lo cambies: eso es precisamente lo que hace que
los fallos de permisos aparezcan en local en vez de en producción.

**Commits:** mensaje en inglés, explicando el *por qué* del cambio y no sólo el qué, terminando con
`Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## Lleva un registro, porque esto es largo

Tras cerrar cada plan, añade una línea a `plans/_meta/execution-log.md`: número y slug del plan,
tareas cerradas, tareas saltadas con su motivo, y los commits. Si pierdes contexto, ese fichero y
`git log` te dicen dónde estabas; retomas por el siguiente plan sin repetir trabajo.

## Puertas que deben seguir verdes al final

```bash
pnpm ci:local
pnpm plans:check-order
pnpm plans:check-tasks
```

## Informe final

Cuando termines el plan 54, escribe un informe con:

- Planes cerrados y tareas cerradas por plan.
- Cada tarea saltada, con el motivo exacto y qué persona o credencial la desbloquea.
- Cada defecto que encontraste en los propios planes — rutas que no existen, supuestos obsoletos,
  verificaciones imposibles de ejecutar — y qué hiciste con él.
- El estado de las tres puertas de arriba.
- El nombre de la rama y el último commit empujado.

No declares nada terminado que no hayas verificado ejecutándolo.
