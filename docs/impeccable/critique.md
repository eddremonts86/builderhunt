# Impeccable critique — BuilderHunt

- Generated: 2026-08-07 (Phase 1)
- Surface scope: 5 core screens — `/`, `/builders/:builderId`, `/dashboard`, `/admin/metrics`, `/interviews/:interviewId/live`
- Source of truth: live browse at http://localhost:3010 + source read of `src/routes/_landing/index.tsx`, `src/routes/builders/$builderId.tsx`, `src/routes/_dashboard/dashboard/index.tsx`, `src/routes/_dashboard/admin/metrics.tsx`, `src/routes/_dashboard/interviews/$interviewId/live.tsx` + design system `DESIGN.md`

## ⚠️ DEGRADED: single-context (sub-agent spawn failed: HTTP 429 Token Plan rate limit)

Impeccable critique mandates two independent assessments, ideally run as parallel sub-agents in
isolated contexts (Assessment A = design review, Assessment B = detector / browser evidence). On
this run both sub-agent fan-outs failed with HTTP 429 from the model API, and the critique was
completed sequentially in this single context. The detector script (`detect.mjs`) was attempted
but requires `puppeteer` which is not installed in this environment, so Assessment B is also
reduced to inline browser inspection via the standard browser tools. The findings below carry
that caveat: independent verification of every claim should be re-run in a future critique pass
once the rate limit window clears.

**Status: degraded but produced.** Do not re-run mechanically; treat the scores as directional.

---

## Scope (5 surfaces, with visitor mode per Impeccable v4)

| Surface | Path | Mode | Persona |
| --- | --- | --- | --- |
| Landing | `/` | Persuade | First-time visitor evaluating the product |
| Builder profile | `/builders/:builderId` | Experience | Recruiter / founder scanning a single person |
| Dashboard | `/dashboard` | Operate | Member returning to do work |
| Admin metrics | `/admin/metrics` | Operate (privileged) | Platform-admin observing platform health |
| Interview live | `/interviews/:interviewId/live` | Operate (in-flow) | Interviewer mid-session |

---

## Assessment A — Design Review

### Design specificity (could an unrelated product use this unchanged?)

**Verdict: yes, mostly — and that is the bug.**

Concrete evidence from the live landing snapshot:

- **Hero copy** — "Find builders, not just repos." — is product-specific. Good.
- **Theme toggle as a `radiogroup`** — semantic ✅.
- **Skip link present** ✅.
- **Footer has 4 nav columns** (Product / Trust / Account / Legal) with reasonable structure ✅.
- **Cookie consent dialog** present at first paint — but it appears over the hero before the visitor has read anything. That's standard but feels premature.
- **"Discover" and "Learn" and "Trust" mega-menu buttons** — these are the second-tier nav and they are collapsed (button with `aria-expanded`) — discoverability cost for first-time visitors who don't know the labels map to anything.

The specificity weakens on:

- The hero feature panels ("Multi-source discovery", "Recency-weighted scoring", "Keyword alerts", "Private notes", "CSV / JSON export", "No tracking, no spam") are 6 generic feature pills with `lucide-react` icons. The icons and copy could be lifted into any "data SaaS" landing. The product's actual differentiator — **activity scoring, signal freshness, builder-as-actor (not repo-as-actor)** — is buried in a body paragraph under the hero, not promoted into the hero or above the fold of the feature grid.
- The "Who it's for" section has 4 tab buttons (Open-source maintainers / Founders / Recruiters / DevRel). The tab copy is fine; the panel content is also fine but visually undifferentiated between tabs. Persona-specific proof is missing — no persona-specific screenshot, no persona-specific stat.

### Holistic design — hierarchy, IA, emotional fit, composition, typography, color

**Composition.** Landing scrolls through ~9 sections (hero / how / features / who / sources / FAQ / CTA / footer). That is long for a first-touch. Mid-page sections (How it works, Features) compete for attention with the hero's primary CTA.

**Hierarchy.** H1 is set; H2/H3 ramp correctly. **But** the "Public beta · Free plan, no credit card" badge sits above the H1 as small caps, and visually it has more weight than the supporting paragraph below the H1 (because the badge is short and the paragraph is dense). First-touch visitors may not register the H1 because the badge and the supporting paragraph fight for the same horizontal space.

**Typography.** Inter for body, JetBrains Mono for label accents (noted in DESIGN.md as `label`). I see the mono treatment on the eyebrow labels (e.g., "AGGREGATING ACTIVITY FROM THE PLATFORMS BUILDERS ALREADY USE"). This is on-brand and consistent. No off-ramp detected.

**Color.** Token-driven (`--color-bh-*`). The terracotta accent appears in the CTA, the badge dot, and the active-source icons. Consistent.

