# Tareas — investigación de ICP y buyer personas

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: nothing — **el bloqueo se levantó el 2026-08-05.** Este plan declaraba bloquear
> `02-segmentacion-usuarios` y `06-landing-segmentada`, y `02` bloquea a su vez `03` y `04`: cinco de los
> siete planes de la fase esperaban quince entrevistas con desconocidos. Se invierte el orden — se
> implementa la taxonomía documentada en [`../README.md`](../README.md) como hipótesis y la investigación
> la corrige después del lanzamiento, en
> [`plans/phase-5/04-post-launch-discovery`](../../phase-5/04-post-launch-discovery/tasks.md).
> **Reality check**: No hay un artefacto de research de ICP en `plans/`; esta tarea produce
> decisiones y evidencia, no código de producto.

- [ ] **Crear el paquete de investigación**
  - Files: `docs/research/phase-2/interview-guide.es.md`, `docs/research/phase-2/scorecard.es.md`, `docs/research/phase-2/recruiting-screener.es.md`
  - Do: incluir consentimiento, preguntas de comportamiento pasado, alternativas, frecuencia,
    trigger, coste, decisión de compra y solicitud de prueba.
  - Verify: revisión por dos miembros del equipo; ninguna pregunta presupone que BuilderHunt es la solución.

- [ ] **Registrar el baseline**
  - Files: `docs/research/phase-2/baseline.es.md`
  - Do: documentar signup, onboarding completion, primera búsqueda, primer builder guardado y
    retención disponibles; marcar métricas no instrumentadas.
  - Verify: cada cifra incluye consulta, rango temporal y fuente; ninguna se estima.

### Entrevistar cinco perfiles de hiring

**Movida a [`plans/phase-5/04-post-launch-discovery`](../../phase-5/04-post-launch-discovery/tasks.md) el 2026-08-05**, deliberadamente no como
casilla: requiere cinco profesionales reales que dediquen una hora, y no se recluta a nadie antes de tener
producto que mostrar.

### Entrevistar cinco perfiles de investing

**Movida a [`plans/phase-5/04-post-launch-discovery`](../../phase-5/04-post-launch-discovery/tasks.md) el 2026-08-05**, deliberadamente no como
casilla: requiere cinco profesionales reales que dediquen una hora, y no se recluta a nadie antes de tener
producto que mostrar.

### Entrevistar cinco perfiles de building

**Movida a [`plans/phase-5/04-post-launch-discovery`](../../phase-5/04-post-launch-discovery/tasks.md) el 2026-08-05**, deliberadamente no como
casilla: requiere cinco profesionales reales que dediquen una hora, y no se recluta a nadie antes de tener
producto que mostrar.

### Contrastar la síntesis con Claude

**Movida a [`plans/phase-5/04-post-launch-discovery`](../../phase-5/04-post-launch-discovery/tasks.md) el 2026-08-05.** Toma como entrada los tres
documentos de hallazgos, así que no puede ejecutarse antes que ellos — se mueve por esa dependencia, no
porque la crítica en sí necesite una persona.

### Cerrar la decisión de ICP

**Movida a [`plans/phase-5/04-post-launch-discovery`](../../phase-5/04-post-launch-discovery/tasks.md) el 2026-08-05.** Su criterio de aceptación es
una aprobación explícita de producto y marketing sobre una afirmación de posicionamiento, que un agente no
debe registrar.

**Y su papel cambia de requisito a corrección.** La taxonomía (`hiring | investing | building | other`) se
implementa primero como hipótesis documentada — está en [`../README.md`](../README.md) con su razonamiento
— y esta tarea cierra el bucle sobre si era correcta. Es seguro invertir el orden precisamente aquí porque
el primer principio no negociable de esta fase dice que `user_segment` personaliza mensajes y prioridades y
**nunca concede permisos**: equivocarse cuesta un titular mal dirigido, no un límite de seguridad.

