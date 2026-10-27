CREATE TABLE "schedule_failure_notifications" (
  "task_id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL,
  "schedule_id" text NOT NULL,
  "branch_id" text NOT NULL,
  "created_by" text NOT NULL,
  "scheduled_run_at" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "next_attempt_at" integer NOT NULL,
  "created_at" integer NOT NULL,
  "updated_at" integer NOT NULL,
  "gateway_channel_id" text,
  "target" text,
  "platform_message_id" text,
  "last_error_code" text
);
--> statement-breakpoint
CREATE INDEX "schedule_failure_notifications_due_idx" ON "schedule_failure_notifications" ("status", "next_attempt_at");