**Density.** Mid-page is dense — feature cards are 6 across in a row at 1280px which compresses copy. Acceptable on desktop; risky on tablet/mobile (no mobile capture exists, see F11).

**Emotional fit.** Warm-premium as DESIGN.md claims. The terracotta + cream is doing the work. The supporting paragraph copy is competent. The first-touch does not telegraph "premium" in the same way a "we have a story to tell" page would — the source list with "+ 11 more sources" is doing signal-of-breadth work that feels like breadth-marketing rather than curation.

### Cognitive load

- Hero presents 2 CTAs side by side ("Start hunting" + "Try it without an account") plus a tertiary text link ("See how it works"). 3 choices at the moment of decision. **Above the 4-option soft cap** (no it's below), but the question is: do those 2 CTAs lead to the same place, or different? "Start hunting" goes to sign-up; "Try it without an account" goes to `/explore`. Different destinations, both with similar visual weight. First-time visitors may oscillate.
- The persona tabs at "Who it's for" are 4 visible options — at the cap. Each tab reveals 5 bullet points. Reasonable for the content, but each panel does not pre-answer "why me specifically" the way a persona-tailored screenshot would.
- Footer has 4 columns × 5-6 links each = 20+ secondary destinations from the landing alone. This is normal for a SaaS landing but it raises the cognitive cost of "where do I start".

### Emotional journey

- **Peak**: hero CTA bar ("Start hunting" / "Try it without an account") and the closing CTA bar ("Create free account" / "I already have an account"). Both are clean.
- **Valley**: the "How it works" middle section. Three steps with copy that doesn't show product surface. Visitor who clicked past the hero and lands here has to re-imagine what the product looks like to evaluate the steps. No screenshot in this section.
- **Reassurance at high-stakes moments**: present — "No credit card" badge, "Free plan", FAQ covers pricing and tokens.

### Nielsen 10 heuristics — scorecard

| # | Heuristic | Score (0–4) | Note |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Theme toggle, "Sign in" / "Get started" CTAs visible. "Public beta" badge honest. |
| 2 | Match between system and real world | 3 | Persona copy ("builders", "shortlist", "hunt") matches user vocabulary. |
| 3 | User control and freedom | 3 | Skip link, theme toggle, persona tabs are reversible. |
| 4 | Consistency and standards | 3 | Token system, single icon family (lucide), single CTA idiom. |
| 5 | Error prevention | n/a | No forms in landing copy. |
| 6 | Recognition rather than recall | 2 | Mid-page "How it works" requires the visitor to remember what the product is; no in-section screenshot. |
| 7 | Flexibility and efficiency of use | 2 | Persona tabs help some, but a "skip to my use case" jump is not surfaced. |
| 8 | Aesthetic and minimalist design | 2 | 9 sections is long; the "Who it's for" + "Features" + "Sources" mid-block competes. |
| 9 | Help users recognize, diagnose, recover from errors | n/a | No error surface on landing. |
| 10 | Help and documentation | 3 | FAQ accordion present. |

**Average over applicable: 2.6/4. Acceptable, not strong.**

---

### Per-surface design review

#### `/` landing — score: 2.5/4 (acceptable, not strong)

- **Strengths:** theme toggle as radiogroup (semantic), skip link, persona tabs, FAQ accordion, terracotta + cream consistent, honest "Public beta" badge.
- **Weaknesses:** hero secondary CTA ("Try it without an account") competes with primary ("Start hunting") for the same first-click decision. Mid-page sections ("How it works", "Features") feel generic. The actual differentiator — activity scoring + builder-as-actor framing — is buried in the hero paragraph.
- **Repair verbs:** `clarify` (CTA hierarchy + copy), `distill` (collapse redundant sections), `layout` (mid-page rhythm).

#### `/builders/:builderId` — score: deferred (no real ID in seed; walker can't reach a populated profile)

- I did not browse this surface live (no test ID resolves to a populated builder). Source review only: structure exists, no obvious drift.
- **Repair verbs:** none raised from source review alone; revisit with a real builder ID.

#### `/dashboard` — score: 3/4 (good; structured but dense)

- Saw the layout earlier in this session via the walker fix. 60-px rail + 212-px panel + canvas. Numbers heroed. Breadcrumb + area rail working.
- **Weaknesses (from prior session notes):** the widget order was decided at runtime, and the activity chart measured something else (commit `ab4ea67b1` fixed this) — but the per-widget empty/loading states are still unknown to this critique.
- **Repair verbs:** `onboard` (empty-state coverage), `clarify` (widget copy), `layout` (canvas rhythm).

#### `/admin/metrics` — score: 3/4 (good; operator-centric)

- Same operational dashboard shape; metrics-centric; healthy telemetry.
- **Weaknesses:** in-pass observation that an in-process counter was labelled without its scope (commit `2b0aa726d` addressed this) — copy now consistent. Further critique deferred to a populated run.
- **Repair verbs:** `clarify` (counter labels), `onboard` (empty-state for a quiet platform).

#### `/interviews/:interviewId/live` — score: 3/4 (good; in-flow console)

- Live console pattern; the walker confirmed it renders 200 across roles. Mid-pass deeper review not done in this critique.
- **Repair verbs:** `harden` (the live-session error paths), `optimize` (re-render hot loop on segment append — already rate-limited per `SEGMENT_WRITE_LIMIT`).

---

## Persona walks

### Persona 1 — "Marta", a recruiter, lands on `/` from a Hacker News thread

**Path:** HN thread → `/` → hero → "Try it without an account" → `/explore` → ?

- **Success at hero:** "Find builders, not just repos." lands the value prop cleanly. Persona-tab discovery is one extra click — Marta may not realise the tabs exist.
- **Stall:** hero secondary CTA naming. "Try it without an account" implies an anonymous browse; `/explore` exists and is reachable. Worth A/B testing the CTA copy ("Browse builders" vs current).
- **Drop-off risk:** mid-page — Marta scrolls past hero, sees 3 generic steps, no product screenshot in that section, may bounce. The persona tab ("Recruiters & talent partners") holds the only recruiter-specific copy, and it's at section 4.

**Repair verbs:** `clarify`, `layout`, `distill`.

### Persona 2 — "Hugo", an open-source maintainer, returns to `/dashboard` after a week away

**Path:** email alert → `/dashboard` → overview widget → sprint queue → ?

- **Success at dashboard:** the area rail + breadcrumb makes the IA legible without tutorial.
- **Stall:** the canvas is wide and dense; "active sprint", "alerts inbox", "recent activity" all compete for the first second of attention. With no first-screen persona signal, the visitor's eye lands on the biggest number, not the most-relevant number.
- **Drop-off risk:** if the most-relevant widget is below the fold or collapsed, Hugo may not find his sprint and bounce to the email alert instead.

**Repair verbs:** `onboard`, `clarify`, `layout`.

### Persona 3 — "Admin Priya", platform-admin, opens `/admin/metrics` mid-incident

**Path:** alert → `/admin/metrics` → counter → drill-down → ?

- **Success:** the operator-centric layout matches the persona's mental model — counters, status, trend lines.
- **Stall:** if a counter is in its "in-process" state without a label, Priya can't act. The pre-fix copy was unclear (commit `2b0aa726d` addressed this). Re-verify on a populated run.

**Repair verbs:** `clarify`, `harden`.

---

## Assessment B — Detector / browser evidence

**Skipped.** `node /Users/edd/.claude/skills/impeccable/scripts/detect.mjs --json http://localhost:3010/` failed:

```
Error: puppeteer is required for URL scanning. Install: npm install puppeteer
```

puppeteer is not in this environment's npm tree and adding it would require a separate install. The detector runs as a separate concern (it is independent of design judgment) and is part of Phase 3 verification, not Phase 1 critique. Re-run during the polish / verification phase when a real browser test rig is available.

**What I did instead (inline browser):**

- `browser_navigate http://localhost:3010/` → snapshot shows: theme radiogroup (default dark), skip link present, primary nav with 3 mega-menu buttons + theme radios + Sign in / Get started CTAs, hero with H1 + supporting paragraph + 2 CTAs + 1 tertiary link, 6 feature panels, 4 persona tabs, 6 source pills, 6-question FAQ accordion, closing CTA bar, 4-column footer, cookie consent dialog at first paint.
- No console errors observed in this snapshot.

**Static source review:**

- 6 occurrences of `onClick` on `<Button>` elements across `src/routes/_landing/`. All are real buttons (not divs-as-buttons). No `onClick` on a non-interactive element. ✅
- 0 hard-coded hex colors in `src/routes/_landing/`. ✅ token system honoured.
- 0 arbitrary `w-[NNNpx]` / `h-[NNNpx]` fixed widths in `src/routes/_landing/`. ✅ fluid layouts.

---

## Consolidated P0–P3 findings

| id | sev | surface | file:line | symptom | verb | mech/decision |
|---|---|---|---|---|---|---|
| C1 | P1 | `/` hero | `src/routes/_landing/index.tsx` (CTAs row) | Two CTAs ("Start hunting" + "Try it without an account") have equal visual weight; both compete for the same first-click decision. "Try it without an account" implies anonymous browse — copy and intent should align. | clarify | mechanical |
| C2 | P1 | `/` mid-page | `src/routes/_landing/index.tsx` (~lines around "How it works" section) | "How it works" section describes 3 steps in text without a product screenshot in that section. Recognition-not-recall gap (Nielsen #6). | layout | decision |
| C3 | P1 | `/` mid-page | `src/routes/_landing/index.tsx` | Landing has ~9 sections; "How it works" + "Features" + "Sources" mid-block compete for attention. Visual density at 1280px compresses the 6-feature grid; copy is short but the rhythm is busy. | distill | decision |
| C4 | P1 | `/` mid-page | `src/routes/_landing/index.tsx` (persona tabs) | Persona tabs (4) are visually undifferentiated between panels. Persona-specific proof (screenshot, stat) is absent — the panels are 5 bullets each. | layout | decision |
| C5 | P1 | `/` hero paragraph | `src/routes/_landing/index.tsx` (paragraph under H1) | The actual product differentiator (activity scoring + builder-as-actor) is in the supporting paragraph under the H1, not promoted above the fold of the feature grid. | clarify | decision |
| C6 | P1 | `/` (mobile) | mobile capture not run | Landing's 6-feature grid and 4-column footer untested at 375 px. | adapt | mechanical (capture) |
| C7 | P1 | `/dashboard` | `src/routes/_dashboard/dashboard/index.tsx` | Widget order/priority signal not visible to a returning member without a tutorial. First-screen widget may not be the persona-relevant one. | onboard | decision |
| C8 | P2 | `/dashboard` (states) | empty / loading / permission states not yet captured | Walker captured default render; loading skeletons, empty-list and 403-widget states unknown. | onboard + clarify | mechanical (capture) |
| C9 | P2 | `/admin/metrics` (states) | empty / degraded states not yet captured | Operator-facing dashboard needs explicit "platform is healthy" + "platform is degraded" + "no data yet" states. | onboard | decision |
| C10 | P2 | `/interviews/:interviewId/live` (error paths) | live console error recovery | A failed segment append during a live interview must show an in-session retry path, not a silent toast. | harden | decision |
| C11 | P2 | whole app | copy + error message audit | Forms (sign-up, forgot, reset, billing, remove-profile), 404 page, 403 flash copy, 429 toasts, error boundary copy — not systematically audited. | clarify | decision |
| C12 | P2 | whole app | slop catalog pass | emoji-as-icon, off-token colours, gradient overuse, mixed icon families — not yet evaluated against the existing screenshots. | clarify + distill | decision |
| C13 | P3 | `/admin/metrics` | counter labels | Even after the in-process counter fix (commit `2b0aa726d`), a populated walk should re-verify copy in-context. | clarify | mechanical |
| C14 | P3 | walker harness | `scripts/audit/saas-review-walk.ts` | Add dev-only filter so `client-rpc/serverFnFetcher` errors are not counted as product bugs (closes saas-review F7 cleanly). | harden | mechanical |
| C15 | P3 | walker harness | `scripts/audit/saas-review-walk.ts` | Turn on `SAAS_REVIEW_VIEWPORTS=both` so dark + mobile + tablet become baseline. | adapt | mechanical |

(15 entries; C2–C5 require product / aesthetic decisions and should NOT be auto-applied.)

## Cross-cutting patterns

- **Landing length.** 9 sections is one too many for a first-touch Persuade surface. Distill or trim.
- **Persona proof is generic.** The "Who it's for" section is structurally correct but visually underpowered — no persona-specific artifact differentiates one tab from another.
- **States audit gap.** Walker doesn't capture empty / loading / error / permission; no UI critique can be confident about state coverage without a separate harness. Listed in F12 of the audit; repeated here.
- **Sub-agent budget.** Two parallel sub-agent fan-outs (3 tasks each) failed on HTTP 429 in this session. Future critiques should plan for either fewer parallel tasks or fall back to a sequential single-context run with the DEGRADED banner — which is what produced this report.

## Recommended actions

1. **Phase 2 P0/P1 first:** `clarify` (C1, C5), `distill` (C3), `layout` (C2, C4), `onboard` (C7), `adapt` (C6 — needs walker harness change first).
2. **Phase 2 P2:** `onboard` + `clarify` (C8, C9, C10, C11, C12).
3. **Phase 2 P3 (mechanical):** `harden` (C14), `adapt` (C15).
4. **Phase 3:** `/impeccable polish` after P1 closes; `/impeccable document` to keep `DESIGN.md` and the visual-system record current.

## Out of scope this pass

- Pixel-level visual hierarchy judgment on the 280 existing screenshots — captured, not judged.
- Dark mode contrast walk (walker used `desktop-light` only).
- Mobile (375 px) + tablet capture.
- State coverage (empty / loading / error / permission).
- Slop catalog pass.
- Funnel / data trust / activation metrics.
