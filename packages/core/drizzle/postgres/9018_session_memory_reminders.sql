SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_tenant_session_id_unique" ON "sessions" ("tenant_id","session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_tenant_task_id_unique" ON "tasks" ("tenant_id","task_id");
--> statement-breakpoint
CREATE TABLE "session_memories" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"memory_id" varchar(36) PRIMARY KEY NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"title" text,
	"text" text NOT NULL,
	"tags" jsonb NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_by" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL CHECK ("revision" >= 1),
	CONSTRAINT "session_memories_tenant_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."sessions"("tenant_id","session_id") ON DELETE cascade DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "session_memories_tenant_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","user_id") DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "session_memories_tenant_id_idx" ON "session_memories" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "session_memories_session_state_updated_idx" ON "session_memories" ("tenant_id","session_id","archived","updated_at","memory_id");
--> statement-breakpoint
CREATE TABLE "session_reminders" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"reminder_id" varchar(36) PRIMARY KEY NOT NULL,
	"session_id" varchar(36) NOT NULL,
	"text" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"display_timezone" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL CHECK ("status" IN ('scheduled','claimed','queued','cancelled','blocked')),
	"created_by" varchar(36) NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL CHECK ("revision" >= 1),
	"claim_token" text,
	"claimed_at" timestamp with time zone,
	"claim_expires_at" timestamp with time zone,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"queued_at" timestamp with time zone,
	"task_id" varchar(36),
	"failure_code" text,
	CONSTRAINT "session_reminders_tenant_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."sessions"("tenant_id","session_id") ON DELETE cascade DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "session_reminders_tenant_creator_fk" FOREIGN KEY ("tenant_id","created_by") REFERENCES "public"."users"("tenant_id","user_id") DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "session_reminders_tenant_task_fk" FOREIGN KEY ("tenant_id","task_id") REFERENCES "public"."tasks"("tenant_id","task_id") DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "session_reminders_tenant_id_idx" ON "session_reminders" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "session_reminders_session_status_due_idx" ON "session_reminders" ("tenant_id","session_id","status","due_at","reminder_id");
--> statement-breakpoint
CREATE INDEX "session_reminders_due_claim_idx" ON "session_reminders" ("status","due_at","claim_expires_at","tenant_id","reminder_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "session_reminders_task_unique" ON "session_reminders" ("tenant_id","task_id") WHERE "task_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "session_memories" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "session_memories" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_session_memories" ON "session_memories"
	USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
	WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "session_reminders" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "session_reminders" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_session_reminders" ON "session_reminders"
	USING (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
	WITH CHECK (COALESCE(current_setting('agor.system_scope', true), '') = '' AND "tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
-- System discovery exposes only overdue routing identities. Workers re-enter
-- tenant scope before loading content, claiming, or dispatching.
CREATE POLICY "session_reminder_discovery" ON "session_reminders"
	FOR SELECT USING (
		current_setting('agor.system_scope', true) = 'session_reminder_discovery'
		AND (("status" = 'scheduled' AND "due_at" <= CURRENT_TIMESTAMP)
			OR ("status" = 'claimed' AND "claim_expires_at" <= CURRENT_TIMESTAMP))
	);
--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
