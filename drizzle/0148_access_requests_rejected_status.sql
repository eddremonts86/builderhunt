-- Custom SQL migration file, put your code below! --

-- waitlist-launch plan: `access_requests.status` gains 'rejected'.
--
-- 0146 shipped with three states, and that turned out to be one short. Turning down a pending request
-- had no representation, so the only way to do it through the UI was Approve followed by Revoke —
-- which mints an invite token and (once the approval email is wired) sends a link to the very person
-- being turned down. A missing state forced a wrong action.
--
-- 'revoked' is NOT the right home for it either. That state means "had access, and it was taken away";
-- a rejection means "never had access, and we decided no". This table is the record of who was let into
-- a closed beta and when, so collapsing the two would destroy exactly the distinction the record
-- exists to hold.
--
-- Nothing else has to change:
--   * `isEmailAllowed` only ever returns true for 'approved', so 'rejected' fails closed for free.
--   * the `decided_at` check — (status = 'pending') = (decided_at is null) — already fits: a rejection
--     is a decision and carries its timestamp.
--   * no grant changes; recording a rejection is an UPDATE, which `builderhunt_platform` already has.
--
-- Rejection is deliberately not a permanent ban. `email` is unique, so a rejected person cannot
-- re-open their own request by submitting again (`requestAccess` finds the existing row), but an
-- operator can still approve it later if they change their mind.

ALTER TABLE access_requests DROP CONSTRAINT IF EXISTS access_requests_status_check;

ALTER TABLE access_requests ADD CONSTRAINT access_requests_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'revoked'));