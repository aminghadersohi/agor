SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auto_archive" text DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auto_archive_after_seconds" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auto_archive_at" timestamp with time zone;--> statement-breakpoint
CREATE POLICY "session_auto_archive_migration_0100" ON "sessions"
  FOR UPDATE
  USING (current_setting('agor.system_scope', true) = 'session_auto_archive_migration_0100')
  WITH CHECK (current_setting('agor.system_scope', true) = 'session_auto_archive_migration_0100');--> statement-breakpoint
SELECT set_config('agor.system_scope', 'session_auto_archive_migration_0100', true);--> statement-breakpoint
UPDATE "sessions"
SET "auto_archive" = 'after_completion', "auto_archive_after_seconds" = 300
WHERE "data"->>'fork_origin' = 'btw';--> statement-breakpoint
SELECT set_config('agor.system_scope', '', true);--> statement-breakpoint
DROP POLICY "session_auto_archive_migration_0100" ON "sessions";--> statement-breakpoint
CREATE INDEX "sessions_auto_archive_due_idx" ON "sessions" USING btree ("tenant_id","archived","auto_archive","auto_archive_at","session_id");--> statement-breakpoint

-- System discovery projects routing metadata only. Every candidate is reloaded
-- and mutated inside its trusted tenant scope, where RLS and the write gate apply.
DROP POLICY IF EXISTS "session_auto_archive_discovery" ON "sessions";--> statement-breakpoint
CREATE POLICY "session_auto_archive_discovery" ON "sessions"
  FOR SELECT
  USING (
    "archived" = false
    AND "auto_archive" = 'after_completion'
    AND "auto_archive_at" IS NOT NULL
    AND current_setting('agor.system_scope', true) = 'session_auto_archive_discovery'
  );--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
