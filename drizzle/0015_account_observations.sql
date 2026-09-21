ALTER TABLE "owned_connections" ADD COLUMN "account_observation" jsonb;--> statement-breakpoint
ALTER TABLE "quota_snapshots" ADD COLUMN "metadata" jsonb;