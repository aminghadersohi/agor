ALTER TABLE `sessions` ADD `attention_generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE `sessions`
SET `attention_generation` = 1
WHERE `ready_for_prompt` = 1;--> statement-breakpoint
CREATE TABLE `session_attention_states` (
	`user_id` text(36) NOT NULL,
	`session_id` text(36) NOT NULL,
	`seen_attention_generation` integer DEFAULT 0 NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `session_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`session_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `session_attention_states_session_idx`
	ON `session_attention_states` (`session_id`);
