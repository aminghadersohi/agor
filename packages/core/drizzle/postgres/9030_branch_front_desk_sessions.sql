-- Front-desk session slots per (branch, scope, slot).
--
-- WATERMARK NOTE (amin_dev_next, 2026-09-26)
-- ------------------------------------------------------------------------
-- Fork main journals this migration as 9028_branch_front_desk_sessions at
-- 1790129000214 and renumbers profile images to 9029 at 1790129000215. A live
-- amin_dev database had ALREADY applied 9028_profile_image_galleries at 214 and
-- 0113_callback_ownership_reconciliation at 215 before that renumbering, so its
-- watermark is 215. Drizzle selects pending work purely by `when`, so taking
-- fork main's journal as-is would mark front desk "applied" on that database
-- and silently never create this table.
--
-- Applied history is therefore left exactly as that database recorded it, and
-- this migration re-enters above every watermark either dialect has shipped
-- (SQLite's newest is 0114_restore_session_indexes at 1790208000000). It is
-- conditional because a database migrated by fork main already carries the
-- table; the DO block at the end re-checks every object this migration is
-- supposed to guarantee, so a pre-existing table of a DIFFERENT shape raises
-- for operator review instead of being silently accepted.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "branch_front_desk_sessions" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"branch_id" varchar(36) NOT NULL,
	"scope" text NOT NULL,
	"slot" integer NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"status" text NOT NULL,
	"promoted_at" timestamp with time zone NOT NULL,
	"promoted_by" varchar(36),
	"retired_at" timestamp with time zone,
	"retired_reason" text,
	"metadata" jsonb,
	CONSTRAINT "branch_front_desk_sessions_tenant_branch_fk" FOREIGN KEY ("tenant_id","branch_id") REFERENCES "public"."branches"("tenant_id","branch_id") ON DELETE cascade DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "branch_front_desk_sessions_tenant_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."sessions"("tenant_id","session_id") ON DELETE cascade DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "branch_front_desk_sessions_promoted_by_users_user_id_fk" FOREIGN KEY ("promoted_by") REFERENCES "public"."users"("user_id") ON DELETE set null DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "branch_front_desk_sessions_tenant_id_idx" ON "branch_front_desk_sessions" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_front_desk_slot" ON "branch_front_desk_sessions" ("tenant_id","branch_id","scope","slot") WHERE "status" IN ('active', 'retiring');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_front_desk_session" ON "branch_front_desk_sessions" ("tenant_id","session_id");
--> statement-breakpoint
ALTER TABLE "branch_front_desk_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branch_front_desk_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.branch_front_desk_sessions'::regclass
      AND polname = 'tenant_isolation_branch_front_desk_sessions'
  ) THEN
    CREATE POLICY "tenant_isolation_branch_front_desk_sessions" ON "branch_front_desk_sessions"
      USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
      WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
  END IF;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  col text;
  idx text;
  fk text;
BEGIN
  FOREACH col IN ARRAY ARRAY[
    'tenant_id','id','branch_id','scope','slot','session_id','status',
    'promoted_at','promoted_by','retired_at','retired_reason','metadata'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'branch_front_desk_sessions'
        AND column_name = col
    ) THEN
      missing := missing || ('column ' || col);
    END IF;
  END LOOP;

  FOREACH idx IN ARRAY ARRAY[
    'branch_front_desk_sessions_tenant_id_idx',
    'uniq_front_desk_slot',
    'idx_front_desk_session'
  ] LOOP
    IF to_regclass('public.' || idx) IS NULL THEN
      missing := missing || ('index ' || idx);
    END IF;
  END LOOP;

  FOREACH fk IN ARRAY ARRAY[
    'branch_front_desk_sessions_tenant_branch_fk',
    'branch_front_desk_sessions_tenant_session_fk',
    'branch_front_desk_sessions_promoted_by_users_user_id_fk'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.branch_front_desk_sessions'::regclass
        AND conname = fk AND contype = 'f'
    ) THEN
      missing := missing || ('foreign key ' || fk);
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.branch_front_desk_sessions'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    missing := missing || 'forced row level security'::text;
  END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'branch_front_desk_sessions exists but is incompatible with 9030_branch_front_desk_sessions; missing: %',
      array_to_string(missing, ', ');
  END IF;
END $$;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
