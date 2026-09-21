-- Enable pgcrypto for gen_random_uuid() used as default primary keys.
CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "public"."channel_kind" AS ENUM('platform', 'byok');--> statement-breakpoint
CREATE TYPE "public"."circuit_state" AS ENUM('closed', 'open', 'half_open');--> statement-breakpoint
CREATE TYPE "public"."credential_type" AS ENUM('api_key', 'oauth_token');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ledger_type" AS ENUM('recharge', 'usage', 'refund', 'adjustment', 'promotional_credit', 'reservation', 'reservation_release');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'developer', 'billing', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."model_lifecycle" AS ENUM('draft', 'pending_review', 'active', 'deprecated', 'retired');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'paid', 'failed', 'refunded', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."org_kind" AS ENUM('platform', 'customer');--> statement-breakpoint
CREATE TYPE "public"."price_status" AS ENUM('pending', 'approved', 'active', 'superseded', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('created', 'reserved', 'sent', 'streaming', 'completed', 'failed', 'unknown', 'reconciled');--> statement-breakpoint
CREATE TYPE "public"."sale_pricing_mode" AS ENUM('cost_multiplier', 'target_margin', 'fixed', 'markup');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended', 'invited');--> statement-breakpoint
CREATE TYPE "public"."wallet_status" AS ENUM('active', 'frozen', 'closed');--> statement-breakpoint
CREATE TABLE "relay_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"budget" double precision DEFAULT 100 NOT NULL,
	"spent" double precision DEFAULT 0 NOT NULL,
	"reserved" double precision DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "relay_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" text,
	"organization_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"next_run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_health" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_credential_id" text NOT NULL,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"p50_latency_ms" integer,
	"p95_latency_ms" integer,
	"rate_429" numeric(10, 6) DEFAULT '0' NOT NULL,
	"rate_5xx" numeric(10, 6) DEFAULT '0' NOT NULL,
	"circuit_state" "circuit_state" DEFAULT 'closed' NOT NULL,
	"opened_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"secret" text,
	"models" jsonb NOT NULL,
	"weight" integer DEFAULT 10 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"latency" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_filings" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upstream_model_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"filing_name" text,
	"filing_number" text,
	"filing_region" text,
	"filing_source_url" text,
	"filing_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "downstream_api_keys" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "exchange_rate_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"base_currency" text NOT NULL,
	"quote_currency" text NOT NULL,
	"rate" numeric(24, 12) NOT NULL,
	"source" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "model_aliases" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alias" text NOT NULL,
	"provider_id" text NOT NULL,
	"upstream_model_id" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"payment_provider" text DEFAULT 'mock' NOT NULL,
	"external_order_id" text,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organization_memberships" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "member_role" NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" "org_kind" DEFAULT 'customer' NOT NULL,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"encryption_key_version" integer DEFAULT 1 NOT NULL,
	"credential_type" "credential_type" DEFAULT 'api_key' NOT NULL,
	"is_platform_managed" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_verified_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_price_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"upstream_model_id" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"region" text DEFAULT 'global' NOT NULL,
	"service_tier" text DEFAULT 'default' NOT NULL,
	"context_min" integer,
	"context_max" integer,
	"input_price" numeric(18, 8) NOT NULL,
	"cached_input_price" numeric(18, 8) DEFAULT '0' NOT NULL,
	"cache_write_price" numeric(18, 8) DEFAULT '0' NOT NULL,
	"output_price" numeric(18, 8) NOT NULL,
	"reasoning_price" numeric(18, 8) DEFAULT '0' NOT NULL,
	"request_price" numeric(18, 8) DEFAULT '0' NOT NULL,
	"tool_price" numeric(18, 8) DEFAULT '0' NOT NULL,
	"image_price" numeric(18, 8) DEFAULT '0' NOT NULL,
	"audio_price" numeric(18, 8) DEFAULT '0' NOT NULL,
	"unit" text DEFAULT 'per_million_tokens' NOT NULL,
	"source_type" text NOT NULL,
	"source_url" text,
	"source_document_hash" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"status" "price_status" DEFAULT 'pending' NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"raw_source_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"official_base_url" text NOT NULL,
	"models_endpoint" text,
	"auth_scheme" text DEFAULT 'bearer' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"supports_model_sync" boolean DEFAULT false NOT NULL,
	"supports_price_sync" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"channel" text NOT NULL,
	"key_name" text NOT NULL,
	"status" integer NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost" double precision DEFAULT 0 NOT NULL,
	"latency" integer DEFAULT 0 NOT NULL,
	"demo" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_records" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"downstream_key_id" text,
	"request_model" text NOT NULL,
	"resolved_provider_id" text,
	"resolved_upstream_model_id" text,
	"provider_credential_id" text,
	"channel_kind" "channel_kind" NOT NULL,
	"status" "request_status" DEFAULT 'created' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"provider_price_version_id" text,
	"sale_price_snapshot_id" text,
	"exchange_rate_snapshot_id" text,
	"upstream_cost_amount" bigint,
	"upstream_cost_currency" text,
	"charge_amount" bigint DEFAULT 0 NOT NULL,
	"charge_currency" text DEFAULT 'USD' NOT NULL,
	"cost_in_charge_currency" bigint,
	"gross_margin_amount" bigint,
	"gross_margin_rate" numeric(18, 8),
	"reservation_amount" bigint DEFAULT 0 NOT NULL,
	"reservation_released" boolean DEFAULT false NOT NULL,
	"reservation_expires_at" timestamp with time zone,
	"idempotency_key" text,
	"error_code" text,
	"error_message" text,
	"upstream_request_id" text,
	"trace_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_price_rules" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"provider_id" text NOT NULL,
	"upstream_model_id" text NOT NULL,
	"pricing_mode" "sale_pricing_mode" NOT NULL,
	"markup_rate" numeric(18, 8) DEFAULT '0' NOT NULL,
	"target_margin_rate" numeric(18, 8) DEFAULT '0.3' NOT NULL,
	"fixed_fee" numeric(18, 8) DEFAULT '0' NOT NULL,
	"minimum_charge" numeric(18, 8) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_price_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" text NOT NULL,
	"provider_price_version_id" text NOT NULL,
	"exchange_rate_snapshot_id" text,
	"pricing_mode" "sale_pricing_mode" NOT NULL,
	"input_price" numeric(18, 8) NOT NULL,
	"output_price" numeric(18, 8) NOT NULL,
	"cached_input_price" numeric(18, 8) DEFAULT '0' NOT NULL,
	"reasoning_price" numeric(18, 8) DEFAULT '0' NOT NULL,
	"fixed_fee" numeric(18, 8) DEFAULT '0' NOT NULL,
	"minimum_charge" numeric(18, 8) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "relay_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstream_models" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"upstream_model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"context_window" integer,
	"max_output_tokens" integer,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lifecycle_status" "model_lifecycle" DEFAULT 'pending_review' NOT NULL,
	"available" boolean DEFAULT false NOT NULL,
	"manually_enabled" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"missing_sync_count" integer DEFAULT 0 NOT NULL,
	"raw_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wallet_accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" "wallet_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_ledger_entries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" text NOT NULL,
	"type" "ledger_type" NOT NULL,
	"amount" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"reference_type" text,
	"reference_id" text,
	"idempotency_key" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_response_code" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"url" text NOT NULL,
	"secret_hash" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_health" ADD CONSTRAINT "channel_health_provider_credential_id_provider_credentials_id_fk" FOREIGN KEY ("provider_credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_filings" ADD CONSTRAINT "compliance_filings_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "downstream_api_keys" ADD CONSTRAINT "downstream_api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_aliases" ADD CONSTRAINT "model_aliases_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_wallet_id_wallet_accounts_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_price_versions" ADD CONSTRAINT "provider_price_versions_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_price_versions" ADD CONSTRAINT "provider_price_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_records" ADD CONSTRAINT "request_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_records" ADD CONSTRAINT "request_records_downstream_key_id_downstream_api_keys_id_fk" FOREIGN KEY ("downstream_key_id") REFERENCES "public"."downstream_api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_records" ADD CONSTRAINT "request_records_resolved_provider_id_providers_id_fk" FOREIGN KEY ("resolved_provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_records" ADD CONSTRAINT "request_records_provider_credential_id_provider_credentials_id_fk" FOREIGN KEY ("provider_credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_records" ADD CONSTRAINT "request_records_provider_price_version_id_provider_price_versions_id_fk" FOREIGN KEY ("provider_price_version_id") REFERENCES "public"."provider_price_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_records" ADD CONSTRAINT "request_records_sale_price_snapshot_id_sale_price_snapshots_id_fk" FOREIGN KEY ("sale_price_snapshot_id") REFERENCES "public"."sale_price_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_records" ADD CONSTRAINT "request_records_exchange_rate_snapshot_id_exchange_rate_snapshots_id_fk" FOREIGN KEY ("exchange_rate_snapshot_id") REFERENCES "public"."exchange_rate_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_price_rules" ADD CONSTRAINT "sale_price_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_price_rules" ADD CONSTRAINT "sale_price_rules_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_price_snapshots" ADD CONSTRAINT "sale_price_snapshots_rule_id_sale_price_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."sale_price_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_price_snapshots" ADD CONSTRAINT "sale_price_snapshots_provider_price_version_id_provider_price_versions_id_fk" FOREIGN KEY ("provider_price_version_id") REFERENCES "public"."provider_price_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_price_snapshots" ADD CONSTRAINT "sale_price_snapshots_exchange_rate_snapshot_id_exchange_rate_snapshots_id_fk" FOREIGN KEY ("exchange_rate_snapshot_id") REFERENCES "public"."exchange_rate_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_models" ADD CONSTRAINT "upstream_models_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ledger_entries" ADD CONSTRAINT "wallet_ledger_entries_wallet_id_wallet_accounts_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhook_endpoints_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "jobs_next_run_idx" ON "background_jobs" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "jobs_type_idx" ON "background_jobs" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_health_credential_idx" ON "channel_health" USING btree ("provider_credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "filings_provider_model_idx" ON "compliance_filings" USING btree ("provider_id","upstream_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "downstream_keys_hash_idx" ON "downstream_api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "fx_pair_idx" ON "exchange_rate_snapshots" USING btree ("base_currency","quote_currency");--> statement-breakpoint
CREATE UNIQUE INDEX "model_aliases_alias_provider_idx" ON "model_aliases" USING btree ("alias","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_external_idx" ON "orders" USING btree ("payment_provider","external_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_idx" ON "orders" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user_idx" ON "organization_memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "credentials_provider_org_idx" ON "provider_credentials" USING btree ("provider_id","organization_id");--> statement-breakpoint
CREATE INDEX "ppv_model_status_idx" ON "provider_price_versions" USING btree ("provider_id","upstream_model_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_code_idx" ON "providers" USING btree ("code");--> statement-breakpoint
CREATE INDEX "requests_org_created_idx" ON "request_records" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_idempotency_idx" ON "request_records" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "requests_status_idx" ON "request_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sale_rules_org_model_idx" ON "sale_price_rules" USING btree ("organization_id","provider_id","upstream_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "upstream_models_provider_id_idx" ON "upstream_models" USING btree ("provider_id","upstream_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_org_currency_idx" ON "wallet_accounts" USING btree ("organization_id","currency");--> statement-breakpoint
CREATE INDEX "ledger_wallet_created_idx" ON "wallet_ledger_entries" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_idempotency_idx" ON "wallet_ledger_entries" USING btree ("wallet_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_idx" ON "webhook_deliveries" USING btree ("status","created_at");