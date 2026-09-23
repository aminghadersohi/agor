ALTER TABLE `sessions` ADD `auto_archive` text DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_archive_after_seconds` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_archive_at` integer;--> statement-breakpoint
UPDATE `sessions`
SET `auto_archive` = 'after_completion', `auto_archive_after_seconds` = 300
WHERE json_extract(`data`, '$.fork_origin') = 'btw';--> statement-breakpoint
CREATE INDEX `sessions_auto_archive_due_idx` ON `sessions` (`archived`,`auto_archive`,`auto_archive_at`,`session_id`);
