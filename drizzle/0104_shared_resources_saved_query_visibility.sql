ALTER TABLE "saved_queries" ADD COLUMN "visibility" text DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
CREATE INDEX "saved_queries_org_visibility_creator_idx" ON "saved_queries" USING btree ("organization_id","visibility","user_id");--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_visibility_check" CHECK ("saved_queries"."visibility" in ('private', 'organization'));