-- Per-user unseen session attention (restores fork PR #21).
--
-- `sessions.attention_generation` is a shared, monotonic counter advanced each
-- time a session settles into a result that needs a human. Each user's
-- acknowledgement lives in `session_attention_states`, so opening a session
-- clears the badge for that user (on all of their devices) without clearing it
-- for anyone else and without touching the shared `ready_for_prompt` flag.
--
-- EXISTING-DATABASE NOTE
-- ------------------------------------------------------------------------
-- An earlier deploy of this feature (fork migration 9009, since dropped from the
-- journal) left both objects behind on some fork databases, with rows in the
-- acknowledgement table. That migration sits BELOW those databases' applied
-- watermark while this one sits above it, so an unguarded CREATE/ADD here would
-- abort the pending batch (42P07 / 42701). Every DDL statement is therefore
-- conditional, and the verification block below re-checks each object this
-- migration guarantees before any data is touched: a pre-existing table or
-- column of a DIFFERENT shape raises for operator review instead of being
-- silently accepted. Harmless extras (additional nullable columns, indexes,
-- policies) are tolerated.
--
-- The backfill is written once for both starting points:
--   * fresh: the column was just added (all 0) and the table is empty, so
--     sessions currently flagged ready_for_prompt get generation 1 and every
--     other session stays at 0 -- identical to the original migration;
--   * pre-existing: the generation stopped advancing when the earlier deploy
--     was replaced, while the shared ready_for_prompt flag kept being set by
--     task settlement and cleared by opening a session. The flag is therefore
--     the freshest statement of "not yet looked at", so it is carried over:
--     flagged sessions are raised above every recorded acknowledgement (unseen
--     for everyone), and unflagged sessions are recorded as seen for every user
--     of their tenant. Acknowledgement rows are only ever inserted or raised,
--     never lowered or deleted, matching the runtime's monotonic upsert.
-- Replaying this file is harmless: every statement is conditional and the
-- backfill converges.
--
-- Runtime RLS stays forced. Migration-only policies, scoped to a transaction
-- local agor.system_scope value, expose the three tables to the backfill and
-- are dropped before the migration ends (same pattern as
-- 0113_session_recency_not_null), so this works under NOSUPERUSER/NOBYPASSRLS.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
LOCK TABLE "sessions" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "attention_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_tenant_session_id_unique"
	ON "sessions" ("tenant_id", "session_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_attention_states" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"seen_attention_generation" integer DEFAULT 0 NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_attention_states_tenant_id_user_id_session_id_pk"
		PRIMARY KEY("tenant_id", "user_id", "session_id"),
	CONSTRAINT "session_attention_states_tenant_user_fk"
		FOREIGN KEY ("tenant_id", "user_id")
		REFERENCES "public"."users"("tenant_id", "user_id")
		ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "session_attention_states_tenant_session_fk"
		FOREIGN KEY ("tenant_id", "session_id")
		REFERENCES "public"."sessions"("tenant_id", "session_id")
		ON DELETE cascade ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE
);--> statement-breakpoint
DO $$
DECLARE
  fk text;
BEGIN
  -- Tenant import defers every manifest FK; a pre-existing table must match.
  FOREACH fk IN ARRAY ARRAY[
    'session_attention_states_tenant_user_fk',
    'session_attention_states_tenant_session_fk'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.session_attention_states'::regclass
        AND conname = fk AND contype = 'f'
        AND NOT (condeferrable AND NOT condeferred)
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.session_attention_states ALTER CONSTRAINT %I DEFERRABLE INITIALLY IMMEDIATE',
        fk
      );
    END IF;
  END LOOP;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_attention_states_tenant_session_idx"
	ON "session_attention_states" ("tenant_id", "session_id");--> statement-breakpoint
ALTER TABLE "session_attention_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_attention_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.session_attention_states'::regclass
      AND polname = 'tenant_isolation_session_attention_states'
  ) THEN
    CREATE POLICY "tenant_isolation_session_attention_states" ON "session_attention_states"
      USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
      WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
  END IF;
