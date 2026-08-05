# Post-launch discovery (tasks)

> **Status**: `blocked` — every task needs real users to talk to
> **Depends on**: [`03-launch-and-distribution`](../03-launch-and-distribution/tasks.md)
> **Provenance**: five tasks moved from `plans/phase-2/01-investigacion-icp` on 2026-08-05, on Edd's
> instruction to move anything that stops the app being built. That plan's `Blocks:` header made fifteen
> interviews with strangers a prerequisite for five of phase-2's seven plans.

The two tasks that did **not** move stay in phase 2, because a founder can finish them today: writing the
interview guide/scorecard/screener, and recording the measurable baseline.

## Interviews

- [ ] **Entrevistar cinco perfiles de hiring**
  - Files: `docs/research/phase-2/findings-hiring.es.md`
  - Do: anonimizar participantes y sintetizar comportamientos, alternativas, objeciones y compromisos.
  - Verify: cinco scorecards completos y conclusiones enlazadas a evidencia anonimizada.
  - Operator: needs five real hiring professionals who will give an hour each. First of the three, because
    `hiring` is the segment the current product already serves and therefore the one with real users to
    recruit from.
  - Moved from `plans/phase-2/01-investigacion-icp` on 2026-08-05.

- [ ] **Entrevistar cinco perfiles de investing**
  - Files: `docs/research/phase-2/findings-investing.es.md`
  - Do: validar específicamente si señales de builders sirven para sourcing de inversión o si falta
    información empresarial esencial.
  - Verify: decisión preliminar `go / experiment / no-go` con razones.
  - Operator: needs five real investors or scouts. This is the segment most likely to come back `no-go`,
    and finding that out is worth more than the five interviews cost — it is the cheapest way to avoid
    building an investing surface nobody asked for.
  - Moved from `plans/phase-2/01-investigacion-icp` on 2026-08-05.

- [ ] **Entrevistar cinco perfiles de building**
  - Files: `docs/research/phase-2/findings-building.es.md`
  - Do: separar motivación por visibilidad, control de identidad, portfolio y oportunidades.
  - Verify: distinguir claramente usuario de red y buyer.
  - Operator: needs five real builders. Note the distinction this task exists to draw — a builder is a
    *user of the network* and may never be the *buyer*, and conflating the two is how a product ends up
    optimising for the person who does not pay.
  - Moved from `plans/phase-2/01-investigacion-icp` on 2026-08-05.

## Synthesis and decision

- [ ] **Contrastar la síntesis con Claude**
  - Files: `docs/research/phase-2/claude-critique.es.md`
  - Do: proporcionar solo hallazgos anonimizados y pedir contradicciones, segmentos solapados y preguntas
    omitidas. Etiquetar la salida como crítica LLM.
  - Verify: el documento no contiene PII y ninguna salida de Claude se presenta como evidencia.
  - Operator: takes the three findings documents as input, so it cannot run before them. Moved for that
    reason rather than because the critique itself needs a person.
  - Moved from `plans/phase-2/01-investigacion-icp` on 2026-08-05.

- [ ] **Cerrar la decisión de ICP**
  - Files: `docs/research/phase-2/icp-decision.es.md`
  - Do: definir segmento primario, secundarios, buyer, usuario, pagador, JTBD, activación, mensaje, CTA,
    objeciones y preguntas abiertas.
  - Verify: aprobación explícita de producto y marketing, y cada contradicción con la taxonomía ya
    implementada archivada como cambio a los planes de phase-2 — no absorbida en silencio.
  - Operator: an explicit product-and-marketing approval of a positioning claim. An agent must not record
    it.
  - **This task's output is now a correction, not a prerequisite.** The taxonomy
    (`hiring | investing | building | other`) ships first as a documented hypothesis; this closes the loop
    on whether it was right. `user_segment` personalises messages and priorities and never grants
    permissions, so being wrong costs a mistargeted headline rather than a boundary.
  - Moved from `plans/phase-2/01-investigacion-icp` on 2026-08-05.
