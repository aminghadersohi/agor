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
  CONSTRAINT "zone_workflow_transitions_tenant_board_fk" FOREIGN KEY ("tenant_id","board_id") REFERENCES "public"."boards"("tenant_id","board_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "zone_workflow_transitions_tenant_id_idx" ON "zone_workflow_transitions" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "zone_workflow_transitions_board_idx" ON "zone_workflow_transitions" ("board_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "zone_workflow_transitions_tenant_board_pair_uq" ON "zone_workflow_transitions" ("tenant_id","board_id","source_zone_id","target_zone_id");
--> statement-breakpoint
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
  CONSTRAINT "zone_workflow_advances_tenant_board_fk" FOREIGN KEY ("tenant_id","board_id") REFERENCES "public"."boards"("tenant_id","board_id") ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE
);
--> statement-breakpoint
CREATE INDEX "zone_workflow_advances_tenant_id_idx" ON "zone_workflow_advances" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "zone_workflow_advances_board_idx" ON "zone_workflow_advances" ("board_id");
--> statement-breakpoint
CREATE INDEX "zone_workflow_advances_transition_idx" ON "zone_workflow_advances" ("transition_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "zone_workflow_advances_tenant_idempotency_uq" ON "zone_workflow_advances" ("tenant_id","idempotency_key");
--> statement-breakpoint
ALTER TABLE "zone_workflow_transitions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zone_workflow_transitions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_zone_workflow_transitions" ON "zone_workflow_transitions"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
--> statement-breakpoint
ALTER TABLE "zone_workflow_advances" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "zone_workflow_advances" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "tenant_isolation_zone_workflow_advances" ON "zone_workflow_advances"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
