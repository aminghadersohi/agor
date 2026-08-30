SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "attention_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "sessions"
SET "attention_generation" = 1
WHERE "ready_for_prompt" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "sessions_tenant_session_id_unique"
	ON "sessions" ("tenant_id", "session_id");--> statement-breakpoint
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
);--> statement-breakpoint
CREATE INDEX "session_attention_states_tenant_session_idx"
	ON "session_attention_states" ("tenant_id", "session_id");--> statement-breakpoint
ALTER TABLE "session_attention_states" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "session_attention_states" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_session_attention_states" ON "session_attention_states"
	USING (
		"tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
	)
	WITH CHECK (
		"tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default')
	);--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
