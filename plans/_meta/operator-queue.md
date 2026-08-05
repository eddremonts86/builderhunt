# Operator queue — the phase-1 tasks an agent cannot do (superseded)

> **Superseded 2026-08-05. This file describes a problem that no longer exists.**
>
> Phase-1 has **zero open tasks**. Three of the five below were closed, and the last two — the enrichment
> legal review and its production deploy — moved to `plans/phase-5/` with the other 19 non-engineering
> items, on Edd's instruction that the product launches when phase-5 finishes. The operator queue for the
> launch is now [`../phase-5/README.md`](../phase-5/README.md) and the three plans it lists.
>
> Kept because **the rule below is the durable part** and it applies to any future plan: a task carrying an
> `Operator:` line is skipped, left unchecked, and reported — never checked because "the code part is done".
> The five-item table is history.
>
> **Reconciled earlier on 2026-08-05: three of the five below are closed.** The two `02-production-infrastructure`
> items (backup cron, off-site copy) are checked, and `38-work-sample`'s "Limit + degradation curls"
> closed with mocked unit coverage. **Two remain, both in `42-stealth-scraping`**: the legal review and
> the production deploy. The table is kept whole because its *rule* is the point and the priority
> ordering still reads correctly; the closed rows are marked below rather than deleted.
>
> Wider context, since this file's title implies it is the whole list of what a person must do: it is
> not, and never was. It covers only tasks carrying an `Operator:` line. As of 2026-08-05 **all 21 open
> phase-1 tasks** need a person, a credential, a signature, or elapsed time — the launch channels, the
> DPIA, provider pricing, publishing, and two clock waits. See
> [`phase-1-queue.md`](./phase-1-queue.md) for that count.

Phase 1 is meant to be executed top to bottom by an agent without stopping to ask anything. Five
tasks make that impossible on their own terms: they need a credential, a payment, a signature, or
shell access to a machine. They are not hard — they are **not the agent's to do**.

## The rule

An agent that reaches a task carrying an `Operator:` line **skips it, leaves the box unchecked, and
records it in its final report**. It does not ask, does not wait, and above all does not check the box
because "the code part is done". Everything else in the plan continues; none of these five blocks a
later task.

That is the whole protocol. Nothing in phase-1 should ever make an agent stop and wait for an answer.

## The five

| Plan | Task | What only a person can supply | Status |
|------|------|-------------------------------|--------|
| `02-production-infrastructure` | Install + verify the backup cron on the VPS | root SSH on the Hetzner VPS | ✅ closed |
| `02-production-infrastructure` | Off-site backup copy | a ~€4/month Hetzner Storage Box subscription, plus root SSH | ✅ closed |
| `38-work-sample` | Limit + degradation curls | a real `GITHUB_TOKEN` and `MINIMAX_API_KEY` | ✅ closed (mocked unit coverage) |
| `42-stealth-scraping` | Update legal and product copy | a legal review, signed off by a person | ➡️ moved to [`phase-5/02`](../phase-5/02-legal-and-commercial-approvals/tasks.md) |
| `42-stealth-scraping` | Deploy dark | a production deploy and the Coolify environment | ➡️ moved to [`phase-5/01`](../phase-5/01-production-readiness-audit/tasks.md) |

## Why these five and not others

Seven further tasks used to sit in phase-1 and were worse than these: their definitions contained the
launch — a 14-day conversion baseline, a seven-day canary, baselines measured against a deployed
release. Those moved to [`../phase-5/01-production-readiness-audit`](../phase-5/01-production-readiness-audit/spec.md)
on 2026-07-29, because no amount of effort closes them sooner.

The five here were different: each **could** be done today by someone with the right access or the will to
spend €4, so they stayed in phase-1 as part of its outcome.

**That distinction did not survive contact with the question "is phase-1 done?".** On 2026-08-05 the same
reasoning was extended to its conclusion: an item that needs a signature or a deploy is not build-phase work
whether or not somebody *could* do it this afternoon, because phase-1's bar is "every piece of work done" and
a signature is not work. The last two moved out with the other nineteen.

## Priority, if you want one — as it stood before the move

1. **The off-site backup** (`02`). `docs/operations/external-services-register.md` §7 frames it as the
   gate before real candidate data, and phase-1 contains interviews, which store CVs and transcripts.
   It is €4/month and it is the only item here whose absence can lose data that belongs to a person.
   Note the contradiction to settle first: `docs/runbook.md` §3 already lists the 03:30 off-site rsync
   under "What runs today", while §7 marks the Storage Box `⬜ outstanding`. One of the two is wrong,
   and until you know which, you do not know whether backups leave the machine.
2. **The legal review** (`42`). Enrichment cannot be enabled without it, and it gates the canary in
   phase-5, so it is on the critical path to leaving Beta.
3. **The two API keys** (`38`). Cheap, and they unblock a verification pass that is otherwise
   unreachable.
4. **The backup cron** (`02`) and **deploy dark** (`42`) both need production access and naturally
   pair with your next deploy.
