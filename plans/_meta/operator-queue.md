# Operator queue — the five phase-1 tasks an agent cannot do

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

| Plan | Task | What only a person can supply |
|------|------|-------------------------------|
| `02-production-infrastructure` | Install + verify the backup cron on the VPS | root SSH on the Hetzner VPS |
| `02-production-infrastructure` | Off-site backup copy | a ~€4/month Hetzner Storage Box subscription, plus root SSH |
| `38-work-sample` | Limit + degradation curls | a real `GITHUB_TOKEN` and `MINIMAX_API_KEY` |
| `42-stealth-scraping` | Update legal and product copy | a legal review, signed off by a person |
| `42-stealth-scraping` | Deploy dark | a production deploy and the Coolify environment |

## Why these five and not others

Seven further tasks used to sit in phase-1 and were worse than these: their definitions contained the
launch — a 14-day conversion baseline, a seven-day canary, baselines measured against a deployed
release. Those moved to [`../phase-5/01-production-readiness-audit`](../phase-5/01-production-readiness-audit/spec.md)
on 2026-07-29, because no amount of effort closes them sooner.

The five here are different: each **could** be done today by someone with the right access or the will
to spend €4. They stay in phase-1 because they are part of its outcome, and they carry `Operator:` so
that an agent walking the list knows to step over them rather than fake them.

## Priority, if you want one

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
