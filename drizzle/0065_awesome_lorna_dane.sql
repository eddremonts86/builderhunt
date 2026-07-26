CREATE TABLE "availability_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"local_date" date NOT NULL,
	"local_start" time,
	"local_end" time,
	"kind" text NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_overrides_kind_check" CHECK ("availability_overrides"."kind" in ('available', 'blocked')),
	CONSTRAINT "availability_overrides_times_check" CHECK (("availability_overrides"."kind" = 'blocked' and "availability_overrides"."local_start" is null and "availability_overrides"."local_end" is null) or ("availability_overrides"."kind" = 'available' and "availability_overrides"."local_start" is not null and "availability_overrides"."local_end" is not null and "availability_overrides"."local_end" > "availability_overrides"."local_start"))
);
--> statement-breakpoint
CREATE TABLE "availability_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"timezone" text NOT NULL,
	"weekdays" integer[] NOT NULL,
	"local_start" time NOT NULL,
	"local_end" time NOT NULL,
	"effective_from" date,
	"effective_until" date,
	"slot_minutes" integer NOT NULL,
	"buffer_before_minutes" integer DEFAULT 0 NOT NULL,
	"buffer_after_minutes" integer DEFAULT 0 NOT NULL,
	"min_notice_minutes" integer DEFAULT 0 NOT NULL,
	"horizon_days" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "availability_rules_local_range_check" CHECK ("availability_rules"."local_end" > "availability_rules"."local_start"),
	CONSTRAINT "availability_rules_bounds_check" CHECK ("availability_rules"."slot_minutes" > 0 and "availability_rules"."buffer_before_minutes" >= 0 and "availability_rules"."buffer_after_minutes" >= 0 and "availability_rules"."min_notice_minutes" >= 0 and "availability_rules"."horizon_days" > 0),
	CONSTRAINT "availability_rules_effective_range_check" CHECK ("availability_rules"."effective_until" is null or "availability_rules"."effective_from" is null or "availability_rules"."effective_until" >= "availability_rules"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "calendar_event_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"recurrence_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"materialization_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_occurrences_range_check" CHECK ("calendar_event_occurrences"."ends_at" > "calendar_event_occurrences"."starts_at"),
	CONSTRAINT "calendar_event_occurrences_status_check" CHECK ("calendar_event_occurrences"."status" in ('active', 'cancelled')),
	CONSTRAINT "calendar_event_occurrences_materialization_check" CHECK ("calendar_event_occurrences"."materialization_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "calendar_event_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"participant_id" uuid,
	"channel" text NOT NULL,
	"offset_minutes" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_fire_at" timestamp with time zone,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_event_reminders_channel_check" CHECK ("calendar_event_reminders"."channel" in ('email', 'in_app')),
	CONSTRAINT "calendar_event_reminders_offset_check" CHECK ("calendar_event_reminders"."offset_minutes" in (0, 5, 10, 15, 30, 60, 1440, 10080)),
	CONSTRAINT "calendar_event_reminders_state_check" CHECK ("calendar_event_reminders"."state" in ('pending', 'sent', 'failed', 'cancelled')),
	CONSTRAINT "calendar_event_reminders_attempts_check" CHECK ("calendar_event_reminders"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"calendar_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"location" text,
	"meeting_url" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"timezone" text NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"busy" boolean DEFAULT true NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"rrule" text,
	"recurrence_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"source_type" text,
	"source_id" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_range_check" CHECK ("calendar_events"."ends_at" > "calendar_events"."starts_at"),
	CONSTRAINT "calendar_events_visibility_check" CHECK ("calendar_events"."visibility" = 'private'),
	CONSTRAINT "calendar_events_type_check" CHECK ("calendar_events"."type" in ('personal', 'interview')),
	CONSTRAINT "calendar_events_status_check" CHECK ("calendar_events"."status" in ('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled', 'rescheduled', 'no_show')),
	CONSTRAINT "calendar_events_version_check" CHECK ("calendar_events"."version" >= 1),
	CONSTRAINT "calendar_events_source_pair_check" CHECK (("calendar_events"."source_type" is null) = ("calendar_events"."source_id" is null))
);
--> statement-breakpoint
CREATE TABLE "calendar_notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"reminder_id" uuid,
	"kind" text NOT NULL,
	"recipient_user_id" text,
	"external_recipient_hash" text,
	"idempotency_key" text NOT NULL,
	"provider_reference" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_notification_deliveries_kind_check" CHECK ("calendar_notification_deliveries"."kind" in ('reminder', 'invitation', 'reschedule', 'cancellation')),
	CONSTRAINT "calendar_notification_deliveries_state_check" CHECK ("calendar_notification_deliveries"."state" in ('pending', 'sent', 'failed')),
	CONSTRAINT "calendar_notification_deliveries_recipient_check" CHECK (("calendar_notification_deliveries"."recipient_user_id" is null) != ("calendar_notification_deliveries"."external_recipient_hash" is null))
);
--> statement-breakpoint
CREATE TABLE "candidate_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"submission_id" uuid NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"source_type" text NOT NULL,
	"acquisition_mode" text NOT NULL,
	"authorization_notice_version" text,
	"authorization_attested_at" timestamp with time zone,
	"policy_decision" text DEFAULT 'not_importable' NOT NULL,
	"import_state" text DEFAULT 'not_requested' NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_links_acquisition_mode_check" CHECK ("candidate_links"."acquisition_mode" in ('official_api', 'authorized_crawl', 'user_submitted')),
	CONSTRAINT "candidate_links_policy_decision_check" CHECK ("candidate_links"."policy_decision" in ('official_api', 'authorized_crawl', 'user_submitted', 'not_importable')),
	CONSTRAINT "candidate_links_import_state_check" CHECK ("candidate_links"."import_state" in ('not_requested', 'queued', 'running', 'succeeded', 'failed', 'not_importable')),
	CONSTRAINT "candidate_links_attestation_check" CHECK ("candidate_links"."policy_decision" != 'authorized_crawl' or ("candidate_links"."authorization_notice_version" is not null and "candidate_links"."authorization_attested_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "candidate_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"invitation_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"email_normalized" text NOT NULL,
	"notes" text,
	"submitted_at" timestamp with time zone,
	"retention_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" text,
	"external_email" text,
	"display_name" text,
	"role" text NOT NULL,
	"response" text DEFAULT 'needs_action' NOT NULL,
	"access_granted" boolean DEFAULT false NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_participants_identity_check" CHECK (("event_participants"."user_id" is null) != ("event_participants"."external_email" is null)),
	CONSTRAINT "event_participants_role_check" CHECK ("event_participants"."role" in ('organizer', 'attendee')),
	CONSTRAINT "event_participants_response_check" CHECK ("event_participants"."response" in ('needs_action', 'accepted', 'declined', 'tentative'))
);
--> statement-breakpoint
CREATE TABLE "scheduling_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"organization_builder_id" text,
	"role_title" text NOT NULL,
	"role_context" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"timezone" text NOT NULL,
	"modality" text NOT NULL,
	"meeting_url" text,
	"location" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"capability_hash" text NOT NULL,
	"expires_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"booked_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"booked_event_id" uuid,
	"reschedule_count" integer DEFAULT 0 NOT NULL,
	"policy_version" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduling_invitations_status_check" CHECK ("scheduling_invitations"."status" in ('draft', 'sent', 'opened', 'booked', 'declined', 'expired', 'revoked')),
	CONSTRAINT "scheduling_invitations_modality_check" CHECK ("scheduling_invitations"."modality" in ('in_person', 'remote_call')),
	CONSTRAINT "scheduling_invitations_duration_check" CHECK ("scheduling_invitations"."duration_minutes" > 0 and "scheduling_invitations"."duration_minutes" <= 480),
	CONSTRAINT "scheduling_invitations_counters_check" CHECK ("scheduling_invitations"."reschedule_count" >= 0 and "scheduling_invitations"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "user_calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"color" text,
	"default_reminder_offsets" integer[] DEFAULT '{}'::integer[] NOT NULL,
	"default_reminder_channels" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "availability_overrides_organization_id_id_unique" ON "availability_overrides" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "availability_rules_organization_id_id_unique" ON "availability_rules" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_occurrences_organization_id_id_unique" ON "calendar_event_occurrences" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_reminders_organization_id_id_unique" ON "calendar_event_reminders" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_organization_id_id_unique" ON "calendar_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_notification_deliveries_organization_id_id_unique" ON "calendar_notification_deliveries" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_links_organization_id_id_unique" ON "candidate_links" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_submissions_organization_id_id_unique" ON "candidate_submissions" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_participants_organization_id_id_unique" ON "event_participants" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduling_invitations_organization_id_id_unique" ON "scheduling_invitations" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_calendars_organization_id_id_unique" ON "user_calendars" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "availability_overrides" ADD CONSTRAINT "availability_overrides_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_overrides" ADD CONSTRAINT "availability_overrides_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "availability_rules" ADD CONSTRAINT "availability_rules_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_occurrences" ADD CONSTRAINT "calendar_event_occurrences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_occurrences" ADD CONSTRAINT "calendar_event_occurrences_organization_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."calendar_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_organization_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."calendar_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_event_reminders" ADD CONSTRAINT "calendar_event_reminders_organization_participant_fk" FOREIGN KEY ("organization_id","participant_id") REFERENCES "public"."event_participants"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_organization_calendar_fk" FOREIGN KEY ("organization_id","calendar_id") REFERENCES "public"."user_calendars"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_notification_deliveries" ADD CONSTRAINT "calendar_notification_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_notification_deliveries" ADD CONSTRAINT "calendar_notification_deliveries_recipient_user_id_auth_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_notification_deliveries" ADD CONSTRAINT "calendar_notification_deliveries_organization_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."calendar_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_notification_deliveries" ADD CONSTRAINT "calendar_notification_deliveries_organization_reminder_fk" FOREIGN KEY ("organization_id","reminder_id") REFERENCES "public"."calendar_event_reminders"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_links" ADD CONSTRAINT "candidate_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_links" ADD CONSTRAINT "candidate_links_organization_submission_fk" FOREIGN KEY ("organization_id","submission_id") REFERENCES "public"."candidate_submissions"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_submissions" ADD CONSTRAINT "candidate_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidate_submissions" ADD CONSTRAINT "candidate_submissions_organization_invitation_fk" FOREIGN KEY ("organization_id","invitation_id") REFERENCES "public"."scheduling_invitations"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_participants" ADD CONSTRAINT "event_participants_organization_event_fk" FOREIGN KEY ("organization_id","event_id") REFERENCES "public"."calendar_events"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_invitations" ADD CONSTRAINT "scheduling_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_invitations" ADD CONSTRAINT "scheduling_invitations_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_invitations" ADD CONSTRAINT "scheduling_invitations_organization_builder_fk" FOREIGN KEY ("organization_id","organization_builder_id") REFERENCES "public"."organization_builders"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_invitations" ADD CONSTRAINT "scheduling_invitations_organization_booked_event_fk" FOREIGN KEY ("organization_id","booked_event_id") REFERENCES "public"."calendar_events"("organization_id","id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_calendars" ADD CONSTRAINT "user_calendars_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_calendars" ADD CONSTRAINT "user_calendars_owner_user_id_auth_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "availability_overrides_owner_date_idx" ON "availability_overrides" USING btree ("organization_id","owner_user_id","local_date");--> statement-breakpoint
CREATE INDEX "availability_rules_owner_idx" ON "availability_rules" USING btree ("organization_id","owner_user_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_occurrences_identity_unique" ON "calendar_event_occurrences" USING btree ("organization_id","event_id","recurrence_id");--> statement-breakpoint
CREATE INDEX "calendar_event_occurrences_range_idx" ON "calendar_event_occurrences" USING btree ("organization_id","starts_at","ends_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_reminders_participant_delivery_unique" ON "calendar_event_reminders" USING btree ("organization_id","event_id","participant_id","channel","offset_minutes") WHERE "calendar_event_reminders"."participant_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_event_reminders_owner_delivery_unique" ON "calendar_event_reminders" USING btree ("organization_id","event_id","channel","offset_minutes") WHERE "calendar_event_reminders"."participant_id" is null;--> statement-breakpoint
CREATE INDEX "calendar_event_reminders_next_fire_idx" ON "calendar_event_reminders" USING btree ("state","next_fire_at");--> statement-breakpoint
CREATE INDEX "calendar_events_owner_range_idx" ON "calendar_events" USING btree ("organization_id","owner_user_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "calendar_events_status_idx" ON "calendar_events" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_notification_deliveries_idempotency_key_unique" ON "calendar_notification_deliveries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "calendar_notification_deliveries_recipient_idx" ON "calendar_notification_deliveries" USING btree ("organization_id","recipient_user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_links_submission_normalized_url_unique" ON "candidate_links" USING btree ("organization_id","submission_id","normalized_url");--> statement-breakpoint
CREATE INDEX "candidate_links_import_state_idx" ON "candidate_links" USING btree ("organization_id","import_state");--> statement-breakpoint
CREATE UNIQUE INDEX "candidate_submissions_invitation_id_unique" ON "candidate_submissions" USING btree ("invitation_id");--> statement-breakpoint
CREATE INDEX "candidate_submissions_retention_idx" ON "candidate_submissions" USING btree ("retention_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "event_participants_internal_identity_unique" ON "event_participants" USING btree ("organization_id","event_id","user_id") WHERE "event_participants"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "event_participants_external_identity_unique" ON "event_participants" USING btree ("organization_id","event_id","external_email") WHERE "event_participants"."external_email" is not null;--> statement-breakpoint
CREATE INDEX "event_participants_user_idx" ON "event_participants" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduling_invitations_capability_hash_unique" ON "scheduling_invitations" USING btree ("capability_hash");--> statement-breakpoint
CREATE INDEX "scheduling_invitations_owner_status_idx" ON "scheduling_invitations" USING btree ("organization_id","owner_user_id","status");--> statement-breakpoint
CREATE INDEX "scheduling_invitations_expiry_idx" ON "scheduling_invitations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_calendars_default_unique" ON "user_calendars" USING btree ("organization_id","owner_user_id") WHERE "user_calendars"."is_default";--> statement-breakpoint
CREATE INDEX "user_calendars_owner_idx" ON "user_calendars" USING btree ("organization_id","owner_user_id");