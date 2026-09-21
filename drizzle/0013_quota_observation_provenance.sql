ALTER TABLE "quota_snapshots" ADD COLUMN "observation_id" text;--> statement-breakpoint
ALTER TABLE "quota_snapshots" ADD COLUMN "scope" text DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "quota_snapshots" ADD COLUMN "source_kind" text DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "quota_snapshots" ADD COLUMN "attribution_mode" text DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "quota_snapshots" ADD COLUMN "availability" text DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "quota_snapshots" ADD COLUMN "provenance_version" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "quota_snapshots_observation_idx" ON "quota_snapshots" USING btree ("tenant_id","connection_id","observation_id");