ALTER TABLE "decisions" DROP CONSTRAINT "decisions_anchor_shape";--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_anchor_shape" CHECK (
        ("decisions"."status" = 'anchored') = ("decisions"."anchor_slot" IS NOT NULL)
        AND ("decisions"."anchor_slot" IS NULL) = ("decisions"."anchored_at" IS NULL)
        AND ("decisions"."anchor_slot" IS NULL OR "decisions"."anchor_signature" IS NOT NULL)
      );