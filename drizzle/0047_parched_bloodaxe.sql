CREATE TABLE "status_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ok" boolean NOT NULL,
	"components" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "status_checks_checked_at_idx" ON "status_checks" USING btree ("checked_at");