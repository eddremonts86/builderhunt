ALTER TABLE "builder_claims" ADD COLUMN "revoked_by_user_id" text;--> statement-breakpoint
ALTER TABLE "builder_claims" ADD COLUMN "revocation_reason" text;--> statement-breakpoint
ALTER TABLE "builder_claims" ADD CONSTRAINT "builder_claims_revoked_by_user_id_auth_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."auth_users"("id") ON DELETE set null ON UPDATE no action;