ALTER TABLE "onboarding_progress" ADD COLUMN "flow_version" integer;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD COLUMN "current_step_key" text;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD COLUMN "activation_type" text;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD COLUMN "activation_ref_id" text;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD COLUMN "activated_at" timestamp with time zone;