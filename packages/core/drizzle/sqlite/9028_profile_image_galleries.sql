-- Profile image galleries for users, branches, and boards.
--
-- Created directly in its final three-subject shape. The originating work
-- built this table over three migrations — create, add 3D identity-model
-- columns, then rebuild for board subjects — but the identity-model feature is
-- not part of this change, so replaying that sequence would add nine columns
-- only to leave them permanently unused. One create is also cheaper and has no
-- table-rebuild step to get wrong.
--
-- Exactly one subject per row is enforced by a three-way XOR check rather than
-- by convention, and each subject may have at most one primary image, enforced
-- by partial unique indexes rather than by application code.
--
-- INTEGRATION NOTE (amin_dev_next, 2026-09-24): conditional for the same
-- reason as the Postgres file. An existing fork database created this table
-- over earlier migrations that sit below its applied watermark, so an
-- unguarded CREATE would abort the pending batch. SQLite has no DO block, so
-- the Postgres file's verification step has no equivalent here; a pre-existing
-- table of a different shape surfaces as a failing query at runtime instead.
CREATE TABLE IF NOT EXISTS `profile_images` (
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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `profile_images_subject_xor_check` CHECK (((`user_id` IS NOT NULL AND `branch_id` IS NULL AND `board_id` IS NULL) OR (`user_id` IS NULL AND `branch_id` IS NOT NULL AND `board_id` IS NULL) OR (`user_id` IS NULL AND `branch_id` IS NULL AND `board_id` IS NOT NULL))),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`branch_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`board_id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `profile_images_user_position_idx` ON `profile_images` (`user_id`,`position`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `profile_images_branch_position_idx` ON `profile_images` (`branch_id`,`position`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `profile_images_board_position_idx` ON `profile_images` (`board_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `profile_images_one_primary_user_idx` ON `profile_images` (`user_id`) WHERE `profile_images`.`user_id` IS NOT NULL AND `profile_images`.`is_primary` = 1;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `profile_images_one_primary_branch_idx` ON `profile_images` (`branch_id`) WHERE `profile_images`.`branch_id` IS NOT NULL AND `profile_images`.`is_primary` = 1;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `profile_images_one_primary_board_idx` ON `profile_images` (`board_id`) WHERE `profile_images`.`board_id` IS NOT NULL AND `profile_images`.`is_primary` = 1;
