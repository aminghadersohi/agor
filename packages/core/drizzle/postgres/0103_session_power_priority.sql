ALTER TABLE "sessions" ADD COLUMN "power_priority" text DEFAULT 'normal' NOT NULL;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "power_priority_updated_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "power_priority_updated_by" varchar(36);
--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_one_essential_power_priority_uq" ON "sessions" ("tenant_id") WHERE "power_priority" = 'essential';
