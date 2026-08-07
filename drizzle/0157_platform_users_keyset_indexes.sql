CREATE INDEX "auth_users_created_id_idx" ON "auth_users" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "auth_users_name_id_idx" ON "auth_users" USING btree ("name","id");