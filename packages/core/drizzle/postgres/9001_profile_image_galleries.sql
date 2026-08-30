SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TABLE "profile_images" (
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"image_id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36),
	"branch_id" varchar(36),
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
	CONSTRAINT "profile_images_subject_xor_check" CHECK ((("user_id" IS NOT NULL AND "branch_id" IS NULL) OR ("user_id" IS NULL AND "branch_id" IS NOT NULL))),
	CONSTRAINT "profile_images_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "profile_images_branch_id_branches_branch_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("branch_id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
ALTER TABLE "profile_images" ALTER CONSTRAINT "profile_images_user_id_users_user_id_fk" DEFERRABLE INITIALLY IMMEDIATE;--> statement-breakpoint
ALTER TABLE "profile_images" ALTER CONSTRAINT "profile_images_branch_id_branches_branch_id_fk" DEFERRABLE INITIALLY IMMEDIATE;--> statement-breakpoint
CREATE INDEX "profile_images_tenant_user_position_idx" ON "profile_images" USING btree ("tenant_id","user_id","position");--> statement-breakpoint
CREATE INDEX "profile_images_tenant_branch_position_idx" ON "profile_images" USING btree ("tenant_id","branch_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_images_one_primary_user_idx" ON "profile_images" USING btree ("tenant_id","user_id") WHERE "profile_images"."user_id" IS NOT NULL AND "profile_images"."is_primary" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_images_one_primary_branch_idx" ON "profile_images" USING btree ("tenant_id","branch_id") WHERE "profile_images"."branch_id" IS NOT NULL AND "profile_images"."is_primary" = true;--> statement-breakpoint
ALTER TABLE "profile_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_images" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "tenant_isolation_profile_images" ON "profile_images"
  USING ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'))
  WITH CHECK ("tenant_id" = COALESCE(NULLIF(current_setting('agor.tenant_id', true), ''), 'default'));
