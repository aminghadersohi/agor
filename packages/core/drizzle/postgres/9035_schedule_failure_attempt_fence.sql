SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "schedule_failure_notifications" ADD COLUMN "attempt_id" text;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
