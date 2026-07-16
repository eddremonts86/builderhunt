// Outreach template generator. v1: rule-based, no LLM. Uses builder's
// public profile data (repos, topics, bio) to fill in a personalized
// template. v2: replace with Gemini call once we have an API key.

export type OutreachTone = 'casual' | 'professional' | 'geek'

export interface OutreachContext {
  builder: {
    username: string
    displayName?: string | null
    bio?: string | null
    topics?: string[]
    language?: string | null
    followersCount?: number
    profileUrl: string
    source: string
  }
  job: {
    title: string
    company: string
    description?: string
  }
  tone: OutreachTone
}

export interface OutreachDraft {
  subject: string
  body: string
  hookSource: string // the piece of builder data we anchored on
}

const HOOKS: Array<{
  predicate: (b: OutreachContext['builder']) => string | null
  source: string
}> = [
  {
    predicate: (b) => (b.bio && b.bio.length > 10 ? `your bio on ${b.source}: "${b.bio.slice(0, 80)}${b.bio.length > 80 ? '…' : ''}"` : null),
    source: 'bio',
  },
  {
    predicate: (b) => (b.topics?.[0] ? `your work on ${b.topics[0]}` : null),
    source: 'topic',
  },
  {
    predicate: (b) => (b.language ? `your ${b.language} work` : null),
    source: 'language',
  },
  {
    predicate: (b) => (b.followersCount && b.followersCount > 500 ? `the ${b.followersCount.toLocaleString()} developers following your work` : null),
    source: 'followers',
  },
]

function pickHook(b: OutreachContext['builder']): { hook: string; source: string } {
  for (const h of HOOKS) {
    const result = h.predicate(b)
    if (result) return { hook: result, source: h.source }
  }
  return { hook: `your recent work on ${b.source}`, source: 'fallback' }
}

const TONE_GREETINGS: Record<OutreachTone, string> = {
  casual: 'hey',
  professional: 'Hi',
  geek: 'Hey',
}

const TONE_BODY_TEMPLATES: Record<OutreachTone, (ctx: OutreachContext, hook: string) => string> = {
  casual: (ctx, hook) =>
    `${ctx.job.company} is hiring a ${ctx.job.title} and ${hook} caught my eye. ` +
    `quick context: we're building ${ctx.job.description ?? 'something in this space'} ` +
    `and looking for someone who's done the kind of work you've shipped. ` +
    `no formal process unless you want one — open to a 20-min chat?`,

  professional: (ctx, hook) =>
    `I lead hiring at ${ctx.job.company} and we're looking for a ${ctx.job.title}. ` +
    `${hook.charAt(0).toUpperCase() + hook.slice(1)} suggests you'd be a strong fit for what we're building ` +
    `(${ctx.job.description ?? 'details in the role link'}). ` +
    `Would you be open to a brief introductory conversation next week?`,

  geek: (ctx, hook) =>
    `Been digging into ${hook} and your approach is exactly the kind of thinking ` +
    `we need on the ${ctx.job.title} role at ${ctx.job.company}. ` +
    `${ctx.job.description ? `We're working on ${ctx.job.description}.` : 'The role is hands-on.'} ` +
    `Worth a 20-min technical chat to see if there's a fit?`,
}

const TONE_SUBJECTS: Record<OutreachTone, (ctx: OutreachContext) => string> = {
  casual: (ctx) => `quick question — ${ctx.job.title} at ${ctx.job.company}?`,
  professional: (ctx) => `${ctx.job.title} role at ${ctx.job.company} — interested?`,
  geek: (ctx) => `your work + a ${ctx.job.title} role`,
}

export function generateOutreach(ctx: OutreachContext): OutreachDraft {
  const { hook, source } = pickHook(ctx.builder)
  const greeting = TONE_GREETINGS[ctx.tone]
  const name = ctx.builder.displayName || ctx.builder.username
  const body = `${greeting} ${name},\n\n${TONE_BODY_TEMPLATES[ctx.tone](ctx, hook)}\n\nThanks,\nthe team at ${ctx.job.company}`
  return {
    subject: TONE_SUBJECTS[ctx.tone](ctx),
    body,
    hookSource: source,
  }
}
