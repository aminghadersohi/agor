-- Restore the fork-only `sessions` columns removed by the upstream table
-- rebuild in `0113_session_recency_not_null`.
--
-- Why this is needed: `auto_archive*` (0104) and `power_priority*` (0106) exist
-- only on this fork — no upstream migration or schema declares them. Upstream's
-- 0113 rebuilds `sessions` with the SQLite `__new_sessions` pattern from a
-- snapshot generated against the upstream schema, which never knew about these
-- six columns. On upstream that rebuild is lossless; here it silently drops
-- them, so every insert against `schema.sqlite.ts` fails on a fresh database.
-- The upstream file is correct for upstream; this is a fork integration repair.
--
-- Ordering is the safety argument. This migration is journalled strictly after
-- 0113 (idx 9031 > 9030), and 0113 unconditionally drops and recreates
-- `sessions` into a deterministic 23-column shape, so these columns are
-- guaranteed absent at this point. SQLite has no `ADD COLUMN IF NOT EXISTS`
-- and no `DO` block, so a duplicate-column error here would mean 0113 did not
-- run as journalled — which must fail loudly for operator review rather than
-- be silently absorbed.
--
-- Column types, defaults and nullability are copied verbatim from 0104/0106 and
-- match `schema.sqlite.ts`. Postgres needs no equivalent: its 0113 is a single
-- `ALTER TABLE` that rebuilds nothing.
ALTER TABLE `sessions` ADD `power_priority` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `power_priority_updated_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `power_priority_updated_by` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_archive` text DEFAULT 'never' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_archive_after_seconds` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `auto_archive_at` integer;--> statement-breakpoint
-- Replay 0104's backfill: the rebuild discarded the column that held it.
UPDATE `sessions`
SET `auto_archive` = 'after_completion', `auto_archive_after_seconds` = 300
WHERE json_extract(`data`, '$.fork_origin') = 'btw';--> statement-breakpoint
-- Both indexes were dropped with the old table and are not recreated by 0113.
CREATE INDEX `sessions_auto_archive_due_idx` ON `sessions` (`archived`,`auto_archive`,`auto_archive_at`,`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_one_essential_power_priority_uq` ON `sessions` (`power_priority`) WHERE `power_priority` = 'essential';
