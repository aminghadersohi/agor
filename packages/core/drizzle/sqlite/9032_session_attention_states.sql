-- Per-user unseen session attention (restores fork PR #21).
--
-- `sessions.attention_generation` is a shared, monotonic counter advanced each
-- time a session settles into a result that needs a human; each user's
-- acknowledgement lives in `session_attention_states`. SQLite is single-tenant,
-- so the table is keyed by (user_id, session_id) without tenant_id.
--
-- SQLITE LIMITS: SQLite has no `ADD COLUMN IF NOT EXISTS` and no DO block, so
-- this file cannot verify a pre-existing shape the way the Postgres file does.
-- The table and index are conditional (an earlier deploy of this feature,
-- fork migration 9009, may have left them behind), but the column add is not:
-- if `sessions.attention_generation` already exists, this migration fails
-- loudly with "duplicate column name" for operator review rather than guessing.
-- No SQLite fork database is known to carry that column. A pre-existing table
-- of a different shape surfaces as a failing query at runtime instead.
--
-- Backfill: sessions currently flagged ready_for_prompt start one generation
-- above any acknowledgement already recorded (unseen for everyone); every other
-- session starts at 0 (seen). Because the column is always new here, unflagged
-- sessions need no acknowledgement rows.
ALTER TABLE `sessions` ADD `attention_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `session_attention_states` (
	`user_id` text(36) NOT NULL,
	`session_id` text(36) NOT NULL,
	`seen_attention_generation` integer DEFAULT 0 NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `session_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_attention_states_session_idx`
	ON `session_attention_states` (`session_id`);--> statement-breakpoint
UPDATE `sessions`
SET `attention_generation` = 1 + COALESCE((
	SELECT MAX(a.`seen_attention_generation`)
	FROM `session_attention_states` a
	WHERE a.`session_id` = `sessions`.`session_id`
), 0)
WHERE `ready_for_prompt` = 1;
