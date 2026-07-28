import { createFileRoute } from '@tanstack/react-router'
import { InterviewBriefPage } from '~/modules/interviews/components/InterviewBriefPage'

/**
 * The interview preparation and record page (plan:
 * calendar-scheduling-interview-intelligence, Phases 8 and 10).
 *
 * `interviewId` is the calendar event id — an interview *is* a calendar event in this schema, and both the
 * brief and the report are keyed to it. Under `_dashboard`, so the layout's authentication applies; the
 * brief's and report's own RLS decide whether this particular event's material is visible, which is why the
 * page renders an empty state rather than a 403 for someone else's interview.
 *
 * The report lives here rather than on the live route for a reason: the live page holds a microphone and a
 * socket, and reading a record weeks later should not be behind a page that tears capture down when you
 * navigate away from it.
 */
export const Route = createFileRoute('/_dashboard/interviews/$interviewId/')({
  component: InterviewBriefPage,
})
