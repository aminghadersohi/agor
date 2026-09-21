ALTER TABLE `gateway_outbound_messages` ADD COLUMN `seed_thread_id` text;--> statement-breakpoint
UPDATE `gateway_outbound_messages` SET `seed_thread_id` = `platform_thread_id` WHERE `seed_thread_id` IS NULL;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_gateway_outbound_channel_thread`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_gateway_outbound_channel_seed_thread` ON `gateway_outbound_messages` (`gateway_channel_id`,`seed_thread_id`);--> statement-breakpoint
CREATE INDEX `idx_gateway_outbound_channel_thread` ON `gateway_outbound_messages` (`gateway_channel_id`,`platform_thread_id`);
