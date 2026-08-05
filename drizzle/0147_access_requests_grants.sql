-- Custom SQL migration file, put your code below! --

-- waitlist-launch plan: `access_requests` is a system-operational, no-owning-subject table — an
-- approved row IS the allowlist the sign-up gate reads, and someone asking for access has no tenant
-- yet, so there is no organization to scope a policy to. Same "no RLS possible or needed, access
-- controlled entirely by GRANT" reasoning as profile_removal_requests (0064), conversion_events
-- (0062) and status_checks (0048).
--
-- The privilege split is the security design, so each grant is justified separately and narrowly.

-- `builderhunt_app` (DATABASE_URL, the plain web-runtime role) serves the public "request access"
-- form: INSERT a new request, and SELECT so a second submission from the same address updates the
-- existing row instead of raising a unique violation the handler would have to leak.
--
-- It gets **no UPDATE**: deciding who gets in is a platform-admin action, and the request path must
-- not be able to approve anything. No DELETE either — see the note on revocation below.
GRANT INSERT, SELECT ON TABLE access_requests TO builderhunt_app;

-- `builderhunt_auth` (DATABASE_AUTH_URL) is the identity the sign-up gate runs under: better-auth's
-- `user.create.before` hook has to answer "is this email approved?" before it lets a user row be
-- created. It reads a decision; it never makes one.
--
-- UPDATE is granted for exactly one column's worth of work: stamping `invite_consumed_at` when an
-- invite is redeemed, so the same token cannot mint a second account. That write happens in the same
-- request that creates the user, which is why it belongs to this role and not the worker.
GRANT SELECT, UPDATE ON TABLE access_requests TO builderhunt_auth;

-- `builderhunt_platform` (the admin surface) reads the queue and records decisions: approve (mint an
-- invite hash, set status/decided_at/decided_by_user_id) and revoke.
--
-- Deliberately **no DELETE**. Revocation sets `status = 'revoked'`, exactly as profile_suppressions
-- keeps a revoked row rather than dropping it: "this person was let in on the 5th and removed on the
-- 9th" is the record, and a hard delete destroys it. A row that can be deleted is also a decision
-- that can be quietly un-made.
GRANT SELECT, UPDATE ON TABLE access_requests TO builderhunt_platform;

-- `builderhunt_worker` runs the scheduled sweeps: expiring invite tokens past `invite_expires_at`
-- (clearing the hash, so a leaked-but-unused link stops being a credential) and, once a retention
-- rule is agreed, aging out requests that were never decided.
--
-- That retention rule does NOT exist yet, and it matters more here than for the tables above: this is
-- the one system-operational table holding a **plaintext email**, because an operator has to read the
-- address to decide and approval sends mail to it. Until a rule is set, un-approved requests
-- accumulate as personal data about people who never became users. Tracked in the plan-54 task list
-- alongside the privacy-export and /legal/privacy entries it also owes.
GRANT SELECT, UPDATE ON TABLE access_requests TO builderhunt_worker;

-- No grant at all for `builderhunt_capability` (public capability reads) or `builderhunt_readonly`:
-- the allowlist is not public data, and a shared capability link must never be able to enumerate who
-- asked for access.