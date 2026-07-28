/**
 * The list is the page that did not exist, and its whole job is telling an organizer what they can do with
 * each interview right now. So the assertions are about which links appear — a "Start" link on an interview
 * that has not begun, or a missing one on an interview that is live, is the difference between a usable page
 * and going back to typing uuids.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  InterviewList,
  JOIN_WINDOW_AFTER_MS,
  JOIN_WINDOW_BEFORE_MS,
  type InterviewListRowView,
} from '~/modules/interviews/components/InterviewList'

vi.mock('@tanstack/react-router', () => ({
  // The real Link needs a router context this component does not otherwise require. Rendered as an anchor
  // with the resolved path, which is exactly what the assertions care about.
  Link: (props: { to: string; params?: Record<string, string>; children: React.ReactNode; className?: string }) => {
    const href = Object.entries(props.params ?? {})
      .reduce((path, [key, value]) => path.replace(`$${key}`, value), props.to)
    return <a href={href} className={props.className}>{props.children}</a>
  },
}))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let container: HTMLDivElement | null = null
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  container = null
  root = null
})

const text = () => container?.textContent ?? ''
const links = () => [...(container?.querySelectorAll('a') ?? [])]
const linkNamed = (pattern: RegExp) => links().find((link) => pattern.test(link.textContent ?? ''))

const NOW = new Date('2027-12-05T10:00:00.000Z').getTime()

const interview = (overrides: Partial<InterviewListRowView> = {}): InterviewListRowView => ({
  eventId: 'event-1',
  roleTitle: 'Staff Engineer',
  candidateDisplayName: 'Casey Candidate',
  startsAt: '2027-12-05T10:30:00.000Z',
  endsAt: '2027-12-05T11:15:00.000Z',
  timezone: 'UTC',
  modality: 'remote_call',
  meetingUrl: 'https://meet.example.test/room',
  location: null,
  eventStatus: 'scheduled',
  sessionState: null,
  hasBrief: true,
  reportStatus: null,
  transcriptSegments: 0,
  ...overrides,
})

const render = (interviews: InterviewListRowView[]) =>
  act(() => { root?.render(<InterviewList interviews={interviews} now={() => NOW} />) })

describe('the empty state', () => {
  it('names what creates an interview', () => {
    render([])
    // "No interviews" alone leaves someone wondering whether the feature is broken or whether they have not
    // done the thing that creates one.
    expect(text()).toMatch(/once a candidate books one of your invitations/i)
    expect(text()).toMatch(/Send an invitation/i)
  })
})

describe('each row', () => {
  it('leads with the candidate and the role', () => {
    render([interview()])
    // The organizer is looking for a person, not a uuid.
    expect(text()).toMatch(/Casey Candidate · Staff Engineer/)
  })

  it('falls back to "Candidate" when no name was submitted', () => {
    render([interview({ candidateDisplayName: null })])
    expect(text()).toMatch(/Candidate · Staff Engineer/)
  })

  it('always links to the brief, and says when there is none to read', () => {
    render([interview({ hasBrief: true })])
    expect(linkNamed(/^\s*Brief\s*$/)?.getAttribute('href')).toBe('/interviews/event-1')

    render([interview({ hasBrief: false })])
    // Different words, same destination: the page is where you *make* one.
    expect(linkNamed(/Prepare a brief/)?.getAttribute('href')).toBe('/interviews/event-1')
  })

  it('links to the live workspace inside the interview window', () => {
    // Thirty minutes before the start, comfortably inside the one-hour lead. The lead is an hour because
    // setting up a tab share and checking a microphone takes real time.
    render([interview()])
    expect(linkNamed(/Start/)?.getAttribute('href')).toBe('/interviews/event-1/live')
  })

  it('offers it right at the edge of the lead and not a minute before', () => {
    const startsAt = new Date(NOW + JOIN_WINDOW_BEFORE_MS).toISOString()
    render([interview({ startsAt, endsAt: new Date(NOW + JOIN_WINDOW_BEFORE_MS + 2_700_000).toISOString() })])
    expect(linkNamed(/Start/)).toBeDefined()

    const justOutside = new Date(NOW + JOIN_WINDOW_BEFORE_MS + 60_000).toISOString()
    render([interview({ startsAt: justOutside, endsAt: new Date(NOW + JOIN_WINDOW_BEFORE_MS + 2_760_000).toISOString() })])
    expect(linkNamed(/Start/)).toBeUndefined()
  })

  it('keeps it past the scheduled end, because interviews run over', () => {
    const endsAt = new Date(NOW - JOIN_WINDOW_AFTER_MS + 60_000).toISOString()
    render([interview({ startsAt: new Date(NOW - 3_600_000).toISOString(), endsAt })])
    expect(linkNamed(/Start/)).toBeDefined()
  })

  it('does not offer to start an interview that is days away', () => {
    render([interview({
      startsAt: '2027-12-09T18:00:00.000Z', endsAt: '2027-12-09T18:45:00.000Z',
    })])
    expect(linkNamed(/Start/)).toBeUndefined()
  })

  it('offers a rejoin for a live session whatever the clock says', () => {
    render([interview({
      sessionState: 'live',
      startsAt: '2027-12-01T09:00:00.000Z', endsAt: '2027-12-01T09:45:00.000Z',
    })])
    // Interviews run over. A session that is live is live, and losing the rejoin link mid-interview because
    // the scheduled end passed would be the worst possible moment to hide it.
    expect(linkNamed(/Rejoin/)).toBeDefined()
    expect(text()).toMatch(/Live now/)
  })

  it('offers a rejoin for a paused session too', () => {
    render([interview({ sessionState: 'paused' })])
    expect(linkNamed(/Rejoin/)).toBeDefined()
  })

  it('opens the meeting URL in a new tab without a referrer', () => {
    render([interview()])
    const join = linkNamed(/Join the call/)
    expect(join?.getAttribute('href')).toBe('https://meet.example.test/room')
    // The referrer would tell the meeting provider which interview page the click came from.
    expect(join?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(join?.getAttribute('target')).toBe('_blank')
  })

  it('offers no call link when the invitation carried none', () => {
    // Nothing in this product mints a meeting URL — it is whatever the organizer typed on the invitation.
    render([interview({ meetingUrl: null, modality: 'in_person', location: 'Room 3' })])
    expect(linkNamed(/Join the call/)).toBeUndefined()
    expect(text()).toMatch(/In person · Room 3/)
  })

  it('shows how much transcript there is, once there is some', () => {
    render([interview({ transcriptSegments: 0 })])
    expect(text()).not.toMatch(/transcript lines/)
    render([interview({ transcriptSegments: 214 })])
    expect(text()).toMatch(/214 transcript lines/)
  })
})

describe('the state badge picks what matters most', () => {
  const badgeFor = (overrides: Partial<InterviewListRowView>) => {
    render([interview(overrides)])
    return text()
  }

  it('says scheduled before anything has happened', () => {
    expect(badgeFor({})).toMatch(/Scheduled/)
  })

  it('lets live beat a finalized record, because someone is talking', () => {
    expect(badgeFor({ sessionState: 'live', reportStatus: 'final' })).toMatch(/Live now/)
  })

  it('lets cancelled beat everything, because nothing else is actionable', () => {
    expect(badgeFor({ eventStatus: 'cancelled', sessionState: 'live', reportStatus: 'draft' }))
      .toMatch(/Cancelled/)
  })

  it('flags an interview that ran but was never written up', () => {
    // The one state an organizer needs chasing about: the conversation happened and the record does not
    // exist yet.
    expect(badgeFor({ sessionState: 'processing' })).toMatch(/Needs writing up/)
  })

  it('distinguishes a draft record from a final one', () => {
    expect(badgeFor({ sessionState: 'review', reportStatus: 'draft' })).toMatch(/Record in draft/)
    expect(badgeFor({ sessionState: 'review', reportStatus: 'final' })).toMatch(/Record final/)
  })

  it('says an interview finished when a session ran and no report exists', () => {
    expect(badgeFor({ sessionState: 'finalized' })).toMatch(/Interview finished/)
  })
})

describe('times', () => {
  it('renders in the interview\'s own timezone, not the reader\'s', () => {
    render([interview({ startsAt: '2027-12-05T10:30:00.000Z', timezone: 'Asia/Tokyo' })])
    // 19:30 in Tokyo. An interview happens where it was booked.
    expect(text()).toMatch(/19:30|7:30/)
  })

  it('still renders a row whose stored timezone is nonsense', () => {
    // A blank row would be a worse answer than the reader's own zone.
    render([interview({ timezone: 'Not/AZone' })])
    expect(text()).toMatch(/Casey Candidate/)
    expect(text()).toMatch(/2027/)
  })
})
