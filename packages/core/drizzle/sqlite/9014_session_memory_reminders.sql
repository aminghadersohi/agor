CREATE TABLE `session_memories` (
	`memory_id` text(36) PRIMARY KEY NOT NULL,
	`session_id` text(36) NOT NULL,
	`title` text,
	`text` text NOT NULL,
	`tags` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_by` text(36) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `session_memories_session_state_updated_idx` ON `session_memories` (`session_id`,`archived`,`updated_at`,`memory_id`);
--> statement-breakpoint
CREATE TABLE `session_reminders` (
	`reminder_id` text(36) PRIMARY KEY NOT NULL,
	`session_id` text(36) NOT NULL,
	`text` text NOT NULL,
	`due_at` integer NOT NULL,
	`display_timezone` text NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL CHECK (`status` IN ('scheduled','claimed','queued','cancelled','blocked')),
	`created_by` text(36) NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL CHECK (`revision` >= 1),
	`claim_token` text,
	`claimed_at` integer,
	`claim_expires_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`queued_at` integer,
	`task_id` text(36),
	`failure_code` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`task_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `session_reminders_session_status_due_idx` ON `session_reminders` (`session_id`,`status`,`due_at`,`reminder_id`);
--> statement-breakpoint
CREATE INDEX `session_reminders_due_claim_idx` ON `session_reminders` (`status`,`due_at`,`claim_expires_at`,`reminder_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_reminders_task_unique` ON `session_reminders` (`task_id`) WHERE `task_id` IS NOT NULL;
