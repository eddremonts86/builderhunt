1. Pipeline / Hiring Kanban de builders trackeados
Qué: vista de columnas personalizables sobre /me/builders (default: Nuevo → Revisado → Contactado → En conversación → Contratado), con timestamps por stage, notas por stage, y filtros por stage/owner dentro de la organización.

Por qué: hoy BuilderHunt te deja descubrir y trackear, pero el momento "estoy contratando a 5 personas a la vez" se pierde entre exports CSV y notas sueltas. Esto convierte la app de herramienta de sourcing en herramienta de hiring real, que es donde está el dolor diario de founders y recruiters.

Cómo: extiende organization_builders con columnas pipeline_stage + pipeline_stage_changed_at + pipeline_owner_user_id. Reutiliza la infraestructura de notes existente. Sin nueva tabla grande. Tier-gateado (Pro/Pro Max con stages custom; Team con automation rules).

2. "Why this match" — panel de evidencia por resultado
Qué: panel plegable en cada PersonResultCard que muestra qué posts / commits / fechas empujaron el score, y qué evidencia hay detrás (con links al original, no screenshots).

Por qué: los 4 user personas (mantenedores OSS, founders, recruiters, DevRel) tienen el mismo miedo: "¿me está mostrando a una persona real o a un bot?" Las auditorías de audit-trust son internas; esto es la cara visible de la confianza. Diferencia brutal vs. LinkedIn Recruiter, que sólo da keywords.

Cómo: puro consumidor de score.ts + builder_source_snapshots. Sin nueva infra. Encaja directo en el design system (card, glass shell-only). Cierra findings de audit-trust y sube conversión en search → track.

3. Saved Search Health — analytics de búsquedas guardadas
Qué: dashboard en /saved-searches con, por cada search guardada: % de resultados con los que interactuaste en 30 días, tiempo desde último match útil, alertas que se dispararon vs. las que abriste, recomendación explícita ("mátala" / "ajusta el query" / "sigue, está sana").

Por qué: con docenas de saved searches + alerts, los users acumulan búsquedas zombies. Hoy no hay forma de saber cuáles valen la pena. smart-alerts sólo dispara; no te dice que tu search murió. Esto convierte ruido en una decisión semanal de 2 minutos — el éxito del producto.

Cómo: vista pura de lectura sobre alerts + alert_triggers + sourcing_sprints. Cero schema nuevo. Puede correr un job semanal de "search health score" vía el patrón worker admin-triggered que ya usas para alerts/discovery.

4. Paste-a-JD → Top 20 ranked candidates
Qué: un input en /search (o ruta propia /match) donde pegas una job description y devuelve los 20 builders mejor rankeados con evidencia por match ("commits en Rust async runtime", "3 posts sobre Postgres performance", etc.).

Por qué: es el pain killer de hiring más concreto del mercado. No choca con solutions-intelligence — aquél compara Human/AI/Hybrid y es advisory premium; éste es el flujo directo founder-pastea-JD-ve-candidatos, mucho más frecuente. Complemento perfecto: SI recomienda también AI/hybrid, pero el caso 80% es "dame personas".

Cómo: combinación de semantic-search (embeddings de JD vs builder_embeddings) + tarea nueva en ai-expansion registry (match-jd-to-builders) con zod output. Tier Pro Max. Cero fuente nueva.

5. Co-Shipping / Collaboration Graph
Qué: vista de red donde, desde el perfil de un builder, ves sus co-autores frecuentes en commits, co-mencionados en threads, y co-publicadores en lanzamientos. Click en cualquier nodo → su perfil. Filtros: fuerza del link, ventana temporal, fuente.

Por qué: descubrimiento derivado de red: no encuentras a la persona, encuentras a sus colaboradores. Caso de uso real: "necesito un frontend; X hace frontend pero el que mejor shippea con X es Y." Ningún sourcing tool mainstream lo tiene. Network effects reales sobre los datos que ya scrapeas.

Cómo: nueva tabla builder_collaboration_edges (builderIdentityA_id, builderIdentityB_id, strength, source, last_seen). Worker background (sigue el patrón admin-triggered) que se alimenta de GitHub co-author data. Render: vista dedicada con svg/canvas simple, no librería pesada. Premium feature obvia.

6. Look-alike sourcing ("más como este")
Pegas el perfil de tu mejor ingeniero (o cualquier builder de BuilderHunt) y obtienes un ranking de builders similares por stack, patrón de actividad y tipo de proyectos. Se apoya directamente en la infraestructura que ya viene en camino: los embeddings + pgvector de semantic-search y el índice global de proactive-discovery. Es el paso natural después de la búsqueda semántica y un diferenciador fuerte frente a búsqueda booleana: el recruiter no describe lo que quiere, lo muestra.

7. Señales de disponibilidad (open-to-work score)
Un score de "probabilidad de estar receptivo" inferido de señales públicas: cambios de bio, picos de actividad en side-projects, "open to work" explícito, README de perfil actualizado, actividad en horarios que sugieren búsqueda activa. Encaja con el motor de scoring con decay que ya tenéis (el risk score de abuse usa la misma mecánica de señales combinadas + decay — el patrón es reutilizable). Es el dato que un recruiter pagaría por tener antes de gastar un crédito de outreach. Requiere cuidado con _meta/security-policy.md porque roza datos personales, pero todo es señal pública.

8. Extensión de navegador (overlay en GitHub/LinkedIn)
Una extensión que, al visitar un perfil de GitHub o LinkedIn, muestra la ficha BuilderHunt: score de recencia, actividad cross-source, botón "añadir a lista/sprint". Es el canal de distribución que falta en el backlog: lleva el producto a donde el recruiter ya trabaja en vez de exigirle otra pestaña, y cada instalación es un loop de adquisición. Además encaja con la política AI local-first (Chrome built-in AI ya es vuestro default en _meta/ai-policy.md, y una extensión vive justo ahí).

9. Integraciones ATS (Greenhouse, Lever, Ashby)
Exportar/sincronizar candidatos de una lista o sprint hacia el ATS del cliente, con deduplicación y estado de vuelta (contactado, entrevista, contratado). Los planes actuales cubren encontrar y contactar, pero el ciclo muere fuera del producto: sin esto, BuilderHunt siempre será "una herramienta más" en vez de parte del pipeline oficial. Es también la feature que desbloquea ventas a equipos de recruiting serios (y da datos de cierre reales para medir la calidad de vuestro scoring).

10. Informes públicos de talent market intelligence
Páginas públicas y digest mensual del tipo "builders activos en Rust: +18% este trimestre", "los 50 builders emergentes en AI tooling", generados automáticamente desde los datos agregados que ya tenéis de 12 fuentes. Doble función: motor SEO/top-of-funnel (complementa content-marketing y public-landing-pages con contenido que se regenera solo) y upsell hacia un tier de "insights" para clientes que quieren datos de mercado, no solo búsqueda. Solo usa datos agregados y anónimos, así que el riesgo de privacidad es mínimo.