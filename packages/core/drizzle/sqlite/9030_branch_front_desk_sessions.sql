-- Front-desk session slots per (branch, scope, slot).
--
-- WATERMARK NOTE (amin_dev_next, 2026-09-26): fork main journals this as
-- 9028_branch_front_desk_sessions at 1790129000213, below the watermark of a
-- database that already applied 9028_profile_image_galleries,
-- 0113_callback_ownership_reconciliation and 0114_restore_session_indexes
-- (1790208000000). It re-enters above that watermark and is conditional, since
-- a database migrated by fork main already has the table. SQLite has no DO
-- block, so the Postgres file's verification step has no equivalent here.
CREATE TABLE IF NOT EXISTS `branch_front_desk_sessions` (
	`id` text(36) PRIMARY KEY NOT NULL,
	`branch_id` text(36) NOT NULL,
	`scope` text NOT NULL,
	`slot` integer NOT NULL,
	`session_id` text(36) NOT NULL,
	`status` text NOT NULL,
	`promoted_at` integer NOT NULL,
	`promoted_by` text(36),
	`retired_at` integer,
	`retired_reason` text,
	`metadata` text,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`promoted_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_front_desk_slot` ON `branch_front_desk_sessions` (`branch_id`,`scope`,`slot`) WHERE `status` IN ('active', 'retiring');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_front_desk_session` ON `branch_front_desk_sessions` (`session_id`);
