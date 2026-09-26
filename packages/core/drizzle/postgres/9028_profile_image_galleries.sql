-- Profile image galleries for users, branches, and boards.
--
-- Created directly in its final three-subject shape. The originating work
-- built this table over three migrations — create, add 3D identity-model
-- columns, then widen for board subjects — but the identity-model feature is
-- not part of this change, so replaying that sequence would add nine columns
-- only to leave them permanently unused.
--
-- Exactly one subject per row is enforced by a three-way XOR check rather than
-- by convention, and each subject may have at most one primary image, enforced
-- by partial unique indexes rather than by application code. Row-level security
-- is forced, and every index is tenant-scoped first, so a query cannot
-- accidentally range across tenants.
--
-- INTEGRATION NOTE (amin_dev_next, 2026-09-24)
-- ------------------------------------------------------------------------
-- On a fresh database this creates the table. On an existing fork database it
-- must be a no-op instead: amin_dev built the same table over three earlier
-- migrations (9001 create, 9002 identity-model columns, 9003 widen for board
-- subjects), all of which sit BELOW that database's applied watermark, while
-- this migration sits above it. An unguarded CREATE TABLE therefore aborted
-- the whole pending batch with 42P07 'relation profile_images already exists'
-- -- verified against a restored copy of a real deployment.
--
-- Every DDL statement below is now conditional, and the DO block at the end
-- re-checks each object this migration is supposed to guarantee. That block is
-- what makes IF NOT EXISTS safe: a pre-existing table of a DIFFERENT shape is
-- reported loudly for operator review rather than silently accepted. Extra
-- columns are tolerated on purpose -- the fork database carries nine nullable
-- identity_model_* columns this change deliberately does not define.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profile_images" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"image_id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36),
	"branch_id" varchar(36),
	"board_id" varchar(36),
	"created_by" varchar(36) NOT NULL,
	"original_name" text NOT NULL,
	"alt_text" text,
	"position" integer DEFAULT 0 NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"small_data" bytea NOT NULL,
	"small_content_type" text NOT NULL,
	"small_width" integer NOT NULL,
	"small_height" integer NOT NULL,
	"large_data" bytea NOT NULL,
	"large_content_type" text NOT NULL,
	"large_width" integer NOT NULL,
	"large_height" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "profile_images_subject_xor_check" CHECK ((
	  ("user_id" IS NOT NULL AND "branch_id" IS NULL AND "board_id" IS NULL) OR
	  ("user_id" IS NULL AND "branch_id" IS NOT NULL AND "board_id" IS NULL) OR
	  ("user_id" IS NULL AND "branch_id" IS NULL AND "board_id" IS NOT NULL)
	)),
	CONSTRAINT "profile_images_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "profile_images_branch_id_branches_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("branch_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "profile_images_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
DO $$
DECLARE
  fk text;
BEGIN
  FOREACH fk IN ARRAY ARRAY[
    'profile_images_user_id_users_user_id_fk',
    'profile_images_branch_id_branches_branch_id_fk',
    'profile_images_board_id_boards_board_id_fk'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.profile_images'::regclass AND conname = fk AND contype = 'f'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.profile_images ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE', fk
      );
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_images_tenant_user_position_idx" ON "profile_images" USING btree ("tenant_id","user_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_images_tenant_branch_position_idx" ON "profile_images" USING btree ("tenant_id","branch_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "profile_images_tenant_board_position_idx" ON "profile_images" USING btree ("tenant_id","board_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profile_images_one_primary_user_idx" ON "profile_images" USING btree ("tenant_id","user_id") WHERE "profile_images"."user_id" IS NOT NULL AND "profile_images"."is_primary" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profile_images_one_primary_branch_idx" ON "profile_images" USING btree ("tenant_id","branch_id") WHERE "profile_images"."branch_id" IS NOT NULL AND "profile_images"."is_primary" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profile_images_one_primary_board_idx" ON "profile_images" USING btree ("tenant_id","board_id") WHERE "profile_images"."board_id" IS NOT NULL AND "profile_images"."is_primary" = true;--> statement-breakpoint
ALTER TABLE "profile_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_images" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.profile_images'::regclass
      AND polname = 'tenant_isolation_profile_images'
  ) THEN
    CREATE POLICY "tenant_isolation_profile_images" ON "profile_images"
      USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
      WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
  END IF;
END $$;--> statement-breakpoint
-- Verification. Everything above is conditional, so this is the statement that
-- actually enforces the migration's contract: a pre-existing profile_images
-- that does not carry every object below is a database this change cannot
-- vouch for, and it must stop the deploy rather than be quietly accepted.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  col text;
  idx text;
BEGIN
  FOREACH col IN ARRAY ARRAY[
    'tenant_id','image_id','user_id','branch_id','board_id','created_by','original_name',
    'alt_text','position','is_primary','small_data','small_content_type','small_width',
    'small_height','large_data','large_content_type','large_width','large_height',
    'created_at','updated_at'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'profile_images' AND column_name = col
    ) THEN
      missing := missing || ('column ' || col);
    END IF;
  END LOOP;

  FOREACH idx IN ARRAY ARRAY[
    'profile_images_tenant_user_position_idx',
    'profile_images_tenant_branch_position_idx',
    'profile_images_tenant_board_position_idx',
    'profile_images_one_primary_user_idx',
    'profile_images_one_primary_branch_idx',
    'profile_images_one_primary_board_idx'
  ] LOOP
    IF to_regclass('public.' || idx) IS NULL THEN
      missing := missing || ('index ' || idx);
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.profile_images'::regclass
      AND conname = 'profile_images_subject_xor_check' AND contype = 'c'
  ) THEN
    missing := missing || 'constraint profile_images_subject_xor_check';
  END IF;

  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.profile_images'::regclass AND contype = 'f') <> 3 THEN
    missing := missing || 'three subject foreign keys';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.profile_images'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    missing := missing || 'forced row level security';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.profile_images'::regclass
      AND polname = 'tenant_isolation_profile_images'
  ) THEN
    missing := missing || 'policy tenant_isolation_profile_images';
  END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'profile_images exists but is incompatible with 9028_profile_image_galleries; missing: %',
      array_to_string(missing, ', ');
  END IF;
END $$;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
