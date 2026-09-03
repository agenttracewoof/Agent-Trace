CREATE TYPE "public"."decision_status" AS ENUM('pending', 'anchored', 'failed');--> statement-breakpoint
CREATE TYPE "public"."rotation_kind" AS ENUM('initial', 'chained', 'administrative');--> statement-breakpoint
CREATE TABLE "agent_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"public_key" varchar(64) NOT NULL,
	"valid_from" bigint NOT NULL,
	"valid_to" bigint,
	"rotation_kind" "rotation_kind" NOT NULL,
	"prev_key_id" uuid,
	"rotation_proof" varchar(128),
	"confirmed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_keys_public_key_hex" CHECK ("agent_keys"."public_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "agent_keys_rotation_proof_hex" CHECK ("agent_keys"."rotation_proof" IS NULL OR "agent_keys"."rotation_proof" ~ '^[0-9a-f]{128}$'),
	CONSTRAINT "agent_keys_rotation_shape" CHECK (
        ("agent_keys"."rotation_kind" = 'initial'
          AND "agent_keys"."prev_key_id" IS NULL
          AND "agent_keys"."rotation_proof" IS NULL
          AND "agent_keys"."confirmed_by" IS NULL)
        OR ("agent_keys"."rotation_kind" = 'chained'
          AND "agent_keys"."prev_key_id" IS NOT NULL
          AND "agent_keys"."rotation_proof" IS NOT NULL)
        OR ("agent_keys"."rotation_kind" = 'administrative'
          AND "agent_keys"."prev_key_id" IS NOT NULL
          AND "agent_keys"."rotation_proof" IS NOT NULL
          AND "agent_keys"."confirmed_by" IS NOT NULL)
      ),
	CONSTRAINT "agent_keys_validity_window" CHECK ("agent_keys"."valid_to" IS NULL OR "agent_keys"."valid_to" > "agent_keys"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "agent_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"external_id" varchar(128) NOT NULL,
	"name" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_key_id" uuid NOT NULL,
	"manifest_version" smallint DEFAULT 1 NOT NULL,
	"root" varchar(64) NOT NULL,
	"signature" varchar(128) NOT NULL,
	"decided_at" bigint NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"model_ref" varchar(128) NOT NULL,
	"sources" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"outcome" jsonb NOT NULL,
	"status" "decision_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anchor_signature" varchar(88),
	"anchor_slot" bigint,
	"anchored_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"archive_url" text,
	"content_deleted_at" timestamp with time zone,
	CONSTRAINT "decisions_root_hex" CHECK ("decisions"."root" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "decisions_signature_hex" CHECK ("decisions"."signature" ~ '^[0-9a-f]{128}$'),
	CONSTRAINT "decisions_decided_at_range" CHECK ("decisions"."decided_at" BETWEEN 0 AND 9007199254740991),
	CONSTRAINT "decisions_anchor_shape" CHECK (
        ("decisions"."status" = 'anchored') = ("decisions"."anchor_signature" IS NOT NULL)
        AND ("decisions"."anchor_signature" IS NULL) = ("decisions"."anchor_slot" IS NULL)
        AND ("decisions"."anchor_signature" IS NULL) = ("decisions"."anchored_at" IS NULL)
      ),
	CONSTRAINT "decisions_archive_shape" CHECK (("decisions"."archived_at" IS NULL) = ("decisions"."archive_url" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "decisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(128) NOT NULL,
	"ingest_key_hash" varchar(64) NOT NULL,
	"hot_window_days" integer DEFAULT 14 NOT NULL,
	"daily_quota" integer DEFAULT 10000 NOT NULL,
	"archive_bucket" text,
	"archive_prefix" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_ingest_key_hash_hex" CHECK ("projects"."ingest_key_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "projects" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_keys" ADD CONSTRAINT "agent_keys_prev_key_id_agent_keys_id_fk" FOREIGN KEY ("prev_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agent_key_id_agent_keys_id_fk" FOREIGN KEY ("agent_key_id") REFERENCES "public"."agent_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_keys_public_key_key" ON "agent_keys" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX "agent_keys_agent_valid_from_idx" ON "agent_keys" USING btree ("agent_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_project_external_key" ON "agents" USING btree ("project_id","external_id");--> statement-breakpoint
CREATE INDEX "decisions_pending_idx" ON "decisions" USING btree ("next_attempt_at") WHERE "decisions"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "decisions_journal_idx" ON "decisions" USING btree ("project_id","decided_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "decisions_journal_agent_idx" ON "decisions" USING btree ("project_id","agent_id","decided_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "projects_ingest_key_hash_key" ON "projects" USING btree ("ingest_key_hash");