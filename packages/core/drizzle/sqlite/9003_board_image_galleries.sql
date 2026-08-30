CREATE TABLE `__new_profile_images` (
	`image_id` text(36) PRIMARY KEY NOT NULL,
	`user_id` text(36),
	`branch_id` text(36),
	`board_id` text(36),
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
	`identity_model_provider` text,
	`identity_model_task_id` text,
	`identity_model_status` text,
	`identity_model_progress` integer,
	`identity_model_data` blob,
	`identity_model_content_type` text,
	`identity_model_error` text,
	`identity_model_created_at` integer,
	`identity_model_updated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `profile_images_subject_xor_check` CHECK (((`user_id` IS NOT NULL AND `branch_id` IS NULL AND `board_id` IS NULL) OR (`user_id` IS NULL AND `branch_id` IS NOT NULL AND `board_id` IS NULL) OR (`user_id` IS NULL AND `branch_id` IS NULL AND `board_id` IS NOT NULL))),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_profile_images`("image_id", "user_id", "branch_id", "board_id", "created_by", "original_name", "alt_text", "position", "is_primary", "small_data", "small_content_type", "small_width", "small_height", "large_data", "large_content_type", "large_width", "large_height", "identity_model_provider", "identity_model_task_id", "identity_model_status", "identity_model_progress", "identity_model_data", "identity_model_content_type", "identity_model_error", "identity_model_created_at", "identity_model_updated_at", "created_at", "updated_at") SELECT "image_id", "user_id", "branch_id", NULL, "created_by", "original_name", "alt_text", "position", "is_primary", "small_data", "small_content_type", "small_width", "small_height", "large_data", "large_content_type", "large_width", "large_height", "identity_model_provider", "identity_model_task_id", "identity_model_status", "identity_model_progress", "identity_model_data", "identity_model_content_type", "identity_model_error", "identity_model_created_at", "identity_model_updated_at", "created_at", "updated_at" FROM `profile_images`;--> statement-breakpoint
DROP TABLE `profile_images`;--> statement-breakpoint
ALTER TABLE `__new_profile_images` RENAME TO `profile_images`;--> statement-breakpoint
CREATE INDEX `profile_images_user_position_idx` ON `profile_images` (`user_id`,`position`);--> statement-breakpoint
CREATE INDEX `profile_images_branch_position_idx` ON `profile_images` (`branch_id`,`position`);--> statement-breakpoint
CREATE INDEX `profile_images_board_position_idx` ON `profile_images` (`board_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `profile_images_one_primary_user_idx` ON `profile_images` (`user_id`) WHERE `profile_images`.`user_id` IS NOT NULL AND `profile_images`.`is_primary` = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `profile_images_one_primary_branch_idx` ON `profile_images` (`branch_id`) WHERE `profile_images`.`branch_id` IS NOT NULL AND `profile_images`.`is_primary` = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `profile_images_one_primary_board_idx` ON `profile_images` (`board_id`) WHERE `profile_images`.`board_id` IS NOT NULL AND `profile_images`.`is_primary` = 1;
