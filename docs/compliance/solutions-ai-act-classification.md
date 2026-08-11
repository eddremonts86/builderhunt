# EU AI Act classification — Solutions Intelligence

**Status: assessment drafted, sign-off NOT obtained.** Written 2026-08-02. This is an engineering description
of what the system does, prepared so a lawyer has something concrete to react to. It is not legal advice and
nobody has signed it.

**Every Solutions flag defaults to `false` and stays there until a dated sign-off is recorded in the table at
the end of this document.** The reason is the same as the interview module's: if the Article 6(3) reading below
is not accepted for the human lane, the full high-risk provider and deployer obligations apply, and none of the
conformity assessment, technical documentation, or registration work exists.

## Why this document exists at all

The interview module has one of these because it is unambiguously recruitment. Solutions looks like a tool
recommender — "which model, which service, which workflow" — and a tool recommender is not in Annex III.

But Solutions has a **human lane**. It reads `canonical_humans`, retrieves real named people from public
sources, and returns them as a route: *this person can do this work*. That is close enough to the Annex III
boundary that assuming it falls outside would be a decision made by not thinking about it.

## What the system actually does

| Component | What it does | Reads | Writes |
| --- | --- | --- | --- |
| `solutions-brief-interpret` | Turns a typed description of work into structured fields | The user's own brief text | Nothing directly |
| Retrieval (`lanes.ts`) | Finds candidate components and people | `solution_component_projections`, `builder_embeddings`, `canonical_humans` | Nothing |
| Composer (`composer/*`) | Assembles up to three routes — human, AI, hybrid | Retrieved candidates, the compatibility graph, market-rate bands | Nothing |
| `solutions-route-explain` | Rewrites one composed route as prose | The route and its evidence | Nothing |
| Persistence | Stores a run **only when the user asks** | — | `solution_runs`, `solution_run_routes` |

## The Annex III question, stated honestly

Annex III point 4 covers AI in employment and worker management: recruitment or selection, in particular
targeted job advertisements, analysing and filtering applications, and **evaluating candidates** — and,
separately, systems intended to be used for making decisions affecting terms of work, promotion, termination,
**task allocation** based on individual behaviour or personal traits, and monitoring performance.

Two limbs are worth arguing about, and this document argues neither away:

**"Evaluating candidates."** The human lane surfaces named people ranked by a retrieval score against a brief.
Whether that is "evaluating candidates" depends on whether the people surfaced are *candidates* — they have not
applied for anything, and most do not know the platform exists. A reasonable reader could go either way, and
"they did not apply" is the kind of argument that sounds better in engineering than in front of a regulator.

**"Task allocation."** A recruiter reading a Solutions route is deciding who does a piece of work. If they act
on it, work has been allocated to a named person partly on the strength of a system's output. The system does
not *make* the decision, but Annex III does not require it to.

## What would support an Article 6(3) reading

Article 6(3) removes an Annex III system from high-risk where it does not pose a significant risk of harm,
including because it performs a narrow procedural task, improves the result of a previously completed human
activity, or performs a preparatory task to an assessment — and never where the system performs profiling of
natural persons.

The facts a reviewer can check, each of them structural rather than a policy someone could change quietly:

**The composer is deterministic and auditable.** No model chooses the route. Set cover, a compatibility graph
walk, arithmetic intervals, constraint comparison — `compose.ts` calls no provider. Every run records a
`compositionHash`, so the same brief against the same catalog reproduces the same routes and a stored
recommendation can be reconstructed years later.

**Nothing is scored *about a person*.** The retrieval score orders candidates for a query; it is not stored on
the person, does not accumulate, and does not exist outside the run. `canonical_humans` has no score, rating,
or ranking column. A person's row is display name, headline, country, language, and the accounts they hold.

**No profiling.** Nothing infers a trait, predicts behaviour, or evaluates personality, reliability, or
performance. The human lane matches a capability keyword against a public profile document. That is a search,
and the difference between a search and a profile is that a search forgets.

**Every route requires a person to sign off.** `humanReviewPoints` is not advisory copy: a route may only reach
`recommended` with a coverage gap if the gap is explicitly delegated to a named review step, and a route with no
person in it carries "Sign off before delivery" — enforced by the contract's own refinement, not by the prompt.

**Evidence is levelled and the level is displayed in words.** Almost everything enters at `claimed` — the
vendor's own metadata — and nothing promotes it. The UI says "Vendor's own claim, unverified by us" on every
such component, so a reader cannot mistake the platform's retrieval for the platform's endorsement.

**Explanations are checked after generation.** Citations must resolve to the route's own evidence; a currency
amount, percentage or multiple not in the composer's estimate is rejected and the deterministic text is used
instead. A model cannot introduce a claim about a person that the catalog does not support.

## What does *not* support it, and should not be glossed over

- **The people are real and named.** A route says "this person". Whatever the classification, GDPR Article 14
  applies — they did not provide the data — and the lawful basis for surfacing them commercially is a separate
  question this document does not answer.
- **`externalHumanEnabled` is the switch.** With it off, the human lane returns nothing and the whole Annex III
  argument becomes moot. With it on, it is live. That is a one-flag difference in exposure, and it deserves to
  be a deliberate decision rather than an accident of a rollout stage.
- **Article 86 (right to explanation)** applies to decisions taken on the basis of a high-risk system's output.
  If the reading below is that Solutions is high-risk, the explanation surface exists — provenance, evidence
  levels, limitations, review points — but it has not been assessed against Article 86's requirements.
- **No fundamental-rights impact assessment** has been done, and Article 27 requires one of deployers in some
  cases even where the provider's obligations are lighter.

## The narrower question, if the broad one is hard

If a full determination is slow, one narrower question unblocks the most: **may the human lane be enabled at
all, and under what conditions?** Everything else in Solutions — models, services, tools, MCP servers — is a
recommendation about software and is not in Annex III on any reading.

Shipping with `SOLUTIONS_EXTERNAL_HUMAN_ENABLED=false` is a coherent product: the AI and hybrid lanes still
work, and the human lane reports itself unavailable with a reason. That is the fallback if the answer is slow
or negative.

## Sign-off

Nothing here is signed. The table stays empty until a named person with the standing to make the call fills it
in.

| Question | Determination | Reviewer | Date |
| --- | --- | --- | --- |
| Is Solutions an Annex III point 4 system? | — | — | — |
| If yes, does Article 6(3) apply? | — | — | — |
| May the human lane be enabled? | — | — | — |
| Is a fundamental-rights impact assessment required? | — | — | — |

Related: `docs/operations/solutions-security-review.md` (open item 2),
`plans/implemented/43-solutions-intelligence/tasks.md` (Phase 7),
`docs/compliance/interview-ai-act-classification.md` (the same exercise for the interview module).
