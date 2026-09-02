CREATE TABLE `zone_workflow_transitions` (
  `transition_id` text PRIMARY KEY NOT NULL,
  `board_id` text NOT NULL REFERENCES `boards`(`board_id`) ON DELETE CASCADE,
  `source_zone_id` text NOT NULL,
  `target_zone_id` text NOT NULL,
  `label` text NOT NULL,
  `reason` text,
  `enabled` integer DEFAULT true NOT NULL,
  `behavior` text DEFAULT 'guidance_only' NOT NULL,
  `created_by` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `zone_workflow_transitions_board_idx` ON `zone_workflow_transitions` (`board_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `zone_workflow_transitions_board_pair_uq` ON `zone_workflow_transitions` (`board_id`,`source_zone_id`,`target_zone_id`);
--> statement-breakpoint
CREATE TABLE `zone_workflow_advances` (
  `advance_id` text PRIMARY KEY NOT NULL,
  `transition_id` text NOT NULL,
  `board_id` text NOT NULL REFERENCES `boards`(`board_id`) ON DELETE CASCADE,
  `idempotency_key` text NOT NULL,
  `source_zone_id` text NOT NULL,
  `target_zone_id` text NOT NULL,
  `transition_label` text NOT NULL,
  `transition_reason` text,
  `behavior` text NOT NULL,
  `entities` text NOT NULL,
  `requested_by` text NOT NULL,
  `requested_at` integer NOT NULL,
  `prompt_outcome` text DEFAULT 'not_requested' NOT NULL,
  `prompt_error` text
);
--> statement-breakpoint
CREATE INDEX `zone_workflow_advances_board_idx` ON `zone_workflow_advances` (`board_id`);
--> statement-breakpoint
CREATE INDEX `zone_workflow_advances_transition_idx` ON `zone_workflow_advances` (`transition_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `zone_workflow_advances_idempotency_uq` ON `zone_workflow_advances` (`idempotency_key`);