END $$;--> statement-breakpoint
-- Verification. Everything above is conditional, so this is the statement that
-- enforces the migration's contract, and it runs before the backfill so an
-- incompatible pre-existing shape stops the deploy without touching data.
DO $$
DECLARE
  missing text[] := ARRAY[]::text[];
  spec text[];
  fk_spec text[];
  actual_type text;
  actual_nullable text;
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ARRAY['sessions', 'attention_generation', 'integer'],
    ARRAY['session_attention_states', 'tenant_id', 'text'],
    ARRAY['session_attention_states', 'user_id', 'character varying'],
    ARRAY['session_attention_states', 'session_id', 'character varying'],
    ARRAY['session_attention_states', 'seen_attention_generation', 'integer'],
    ARRAY['session_attention_states', 'seen_at', 'timestamp with time zone']
  ] LOOP
    SELECT data_type, is_nullable INTO actual_type, actual_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = spec[1] AND column_name = spec[2];
    IF actual_type IS NULL THEN
      missing := missing || format('column %s.%s', spec[1], spec[2]);
    ELSIF actual_type <> spec[3] OR actual_nullable <> 'NO' THEN
      missing := missing || format(
        'column %s.%s as %s NOT NULL (found %s, nullable=%s)',
        spec[1], spec[2], spec[3], actual_type, actual_nullable
      );
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = 'public.session_attention_states'::regclass AND c.contype = 'p'
      AND (
        SELECT array_agg(a.attname::text ORDER BY k.ord)
        FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      ) = ARRAY['tenant_id', 'user_id', 'session_id']
  ) THEN
    missing := missing || 'primary key (tenant_id, user_id, session_id)'::text;
  END IF;

  FOREACH fk_spec SLICE 1 IN ARRAY ARRAY[
    ARRAY['user_id', 'users'],
    ARRAY['session_id', 'sessions']
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      WHERE c.conrelid = 'public.session_attention_states'::regclass AND c.contype = 'f'
        AND c.confrelid = ('public.' || fk_spec[2])::regclass
        AND c.confdeltype = 'c' AND c.condeferrable AND NOT c.condeferred
        AND (
          SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        ) = ARRAY['tenant_id', fk_spec[1]]
        AND (
          SELECT array_agg(a.attname::text ORDER BY k.ord)
          FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord)
          JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
        ) = ARRAY['tenant_id', fk_spec[1]]
    ) THEN
      missing := missing || format(
        'deferrable cascading foreign key (tenant_id, %s) -> %s', fk_spec[1], fk_spec[2]
      );
    END IF;
  END LOOP;

  IF to_regclass('public.session_attention_states_tenant_session_idx') IS NULL THEN
    missing := missing || 'index session_attention_states_tenant_session_idx'::text;
  END IF;
  IF to_regclass('public.sessions_tenant_session_id_unique') IS NULL THEN
    missing := missing || 'index sessions_tenant_session_id_unique'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.session_attention_states'::regclass
      AND relrowsecurity AND relforcerowsecurity
  ) THEN
    missing := missing || 'forced row level security'::text;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.session_attention_states'::regclass
      AND polname = 'tenant_isolation_session_attention_states'
  ) THEN
    missing := missing || 'policy tenant_isolation_session_attention_states'::text;
  END IF;

  IF array_length(missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'session attention schema exists but is incompatible with 9032_session_attention_states; missing: %',
      array_to_string(missing, ', ');
  END IF;
END $$;--> statement-breakpoint
LOCK TABLE "session_attention_states" IN EXCLUSIVE MODE;--> statement-breakpoint
CREATE POLICY "session_attention_9032_sessions_select" ON "sessions"
	FOR SELECT USING (current_setting('agor.system_scope', true) = 'session_attention_9032');--> statement-breakpoint
CREATE POLICY "session_attention_9032_sessions_update" ON "sessions"
	FOR UPDATE USING (current_setting('agor.system_scope', true) = 'session_attention_9032')
	WITH CHECK (current_setting('agor.system_scope', true) = 'session_attention_9032');--> statement-breakpoint
CREATE POLICY "session_attention_9032_users_select" ON "users"
	FOR SELECT USING (current_setting('agor.system_scope', true) = 'session_attention_9032');--> statement-breakpoint
CREATE POLICY "session_attention_9032_states_all" ON "session_attention_states"
	USING (current_setting('agor.system_scope', true) = 'session_attention_9032')
	WITH CHECK (current_setting('agor.system_scope', true) = 'session_attention_9032');--> statement-breakpoint
SELECT set_config('agor.system_scope', 'session_attention_9032', true);--> statement-breakpoint
-- Flagged sessions: unseen for everyone.
UPDATE "sessions" s
SET "attention_generation" = seen."max_seen" + 1
FROM (
	SELECT s2."tenant_id", s2."session_id", COALESCE(MAX(a."seen_attention_generation"), 0) AS "max_seen"
	FROM "sessions" s2
	LEFT JOIN "session_attention_states" a
		ON a."tenant_id" = s2."tenant_id" AND a."session_id" = s2."session_id"
	WHERE s2."ready_for_prompt" = true
	GROUP BY s2."tenant_id", s2."session_id"
) seen
WHERE s."tenant_id" = seen."tenant_id"
	AND s."session_id" = seen."session_id"
	AND s."attention_generation" <= seen."max_seen";--> statement-breakpoint
-- Unflagged sessions: never below an acknowledgement already recorded...
UPDATE "sessions" s
SET "attention_generation" = seen."max_seen"
FROM (
	SELECT "tenant_id", "session_id", MAX("seen_attention_generation") AS "max_seen"
	FROM "session_attention_states"
	GROUP BY "tenant_id", "session_id"
) seen
WHERE s."tenant_id" = seen."tenant_id"
	AND s."session_id" = seen."session_id"
	AND s."ready_for_prompt" = false
	AND s."attention_generation" < seen."max_seen";--> statement-breakpoint
-- ...and seen by every user of the tenant.
INSERT INTO "session_attention_states"
	("tenant_id", "user_id", "session_id", "seen_attention_generation", "seen_at")
SELECT s."tenant_id", u."user_id", s."session_id", s."attention_generation", CURRENT_TIMESTAMP
FROM "sessions" s
JOIN "users" u ON u."tenant_id" = s."tenant_id"
WHERE s."ready_for_prompt" = false AND s."attention_generation" > 0
ON CONFLICT ("tenant_id", "user_id", "session_id") DO UPDATE
SET "seen_attention_generation" = EXCLUDED."seen_attention_generation",
	"seen_at" = EXCLUDED."seen_at"
WHERE "session_attention_states"."seen_attention_generation" < EXCLUDED."seen_attention_generation";--> statement-breakpoint
DROP POLICY "session_attention_9032_sessions_select" ON "sessions";--> statement-breakpoint
DROP POLICY "session_attention_9032_sessions_update" ON "sessions";--> statement-breakpoint
DROP POLICY "session_attention_9032_users_select" ON "users";--> statement-breakpoint
DROP POLICY "session_attention_9032_states_all" ON "session_attention_states";--> statement-breakpoint
SELECT set_config('agor.system_scope', '', true);--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
