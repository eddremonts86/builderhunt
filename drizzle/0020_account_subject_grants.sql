-- Custom SQL migration file, put your code below! --

-- Account-subject tables (consent, data export, account deletion, plan
-- self-service, builder claims, profile views, roadmap votes) were never
-- granted to builderhunt_app in any prior migration — 0002 only covered the
-- auth_* tables (later revoked from builderhunt_app by 0007's auth-broker
-- split) and 0008 only covered tenant-private/organization tables. Nothing
-- had exercised these code paths against the real least-privilege role
-- before, so the gap went undetected: /api/consent, /api/me/data-export,
-- /api/me/delete-account, /api/plans/request-upgrade's own-account reads,
-- builder-claim/profile-view export summaries, and roadmap voting were all
-- broken under builderhunt_app in any environment enforcing these roles.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  user_consents,
  data_export_requests,
  deletion_requests,
  plan_changes,
  plan_requests,
  plans,
  builder_claim_requests,
  builder_profile_views,
  roadmap_votes
TO builderhunt_app;
