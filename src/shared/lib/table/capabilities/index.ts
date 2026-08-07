/**
 * Every table capability, in one import.
 *
 * A capability registers itself into `TABLE_CAPABILITIES` as a side effect of its module being
 * evaluated — which means the registry is only as complete as whatever happens to have been
 * imported. That is fine for the app, where a surface imports its own capability, and **not** fine
 * for `capability-index.test.ts`: its sweep over the registry would pass by finding nothing, and
 * report a green guard over zero tables.
 *
 * So the guard imports this barrel, and a new capability is covered by adding one line here.
 */

export { abuseSignalsCapability, ABUSE_SIGNAL_FILTER_LABELS } from './abuse-signals'
export { billingDisputesCapability, BILLING_DISPUTE_FILTER_LABELS, DISPUTE_OUTCOMES } from './billing-disputes'
export { billingRefundsCapability, BILLING_REFUND_FILTER_LABELS } from './billing-refunds'
export { organizationInvitationsCapability, ORGANIZATION_INVITATION_FILTER_LABELS, INVITABLE_ROLES } from './organization-invitations'
export { organizationMembersCapability, ORGANIZATION_MEMBER_FILTER_LABELS, ORGANIZATION_ROLES } from './organization-members'
export { platformUsersCapability } from './platform-users'
export { sprintResultsCapability, SPRINT_RESULT_FILTER_LABELS } from './sprint-results'
