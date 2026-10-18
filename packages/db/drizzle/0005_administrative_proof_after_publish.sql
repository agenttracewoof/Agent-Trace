ALTER TABLE "agent_keys" DROP CONSTRAINT "agent_keys_rotation_shape";--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_rotation_shape" CHECK (
        ("agent_keys"."rotation_kind" = 'initial'
          AND "agent_keys"."prev_key_id" IS NULL
          AND "agent_keys"."rotation_proof" IS NULL
          AND "agent_keys"."confirmed_by" IS NULL)
        OR ("agent_keys"."rotation_kind" = 'chained'
          AND "agent_keys"."prev_key_id" IS NOT NULL
          AND "agent_keys"."rotation_proof" IS NOT NULL)
        OR ("agent_keys"."rotation_kind" = 'administrative'
          AND "agent_keys"."prev_key_id" IS NOT NULL
          AND "agent_keys"."confirmed_by" IS NOT NULL)
      );