-- The archived b0585d76 DCR watermark collides with the private attention
-- migration timestamp. Restore that migration only when both projected and
-- per-user state are absent; partial or non-forced-RLS shapes fail closed.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
DO $$
DECLARE
  attention_columns integer;
  valid_attention_columns integer;
  attention_relation regclass := to_regclass('public.session_attention_states');
  state_columns integer;
  valid_state_columns integer;
  constraints_count integer;
  valid_constraints integer;
  policy_count integer;
  valid_policy_count integer;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE
    data_type = 'integer' AND is_nullable = 'NO'
  )
  INTO attention_columns, valid_attention_columns
  FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'sessions'
      AND column_name = 'attention_generation';

  IF attention_columns = 0 AND attention_relation IS NULL THEN
    ALTER TABLE "sessions" ADD COLUMN "attention_generation" integer DEFAULT 0 NOT NULL;
    UPDATE "sessions" SET "attention_generation" = 1 WHERE "ready_for_prompt" = true;
    CREATE UNIQUE INDEX IF NOT EXISTS "sessions_tenant_session_id_unique"
      ON "sessions" ("tenant_id", "session_id");
    CREATE TABLE "session_attention_states" (
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
    );
    CREATE INDEX "session_attention_states_tenant_session_idx"
      ON "session_attention_states" ("tenant_id", "session_id");
    ALTER TABLE "session_attention_states" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "session_attention_states" FORCE ROW LEVEL SECURITY;
    CREATE POLICY "tenant_isolation_session_attention_states" ON "session_attention_states"
      USING (
        "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
      )
      WITH CHECK (
        "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
      );
  ELSIF attention_columns <> 1 OR valid_attention_columns <> 1 OR attention_relation IS NULL THEN
    RAISE EXCEPTION 'unrecognized partial session attention schema; refusing automatic reconciliation';
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (WHERE
    (column_name = 'tenant_id' AND data_type = 'text' AND is_nullable = 'NO')
    OR (column_name IN ('user_id', 'session_id') AND data_type = 'character varying'
        AND character_maximum_length = 36 AND is_nullable = 'NO')
    OR (column_name = 'seen_attention_generation' AND data_type = 'integer'
        AND is_nullable = 'NO')
    OR (column_name = 'seen_at' AND data_type = 'timestamp with time zone'
        AND is_nullable = 'NO')
  )
  INTO state_columns, valid_state_columns
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'session_attention_states';

  SELECT COUNT(*), COUNT(*) FILTER (WHERE
      (conname = 'session_attention_states_tenant_id_user_id_session_id_pk'
        AND contype = 'p')
      OR (conname IN (
            'session_attention_states_tenant_user_fk',
            'session_attention_states_tenant_session_fk'
          ) AND contype = 'f' AND condeferrable AND NOT condeferred)
    )
  INTO constraints_count, valid_constraints
  FROM pg_constraint
  WHERE conrelid = 'public.session_attention_states'::regclass;

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE polname = 'tenant_isolation_session_attention_states'
  ) INTO policy_count, valid_policy_count
  FROM pg_policy
  WHERE polrelid = 'public.session_attention_states'::regclass;

  IF state_columns <> 5 OR valid_state_columns <> 5
     OR constraints_count <> 3 OR valid_constraints <> 3
     OR to_regclass('public.session_attention_states_tenant_session_idx') IS NULL
     OR to_regclass('public.sessions_tenant_session_id_unique') IS NULL
     OR policy_count <> 1 OR valid_policy_count <> 1 THEN
    RAISE EXCEPTION 'unrecognized session attention schema; refusing automatic reconciliation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = to_regclass('public.session_attention_states')
      AND (NOT relrowsecurity OR NOT relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'session attention state must retain forced row-level security';
  END IF;
END $$;
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
