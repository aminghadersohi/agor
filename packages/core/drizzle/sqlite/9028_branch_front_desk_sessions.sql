CREATE TABLE `branch_front_desk_sessions` (
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
CREATE UNIQUE INDEX `uniq_front_desk_slot` ON `branch_front_desk_sessions` (`branch_id`,`scope`,`slot`) WHERE `status` IN ('active', 'retiring');
--> statement-breakpoint
CREATE INDEX `idx_front_desk_session` ON `branch_front_desk_sessions` (`session_id`);
