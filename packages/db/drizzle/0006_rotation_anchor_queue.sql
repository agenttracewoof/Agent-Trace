ALTER TABLE "agent_keys" ADD COLUMN "anchor_status" "decision_status";--> statement-breakpoint
ALTER TABLE "agent_keys" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD COLUMN "anchor_signature" varchar(88);--> statement-breakpoint
ALTER TABLE "agent_keys" ADD COLUMN "anchor_slot" bigint;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD COLUMN "anchored_at" timestamp with time zone;--> statement-breakpoint
UPDATE "agent_keys" SET "anchor_status" = 'pending' WHERE "rotation_kind" <> 'initial';--> statement-breakpoint
CREATE INDEX "agent_keys_pending_anchor_idx" ON "agent_keys" USING btree ("next_attempt_at") WHERE "agent_keys"."anchor_status" = 'pending';--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_anchor_shape" CHECK (
        ("agent_keys"."rotation_kind" = 'initial') = ("agent_keys"."anchor_status" IS NULL)
        AND ("agent_keys"."anchor_status" IS NOT DISTINCT FROM 'anchored') = ("agent_keys"."anchor_slot" IS NOT NULL)
        AND ("agent_keys"."anchor_slot" IS NULL) = ("agent_keys"."anchored_at" IS NULL)
        AND ("agent_keys"."anchor_slot" IS NULL OR "agent_keys"."anchor_signature" IS NOT NULL)
      );