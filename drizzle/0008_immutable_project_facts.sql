CREATE TABLE "request_project_facts" (
  "request_id" text PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" text,
  "project_name" text,
  "api_key_id" text,
  "connection_id" text,
  "principal_id" text,
  "execution_mode" text NOT NULL,
  "attribution_status" text NOT NULL,
  "catalog_version_id" text,
  "policy_version_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "request_project_facts" ADD CONSTRAINT "request_project_facts_request_id_request_records_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request_records"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "request_project_facts_tenant_project_created_idx" ON "request_project_facts" USING btree ("tenant_id","project_id","created_at");
--> statement-breakpoint
ALTER TABLE "request_records" ADD COLUMN "project_id" text;
--> statement-breakpoint
ALTER TABLE "request_records" ADD COLUMN "project_name" text;
--> statement-breakpoint
ALTER TABLE "request_records" ADD COLUMN "connection_id" text;
--> statement-breakpoint
ALTER TABLE "request_records" ADD COLUMN "execution_mode" text;
--> statement-breakpoint
ALTER TABLE "request_records" ADD COLUMN "attribution_status" text;
--> statement-breakpoint
ALTER TABLE "request_records" ADD CONSTRAINT "request_records_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;
