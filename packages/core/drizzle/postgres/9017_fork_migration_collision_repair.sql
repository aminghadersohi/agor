-- Repair fork migrations that can be skipped by Drizzle's timestamp-only
-- watermark when upgrading either historical OAuth DCR head. Never replaces an
-- existing relation: complete known shapes are preserved and partial shapes
-- fail closed for operator review.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DO $$
DECLARE
  auto_archive_columns integer;
  valid_auto_archive_columns integer;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE
    (column_name = 'auto_archive' AND data_type = 'text' AND is_nullable = 'NO')
    OR (column_name = 'auto_archive_after_seconds' AND data_type = 'integer')
    OR (column_name = 'auto_archive_at' AND data_type = 'timestamp with time zone')
  )
  INTO auto_archive_columns, valid_auto_archive_columns
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'sessions'
    AND column_name IN ('auto_archive', 'auto_archive_after_seconds', 'auto_archive_at');

  IF auto_archive_columns = 0 THEN
    ALTER TABLE "sessions" ADD COLUMN "auto_archive" text DEFAULT 'never' NOT NULL;
    ALTER TABLE "sessions" ADD COLUMN "auto_archive_after_seconds" integer;
    ALTER TABLE "sessions" ADD COLUMN "auto_archive_at" timestamp with time zone;
    CREATE POLICY "session_auto_archive_migration_9017" ON "sessions"
      FOR UPDATE
      USING (current_setting('agor.system_scope', true) = 'session_auto_archive_migration_9017')
      WITH CHECK (current_setting('agor.system_scope', true) = 'session_auto_archive_migration_9017');
    PERFORM set_config('agor.system_scope', 'session_auto_archive_migration_9017', true);
    UPDATE "sessions"
      SET "auto_archive" = 'after_completion', "auto_archive_after_seconds" = 300
      WHERE "data"->>'fork_origin' = 'btw';
    PERFORM set_config('agor.system_scope', '', true);
    DROP POLICY "session_auto_archive_migration_9017" ON "sessions";
  ELSIF auto_archive_columns <> 3 OR valid_auto_archive_columns <> 3 THEN
    RAISE EXCEPTION 'unrecognized partial session auto-archive schema; refusing automatic reconciliation';
  END IF;

  IF to_regclass('public.sessions_auto_archive_due_idx') IS NULL THEN
    CREATE INDEX "sessions_auto_archive_due_idx" ON "sessions"
      ("tenant_id", "archived", "auto_archive", "auto_archive_at", "session_id");
  END IF;
  DROP POLICY IF EXISTS "session_auto_archive_discovery" ON "sessions";
  CREATE POLICY "session_auto_archive_discovery" ON "sessions"
    FOR SELECT
    USING (
      "archived" = false
      AND "auto_archive" = 'after_completion'
      AND "auto_archive_at" IS NOT NULL
      AND current_setting('agor.system_scope', true) = 'session_auto_archive_discovery'
    );
END $$;
--> statement-breakpoint
DO $$
DECLARE
  workflow_relations integer;
BEGIN
  SELECT COUNT(*) INTO workflow_relations
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND c.relname IN ('zone_workflow_transitions', 'zone_workflow_advances');

  IF workflow_relations = 0 THEN
    CREATE TABLE "zone_workflow_transitions" (
      "tenant_id" text DEFAULT 'default' NOT NULL,
      "transition_id" varchar(36) PRIMARY KEY NOT NULL,
      "board_id" varchar(36) NOT NULL,
      "source_zone_id" text NOT NULL,
      "target_zone_id" text NOT NULL,
      "label" text NOT NULL,
      "reason" text,
      "enabled" boolean DEFAULT true NOT NULL,
      "behavior" text DEFAULT 'guidance_only' NOT NULL,
      "created_by" varchar(36) NOT NULL,
      "created_at" timestamp with time zone NOT NULL,
      "updated_at" timestamp with time zone NOT NULL,
      CONSTRAINT "zone_workflow_transitions_tenant_board_fk"
        FOREIGN KEY ("tenant_id", "board_id")
        REFERENCES "public"."boards"("tenant_id", "board_id")
        ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
    );
    CREATE INDEX "zone_workflow_transitions_tenant_id_idx"
      ON "zone_workflow_transitions" ("tenant_id");
    CREATE INDEX "zone_workflow_transitions_board_idx"
      ON "zone_workflow_transitions" ("board_id");
    CREATE UNIQUE INDEX "zone_workflow_transitions_tenant_board_pair_uq"
      ON "zone_workflow_transitions"
      ("tenant_id", "board_id", "source_zone_id", "target_zone_id");

    CREATE TABLE "zone_workflow_advances" (
      "tenant_id" text DEFAULT 'default' NOT NULL,
      "advance_id" varchar(36) PRIMARY KEY NOT NULL,
      "transition_id" varchar(36) NOT NULL,
      "board_id" varchar(36) NOT NULL,
      "idempotency_key" varchar(36) NOT NULL,
      "source_zone_id" text NOT NULL,
      "target_zone_id" text NOT NULL,
      "transition_label" text NOT NULL,
      "transition_reason" text,
      "behavior" text NOT NULL,
      "entities" jsonb NOT NULL,
      "requested_by" varchar(36) NOT NULL,
      "requested_at" timestamp with time zone NOT NULL,
      "prompt_outcome" text DEFAULT 'not_requested' NOT NULL,
      "prompt_error" text,
      CONSTRAINT "zone_workflow_advances_tenant_board_fk"
        FOREIGN KEY ("tenant_id", "board_id")
        REFERENCES "public"."boards"("tenant_id", "board_id")
        ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
    );
    CREATE INDEX "zone_workflow_advances_tenant_id_idx"
      ON "zone_workflow_advances" ("tenant_id");
    CREATE INDEX "zone_workflow_advances_board_idx"
      ON "zone_workflow_advances" ("board_id");
    CREATE INDEX "zone_workflow_advances_transition_idx"
      ON "zone_workflow_advances" ("transition_id");
    CREATE UNIQUE INDEX "zone_workflow_advances_tenant_idempotency_uq"
      ON "zone_workflow_advances" ("tenant_id", "idempotency_key");

    ALTER TABLE "zone_workflow_transitions" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "zone_workflow_transitions" FORCE ROW LEVEL SECURITY;
    CREATE POLICY "tenant_isolation_zone_workflow_transitions"
      ON "zone_workflow_transitions"
      USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
      WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
    ALTER TABLE "zone_workflow_advances" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "zone_workflow_advances" FORCE ROW LEVEL SECURITY;
    CREATE POLICY "tenant_isolation_zone_workflow_advances"
      ON "zone_workflow_advances"
      USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
      WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
  ELSIF workflow_relations <> 2 THEN
    RAISE EXCEPTION 'unrecognized partial zone workflow schema; refusing automatic reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('zone_workflow_transitions', 'zone_workflow_advances')
      AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'zone workflow relations must retain forced row-level security';
  END IF;
END $$;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
