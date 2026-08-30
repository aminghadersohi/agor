SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "profile_images" ADD COLUMN "identity_model_provider" text;--> statement-breakpoint
ALTER TABLE "profile_images" ADD COLUMN "identity_model_task_id" text;--> statement-breakpoint
ALTER TABLE "profile_images" ADD COLUMN "identity_model_status" text;--> statement-breakpoint
ALTER TABLE "profile_images" ADD COLUMN "identity_model_progress" integer;--> statement-breakpoint
ALTER TABLE "profile_images" ADD COLUMN "identity_model_data" bytea;--> statement-breakpoint
ALTER TABLE "profile_images" ADD COLUMN "identity_model_content_type" text;--> statement-breakpoint
ALTER TABLE "profile_images" ADD COLUMN "identity_model_error" text;--> statement-breakpoint
ALTER TABLE "profile_images" ADD COLUMN "identity_model_created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "profile_images" ADD COLUMN "identity_model_updated_at" timestamp with time zone;
