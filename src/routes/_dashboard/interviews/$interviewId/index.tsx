import { createFileRoute } from '@tanstack/react-router'
import { InterviewBriefPage } from '~/modules/interviews/components/InterviewBriefPage'

/**
 * The interview preparation page (plan:
 * calendar-scheduling-interview-intelligence, Phase 8).
 *
 * `interviewId` is the calendar event id — an interview *is* a calendar event in this schema, and the
 * brief is keyed to it. Under `_dashboard`, so the layout's authentication applies; the brief's own RLS
 * decides whether this particular event's brief is visible, which is why the page renders an empty state
 * rather than a 403 for someone else's interview.
 */
export const Route = createFileRoute('/_dashboard/interviews/$interviewId/')({
  component: InterviewBriefPage,
})
