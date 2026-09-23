SET LOCAL lock_timeout = '3s';--> statement-breakpoint
ALTER TABLE "profile_images" ADD COLUMN "board_id" varchar(36);--> statement-breakpoint
ALTER TABLE "profile_images" DROP CONSTRAINT "profile_images_subject_xor_check";--> statement-breakpoint
ALTER TABLE "profile_images" ADD CONSTRAINT "profile_images_subject_xor_check" CHECK ((
  ("user_id" IS NOT NULL AND "branch_id" IS NULL AND "board_id" IS NULL) OR
  ("user_id" IS NULL AND "branch_id" IS NOT NULL AND "board_id" IS NULL) OR
  ("user_id" IS NULL AND "branch_id" IS NULL AND "board_id" IS NOT NULL)
));--> statement-breakpoint
ALTER TABLE "profile_images" ADD CONSTRAINT "profile_images_board_id_boards_board_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("board_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_images" ALTER CONSTRAINT "profile_images_board_id_boards_board_id_fk" DEFERRABLE INITIALLY IMMEDIATE;--> statement-breakpoint
CREATE INDEX "profile_images_tenant_board_position_idx" ON "profile_images" USING btree ("tenant_id","board_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "profile_images_one_primary_board_idx" ON "profile_images" USING btree ("tenant_id","board_id") WHERE "profile_images"."board_id" IS NOT NULL AND "profile_images"."is_primary" = true;
