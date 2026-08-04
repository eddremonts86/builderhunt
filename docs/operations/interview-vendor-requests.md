# The two vendor statements — draft requests

Two items in [`interview-provider-register.md`](./interview-provider-register.md) §5 gate production voice, and
both are things only the vendor can supply. **I cannot obtain either** — they are support requests from the
account holder. What I can do is remove the writing from the task, so each is a copy-paste.

Both drafts ask for something **specific and quotable**, not reassurance. That is deliberate: the register's
finding is that Deepgram's public compliance page "says nothing about retention or training", so a reply
saying "we take privacy seriously" would leave the position exactly where it is. What is needed is a sentence
that can be cited inside a DPIA and shown to a candidate.

---

## 1. Deepgram — no-training / no-retention statement

**Why it matters, restated so the request does not feel like paperwork:** the register records that on
2026-07-26 this was *accepted by the product owner without a written vendor statement* — nothing obtained,
their compliance page silent, no console setting that could stand in. So any promise made to a candidate
about their interview audio not being retained or used for training is currently **unbacked**. That is the
gap, and it is the reason to ask.

**Send to**: Deepgram support / the account's success contact
**From**: the account owner (`eduardo.inerarte@gmail.com's Project`)
**Ask for**: a written reply that can be quoted, not a link to a policy page

> Subject: Written confirmation of retention and training policy for pay-as-you-go EU inference
>
> Hello,
>
> I run a small product that will use Deepgram to transcribe job interviews. Because the speakers are job
> candidates rather than our own users, I have to document exactly what happens to their audio before I can
> enable the feature, and I would like to quote your answer in that documentation.
>
> Our setup: pay-as-you-go, `nova-3`, requests to `https://api.eu.deepgram.com/v1/listen`, with `diarize` and
> `multichannel` in use.
>
> Could you confirm in writing, specifically for that configuration:
>
> 1. **Retention.** Is submitted audio retained after the transcription response is returned? If so, for how
>    long, and where? If it is not retained, please say so explicitly.
> 2. **Training.** Is submitted audio, or the resulting transcript, used to train or improve any model? If
>    there is a difference between pay-as-you-go and enterprise agreements on this point, please say which
>    applies to us.
> 3. **Residency.** For requests to the EU host, does processing and any incidental storage stay within the
>    EU? Your compliance page covers certifications but does not address this directly.
> 4. **DPA.** How do I get a Data Processing Agreement signed for this account? We do not have one yet, and I
>    need it in place before processing candidate audio.
>
> I am not looking for a link to a general policy — I need something specific enough to cite. If any of the
> above requires an enterprise plan, I would rather know that plainly than assume the default is favourable.
>
> Thank you,
> Eduardo Inerarte

**When the reply arrives**: record it verbatim in register §3 under "No-training / no-retention confirmation",
replacing the accepted-without-evidence note, and update DPIA §6.2 and §5.4. **If the answer is that audio
*is* retained or used for training**, that is not a blocker to record and move past — it changes what the
consent text may claim, and §5.4 becomes a live problem rather than a documentation one.

---

## 2. Mistral — Zero Data Retention

**Status in the register**: "not self-serve in this panel; it is a support/sales request." So this is a ticket,
not a checkbox.

**Send to**: Mistral support (La Plateforme) or the sales contact for the organization
**Account**: organization `Eduardo Inerarte`, org id `d895462e-bcd5-40de-b8a8-46e59197f65b`
**Ask for**: ZDR enabled, plus written confirmation of what it covers

> Subject: Zero Data Retention request — org d895462e-bcd5-40de-b8a8-46e59197f65b
>
> Hello,
>
> I would like to enable Zero Data Retention for our organization. We use La Plateforme to generate
> structured summaries from job-interview transcripts, so the prompts contain personal data belonging to
> people who are not our users — job candidates. I need to be able to state in our data-protection
> documentation what happens to that content.
>
> Our setup: `mistral-medium-2604`, EU endpoint (`https://api.mistral.ai`), API only — not Le Chat.
>
> Could you:
>
> 1. **Enable Zero Data Retention** for the organization above, and confirm the date it takes effect.
> 2. Confirm **what ZDR covers** — prompts, completions, or both — and whether anything is retained
>    regardless (abuse-monitoring logs, for example, and if so for how long).
> 3. Confirm that with ZDR active, **no submitted content is used for training or model improvement**.
> 4. Point me to the **DPA** that applies, or countersign one if that is the process.
>
> If ZDR requires a specific plan or a minimum commitment, please tell me what it is rather than leaving the
> request open — I would rather adjust than wait.
>
> Thank you,
> Eduardo Inerarte

**When it is enabled**: record the effective date and the coverage answer in register §4 under "Zero Data
Retention", and update DPIA §6.2. **Note what to watch for**: if ZDR excludes abuse-monitoring logs — a common
carve-out — that is still a retention window and belongs in DPIA §2.4 rather than being rounded to "nothing is
retained".

---

## What stays open regardless of the replies

Both of these close §6.2 of the DPIA. Neither touches its highest-rated risk: **§5.1, special-category data
that candidates volunteer and verbatim transcription captures.** No vendor statement helps with that; it needs
a product decision from the four options in DPIA §6.3. Worth keeping the two apart so a pair of good vendor
replies does not read as the DPIA being finished.

---

*Drafted 2026-08-04. Account identifiers and configuration details are taken from
`interview-provider-register.md` §3 and §4; no credential values appear here.*
