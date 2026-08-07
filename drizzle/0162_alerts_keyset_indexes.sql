CREATE INDEX "alert_triggers_org_matched_id_idx" ON "alert_triggers" USING btree ("organization_id","matched_at","id");--> statement-breakpoint
CREATE INDEX "alert_triggers_org_alert_id_idx" ON "alert_triggers" USING btree ("organization_id","alert_id","id");--> statement-breakpoint
CREATE INDEX "alert_triggers_org_alert_matched_id_idx" ON "alert_triggers" USING btree ("organization_id","alert_id","matched_at","id");--> statement-breakpoint
CREATE INDEX "alerts_org_created_id_idx" ON "alerts" USING btree ("organization_id","created_at","id");--> statement-breakpoint
CREATE INDEX "alerts_org_name_id_idx" ON "alerts" USING btree ("organization_id","name","id");