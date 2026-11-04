ALTER TABLE `session_reminders` ADD COLUMN `wake_when` text CHECK (`wake_when` IS NULL OR (json_valid(`wake_when`) AND json_extract(`wake_when`, '$.kind') = 'github_pr'));
--> statement-breakpoint
ALTER TABLE `session_reminders` ADD COLUMN `check_every_minutes` integer CHECK (`check_every_minutes` IS NULL OR `check_every_minutes` BETWEEN 5 AND 60);
--> statement-breakpoint
ALTER TABLE `session_reminders` ADD COLUMN `next_check_at` integer;
--> statement-breakpoint
ALTER TABLE `session_reminders` ADD COLUMN `wake_outcome` text CHECK (`wake_outcome` IS NULL OR length(`wake_outcome`) <= 512);
--> statement-breakpoint
CREATE INDEX `session_reminders_next_check_idx` ON `session_reminders` (`status`,`next_check_at`,`reminder_id`) WHERE `next_check_at` IS NOT NULL;
