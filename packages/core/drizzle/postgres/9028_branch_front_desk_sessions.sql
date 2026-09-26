CREATE TABLE "branch_front_desk_sessions" (
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
CREATE INDEX "branch_front_desk_sessions_tenant_id_idx" ON "branch_front_desk_sessions" ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_front_desk_slot" ON "branch_front_desk_sessions" ("tenant_id","branch_id","scope","slot") WHERE "status" IN ('active', 'retiring');
--> statement-breakpoint
CREATE INDEX "idx_front_desk_session" ON "branch_front_desk_sessions" ("tenant_id","session_id");
--> statement-breakpoint
ALTER TABLE "branch_front_desk_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "branch_front_desk_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_branch_front_desk_sessions" ON "branch_front_desk_sessions"
	USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
	WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
