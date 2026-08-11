# Phase 1 — implementation queue

A dated snapshot of every `plans/phase-1/*` plan, ordered easiest → hardest, so a
session can pick up work without re-reading 54 `tasks.md` files.

This file answers "what can I pick up next". [`phase-1-order.md`](./phase-1-order.md) answers
the different question "in what sequence would all 54 be built from nothing" — that is where
each plan's `NN-` directory prefix comes from, and its counts are newer than the ones below
(regenerated 2026-07-28: `calendar-scheduling-interview-intelligence` is 9 open / 69 done, not
47/32; `audit-performance-qa` 1/9, not 7/4; `audit-visual-system` 2/8, not 3/7;
`exhaustive-local-e2e-design` 10/3, not 12/0). Plan names below are written without their
number prefix; the directories on disk carry it.

**Snapshot: 2026-08-05 (final). Phase 1 has ZERO open tasks.** 54 plans, 759 done, **0 open**.

The 21 that were open earlier that day all moved to `plans/phase-5/` on Edd's instruction — *the product
launches when phase-5 finishes, so there is no point worrying about legal in phase-1.* Not one of them was
engineering: the last task in phase-1 that was, `42-stealth-scraping`'s runtime adversarial matrix, closed
the same day at 20/20 and found five defects on the way, all fixed.

Where they went, by who owns the missing input:

| Destination | Items | Waits on |
|-------------|------:|----------|
| [`phase-5/01-production-readiness-audit`](../phase-5/01-production-readiness-audit/tasks.md) | 7 | a live deployment, a clock, or a person with a browser |
| [`phase-5/02-legal-and-commercial-approvals`](../phase-5/02-legal-and-commercial-approvals/tasks.md) | 4 | a signature, a licensed opinion, a vendor's price |
| [`phase-5/03-launch-and-distribution`](../phase-5/03-launch-and-distribution/tasks.md) | 9 | the launch itself, then 30 days of it |

(21 left, 20 arrived: two plans described cross-posting twice and it is one task now.)

Each phase-1 plan keeps a prose pointer where its checkbox was — deliberately **not** a checkbox, since a
box reads as pending engineering to anyone walking the file, which is the whole failure this restructuring
fixes. The evidence gathered while verifying their prerequisites stays in phase-1 too, because that part
was real work: OG tags, the 13 public routes, semantic-ordering parity across the pg16→pg18 cutover, the
provider register, the adversarial matrix.

**So: a session picking up phase-1 for code should find nothing.** Next work is phase-2 and beyond, or the
four open findings in
[`../../docs/operations/public-enrichment-source-register.md`](../../docs/operations/public-enrichment-source-register.md)
— decisions waiting for the maintainer, deliberately not checkboxes either.

**Earlier snapshot: 2026-08-03.** 723 done, 58 open — kept for the trajectory: 58 open on 3 August, 22 on
5 August after two sessions of real work, 0 that evening once the 21 non-engineering items were moved to
where they belong.

Counts are `- [ ]` / `- [x]` lines in each plan's checklist. Regenerate with:

```bash
for f in plans/phase-1/*/tasks.md plans/implemented/phase-1/42-stealth-scraping/task.md; do
  p=$(basename $(dirname "$f"))
  o=$(grep -c "^- \[ \]" "$f" || true); d=$(grep -c "^- \[x\]" "$f" || true)
  printf "%3s|%3s|%s\n" "${o:-0}" "${d:-0}" "$p"
done | sort -t'|' -k1 -rn
```

Note `stealth-scraping` uses `task.md` (singular) and `implementation_plan.md` instead of the
`spec.md`/`plan.md`/`tasks.md` trio every other plan follows. The previous snapshot's one-liner
globbed only `tasks.md`, so that plan's 9 open items were invisible in every count. The command
above includes it explicitly; renaming the file is the real fix.

## History

Every table that used to follow — an "actionable queue", a blocked list, and a full per-plan count —
described a backlog that no longer exists. They were removed on 2026-08-05 rather than annotated,
because their top section was literally headed *"Actionable queue (work these in order)"* and listed
five plans with open counts. Left in place under a "these numbers are stale" preamble, that is a trap:
the reader who skims to the table starts work that has already moved to phase-5, and the preamble is
the part people skip.

The counts themselves are recoverable from git history if anyone needs the shape of the backlog on a
given date. What is worth keeping is the ordering *rationale*, and that lives in
[`phase-1-order.md`](./phase-1-order.md), which answers the durable question — in what sequence would
these 54 plans be built from an empty repository — rather than the expired one.
