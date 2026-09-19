SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
ALTER TABLE "branches" ADD COLUMN "color_override" text;
