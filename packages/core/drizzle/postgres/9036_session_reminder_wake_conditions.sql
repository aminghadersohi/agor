SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "session_reminders" ADD COLUMN "wake_when" jsonb;
--> statement-breakpoint
ALTER TABLE "session_reminders" ADD COLUMN "check_every_minutes" integer;
--> statement-breakpoint
ALTER TABLE "session_reminders" ADD COLUMN "next_check_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "session_reminders" ADD COLUMN "wake_outcome" text;
--> statement-breakpoint
-- Time-only reminders keep every wake column NULL; a conditional reminder
-- always carries its cadence. The application validates the condition body.
ALTER TABLE "session_reminders" ADD CONSTRAINT "session_reminders_wake_shape_check" CHECK (
	("wake_when" IS NULL AND "check_every_minutes" IS NULL AND "next_check_at" IS NULL AND "wake_outcome" IS NULL)
	OR (jsonb_typeof("wake_when") = 'object' AND "wake_when"->>'kind' = 'github_pr'
		AND "check_every_minutes" BETWEEN 5 AND 60
		AND ("wake_outcome" IS NULL OR char_length("wake_outcome") <= 512))
);
--> statement-breakpoint
CREATE INDEX "session_reminders_next_check_idx" ON "session_reminders" ("status","next_check_at","tenant_id","reminder_id") WHERE "next_check_at" IS NOT NULL;
--> statement-breakpoint
-- System discovery still exposes only due routing identities; a conditional
-- reminder is also due when its next condition check is.
DROP POLICY "session_reminder_discovery" ON "session_reminders";
--> statement-breakpoint
CREATE POLICY "session_reminder_discovery" ON "session_reminders"
	FOR SELECT USING (
		current_setting('agor.system_scope', true) = 'session_reminder_discovery'
		AND (("status" = 'scheduled' AND "due_at" <= CURRENT_TIMESTAMP)
			OR ("status" = 'scheduled' AND "next_check_at" <= CURRENT_TIMESTAMP)
			OR ("status" = 'claimed' AND "claim_expires_at" <= CURRENT_TIMESTAMP))
	);
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
