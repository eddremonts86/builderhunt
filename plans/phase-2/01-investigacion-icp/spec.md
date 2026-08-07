# Especificación — investigación de ICP y buyer personas

> **Status**: `pending`
> **Depends on**: nothing
> **Blocks**: nothing — interviews and the ICP decision moved to
> [`phase-5/04-post-launch-discovery`](../../phase-5/04-post-launch-discovery/spec.md) on 2026-08-05.
> **Reality check**: BuilderHunt ya sirve búsqueda, tracking, alertas, sprints, scheduling,
> entrevistas, perfiles reclamables y equipos. El onboarding actual en `src/routes/onboarding/`
> solo activa el workflow de búsqueda y no existe evidencia suficiente en el repositorio para
> afirmar que founders, investors y builders compran por razones distintas.

## Problema

La propuesta inicial `founder | investor | user` mezcla cargo, tipo de organización y una categoría
residual sin significado. Implementarla directamente produciría copy superficial, métricas
imposibles de interpretar y tres experiencias basadas en supuestos.

## Objetivo de esta fase

Preparar el paquete neutral de investigación y registrar el baseline verificable antes del
lanzamiento. La ejecución de entrevistas, la síntesis y la decisión de ICP pertenecen a
[`phase-5/04-post-launch-discovery`](../../phase-5/04-post-launch-discovery/spec.md); no bloquean
la implementación de la taxonomía provisional de phase 2.

## Preguntas de investigación

1. ¿Qué trabajo intenta completar cada persona y con qué frecuencia?
2. ¿Qué evento dispara la búsqueda de una herramienta?
3. ¿Qué alternativas usa ahora, cuánto cuestan y por qué fallan?
4. ¿Quién usa el producto, quién decide y quién paga?
5. ¿Qué evidencia necesita para confiar en un builder o proyecto?
6. ¿Qué acción demuestra valor durante la primera sesión?
7. ¿Qué señal recurrente justificaría volver semanalmente?
8. ¿Qué datos o workflows jamás compartiría con una plataforma externa?

## Segmentos candidatos

### Hiring

- Persona primaria: founder técnico o responsable de contratación de una startup pequeña.
- JTBD supuesto: “cuando necesito ampliar el equipo, ayúdame a descubrir builders activos y
  convertir señales públicas en una shortlist defendible”.
- Activación candidata: primera búsqueda útil y al menos tres builders guardados.
- Buyer y usuario pueden ser la misma persona; en equipos mayores pueden separarse.

### Investing

- Persona primaria: scout, associate o partner con una tesis técnica.
- JTBD supuesto: “cuando exploro un mercado, ayúdame a detectar builders/equipos antes de que sean
  obvios y seguir señales de progreso”.
- Activación candidata: primer radar temático con entidades seguidas.
- Riesgo: muchas funciones actuales están diseñadas como sourcing de talento, no deal sourcing.

### Building

- Persona primaria: developer independiente, maintainer o founder-builder.
- JTBD supuesto: “cuando busco visibilidad u oportunidades, ayúdame a controlar mi representación y
  mostrar evidencia verificable de lo que construyo”.
- Activación candidata: perfil reclamado y completado.
- Probable usuario valioso para el marketplace, pero no necesariamente buyer directo.

## Método

- 5 entrevistas de problema por segmento candidato; 15 en total.
- reclutamiento diversificado por tamaño de empresa/fondo, seniority y uso de herramientas.
- entrevistas sin enseñar primero la solución para evitar confirmation bias.
- después de la entrevista, test de mensaje y prototipo de landing.
- análisis con matriz común: frecuencia, severidad, alternativa, presupuesto, confianza y
  capacidad real del producto.
- contraste opcional con Claude como crítico/sintetizador, nunca como fuente de evidencia.

## Clasificación de evidencia

- **Evidencia**: cita o comportamiento observado con referencia anonimizada.
- **Inferencia**: patrón interpretado a partir de varias evidencias.
- **Hipótesis**: creencia todavía no validada.

Los informes no pueden presentar salidas de un LLM, intuiciones del equipo o métricas simuladas como
evidencia de mercado.

## Entregables

- repositorio anonimizado de notas y consentimiento;
- scorecard por entrevista;
- mapa buyer/usuario/pagador;
- definición y criterios de inclusión de cada ICP;
- lista de JTBD y objeciones priorizadas;
- recomendación `go / experiment / no-go` por segmento;
- mensajes y CTA aprobados para el test de landing;
- decisión documentada sobre la taxonomía MVP.

## Métricas y umbrales de decisión

Un segmento pasa a MVP cuando, como mínimo:

- 3 de 5 entrevistados describen el mismo trabajo frecuente sin ser inducidos;
- existe una alternativa actual con coste claro de tiempo o dinero;
- al menos 2 aceptan probar un workflow concreto;
- BuilderHunt ya resuelve el núcleo o puede hacerlo sin crear otro producto;
- se identifica una señal de activación medible.

Estos umbrales son una regla de decisión interna, no significancia estadística.

## No objetivos

- reclutar o entrevistar participantes antes del lanzamiento;
- cerrar la decisión de ICP en esta fase;
- estimar TAM con precisión;
- fijar pricing definitivo;
- afirmar product-market fit;
- construir funcionalidades durante la investigación;
- almacenar PII de entrevistados en el repositorio.

## Riesgos

- entrevistar solo contactos cercanos;
- confundir entusiasmo con intención de uso;
- forzar “investor” por preferencia estratégica;
- asumir que builders pagarán por visibilidad;
- interpretar “me gusta” como compromiso.

## Criterio de aceptación

La investigación termina cuando existe una decisión explícita por segmento, las conclusiones citan
evidencia real y producto puede derivar de ellas contratos, eventos de activación y copy sin usar
categorías ambiguas.
