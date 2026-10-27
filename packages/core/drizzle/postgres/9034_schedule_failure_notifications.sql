SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE "schedule_failure_notifications" (
  "tenant_id" text NOT NULL DEFAULT 'default',
  "task_id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "schedule_id" text NOT NULL,
  "branch_id" text NOT NULL,
  "created_by" text NOT NULL,
  "scheduled_run_at" bigint NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "next_attempt_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  "gateway_channel_id" text,
  "target" text,
  "platform_message_id" text,
  "last_error_code" text
);
--> statement-breakpoint
CREATE INDEX "schedule_failure_notifications_due_idx" ON "schedule_failure_notifications" ("status", "next_attempt_at");
--> statement-breakpoint
ALTER TABLE "schedule_failure_notifications" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "schedule_failure_notifications" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_schedule_failure_notifications" ON "schedule_failure_notifications"
  USING (tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
CREATE POLICY "schedule_failure_notifications_discovery" ON "schedule_failure_notifications" FOR SELECT
  USING (current_setting('agor.system_scope', true) = 'scheduler_discovery');
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
