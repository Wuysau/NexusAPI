CREATE TABLE "legacy_migration_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"source_table" text NOT NULL,
	"source_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"source_digest" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text
);
--> statement-breakpoint
CREATE TABLE "legacy_migration_runs" (
	"namespace" text PRIMARY KEY NOT NULL,
	"source_digest" text NOT NULL,
	"manifest_digest" text NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legacy_usage_archive" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"source_digest" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cached_tokens" integer,
	"reasoning_tokens" integer,
	"project_id" text,
	"downstream_key_id" text,
	"price_version_id" text,
	"cost_amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"estimated_amount" boolean DEFAULT true NOT NULL,
	"status" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "legacy_migration_mappings" ADD CONSTRAINT "legacy_migration_mappings_namespace_legacy_migration_runs_namespace_fk" FOREIGN KEY ("namespace") REFERENCES "public"."legacy_migration_runs"("namespace") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_usage_archive" ADD CONSTRAINT "legacy_usage_archive_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_mapping_source_target_idx" ON "legacy_migration_mappings" USING btree ("namespace","source_table","source_id","target_kind");