CREATE TABLE `profile_images` (
	`image_id` text(36) PRIMARY KEY NOT NULL,
	`user_id` text(36),
	`branch_id` text(36),
	`created_by` text(36) NOT NULL,
	`original_name` text NOT NULL,
	`alt_text` text,
	`position` integer DEFAULT 0 NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`small_data` blob NOT NULL,
	`small_content_type` text NOT NULL,
	`small_width` integer NOT NULL,
	`small_height` integer NOT NULL,
	`large_data` blob NOT NULL,
	`large_content_type` text NOT NULL,
	`large_width` integer NOT NULL,
	`large_height` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `profile_images_subject_xor_check` CHECK (((`user_id` IS NOT NULL AND `branch_id` IS NULL) OR (`user_id` IS NULL AND `branch_id` IS NOT NULL))),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `profile_images_user_position_idx` ON `profile_images` (`user_id`,`position`);--> statement-breakpoint
CREATE INDEX `profile_images_branch_position_idx` ON `profile_images` (`branch_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `profile_images_one_primary_user_idx` ON `profile_images` (`user_id`) WHERE `profile_images`.`user_id` IS NOT NULL AND `profile_images`.`is_primary` = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `profile_images_one_primary_branch_idx` ON `profile_images` (`branch_id`) WHERE `profile_images`.`branch_id` IS NOT NULL AND `profile_images`.`is_primary` = 1;
