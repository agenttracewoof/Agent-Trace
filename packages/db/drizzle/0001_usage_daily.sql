CREATE TABLE "usage_daily" (
	"project_id" uuid NOT NULL,
	"day" date NOT NULL,
	"decisions_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_project_id_day_pk" PRIMARY KEY("project_id","day"),
	CONSTRAINT "usage_daily_count_non_negative" CHECK ("usage_daily"."decisions_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;