SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "skills_enabled" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "failure_threshold" integer NOT NULL DEFAULT 3;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "consecutive_failures" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "pause_reason" text ;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "attention_required" boolean NOT NULL DEFAULT false;
