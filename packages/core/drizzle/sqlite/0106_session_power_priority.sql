ALTER TABLE `sessions` ADD `power_priority` text DEFAULT 'normal' NOT NULL;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `power_priority_updated_at` integer;
--> statement-breakpoint
ALTER TABLE `sessions` ADD `power_priority_updated_by` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_essential_power_priority_uq` ON `sessions` (`power_priority`) WHERE `power_priority` = 'essential';
