CREATE TYPE "public"."alert_severity" AS ENUM('info', 'warning', 'critical');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('pending', 'sent', 'streaming', 'completed', 'failed', 'retried');--> statement-breakpoint
CREATE TYPE "public"."channel_capability" AS ENUM('chat', 'embeddings', 'images', 'audio', 'tools', 'multimodal');--> statement-breakpoint
CREATE TYPE "public"."incident_severity" AS ENUM('info', 'warning', 'major', 'critical');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_type" AS ENUM('wallet', 'revenue', 'refund', 'adjustment', 'promotional', 'reservation', 'tax', 'fee', 'clearing');--> statement-breakpoint
CREATE TYPE "public"."ledger_transaction_type" AS ENUM('recharge', 'usage', 'refund', 'adjustment', 'promotional_credit', 'reservation', 'reservation_release', 'correction');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'completed', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."price_candidate_status" AS ENUM('fetched', 'validated', 'pending_approval', 'scheduled', 'active', 'superseded', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."price_component_kind" AS ENUM('input', 'cached_input', 'output', 'reasoning', 'request', 'image', 'audio', 'storage');--> statement-breakpoint
CREATE TYPE "public"."price_source_type" AS ENUM('official_api', 'official_market', 'parsed_page', 'imported_json', 'imported_csv', 'manual');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('open', 'investigating', 'resolved', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."service_account_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"budget_id" text,
	"severity" "alert_severity" DEFAULT 'warning' NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acknowledged" boolean DEFAULT false NOT NULL,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"provider_id" text,
	"provider_credential_id" text,
	"channel_id" text,
	"attempt_number" integer NOT NULL,
	"status" "attempt_status" DEFAULT 'pending' NOT NULL,
	"upstream_request_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"upstream_cost_amount" bigint,
	"upstream_cost_currency" text,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"actor_user_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"amount_limit" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"period" text DEFAULT 'monthly' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"version" integer NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checksum" text NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"provider_id" text NOT NULL,
	"provider_credential_id" text,
	"name" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"region" text DEFAULT 'global' NOT NULL,
	"weight" integer DEFAULT 10 NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"policy_version_id" text,
	"sequence_number" bigint NOT NULL,
	"signature" text NOT NULL,
	"signing_key_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"provider_id" text,
	"severity" "incident_severity" DEFAULT 'warning' NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'open' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "key_scopes" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"api_key_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"wallet_id" text,
	"type" "ledger_account_type" NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_postings" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"account_id" text NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"amount" bigint NOT NULL,
	"entry_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_transactions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"type" "ledger_transaction_type" NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"idempotency_key" text NOT NULL,
	"reference_type" text,
	"reference_id" text,
	"description" text,
	"created_by" text,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" text,
	"payment_provider" text DEFAULT 'mock' NOT NULL,
	"external_payment_id" text,
	"amount" bigint NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "policy_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"routing_policy_id" text NOT NULL,
	"tenant_id" text,
	"version" integer NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checksum" text NOT NULL,
	"credential_mode" text DEFAULT 'byok' NOT NULL,
	"model_routes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_candidates" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"upstream_model_id" text NOT NULL,
	"price_source_id" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"region" text DEFAULT 'global' NOT NULL,
	"status" "price_candidate_status" DEFAULT 'fetched' NOT NULL,
	"high_risk_flag" boolean DEFAULT false NOT NULL,
	"risk_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_components" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_version_id" text NOT NULL,
	"price_candidate_id" text,
	"kind" "price_component_kind" NOT NULL,
	"unit" text DEFAULT 'per_million_tokens' NOT NULL,
	"amount" numeric(18, 8) NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "price_sources" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" text NOT NULL,
	"upstream_model_id" text NOT NULL,
	"source_type" "price_source_type" NOT NULL,
	"source_url" text,
	"content_sha256" text,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parser_version" text,
	"region" text DEFAULT 'global' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"billing_conditions" text,
	"raw_evidence_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_policies" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"api_key_id" text,
	"name" text NOT NULL,
	"requests_per_minute" integer,
	"requests_per_day" integer,
	"tokens_per_minute" integer,
	"tokens_per_day" integer,
	"concurrency_limit" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_cases" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"request_id" text,
	"usage_event_id" text,
	"status" "reconciliation_status" DEFAULT 'open' NOT NULL,
	"reason" text NOT NULL,
	"expected_amount" bigint,
	"actual_amount" bigint,
	"currency" text,
	"resolution" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"target_type" text NOT NULL,
	"retention_days" integer NOT NULL,
	"hard_delete_after_days" integer,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_policies" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_accounts" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"description" text,
	"status" "service_account_status" DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text,
	"job_type" text NOT NULL,
	"provider_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" text,
	"attempt_id" text,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"provider_request_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_records" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"request_id" text,
	"usage_event_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"upstream_cost_amount" bigint,
	"upstream_cost_currency" text,
	"charge_amount" bigint DEFAULT 0 NOT NULL,
	"charge_currency" text DEFAULT 'USD' NOT NULL,
	"estimated_amount" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_logs" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "downstream_api_keys" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "downstream_api_keys" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "downstream_api_keys" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_memberships" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "tenant_id" text DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "request_records" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_price_rules" ADD COLUMN "tenant_id" text;--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD COLUMN "tenant_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_request_id_request_records_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_provider_credential_id_provider_credentials_id_fk" FOREIGN KEY ("provider_credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_provider_credential_id_provider_credentials_id_fk" FOREIGN KEY ("provider_credential_id") REFERENCES "public"."provider_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_snapshots" ADD CONSTRAINT "gateway_snapshots_policy_version_id_policy_versions_id_fk" FOREIGN KEY ("policy_version_id") REFERENCES "public"."policy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_scopes" ADD CONSTRAINT "key_scopes_api_key_id_downstream_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."downstream_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_wallet_id_wallet_accounts_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_transaction_id_ledger_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."ledger_transactions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_postings" ADD CONSTRAINT "ledger_postings_account_id_ledger_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_routing_policy_id_routing_policies_id_fk" FOREIGN KEY ("routing_policy_id") REFERENCES "public"."routing_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_candidates" ADD CONSTRAINT "price_candidates_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_candidates" ADD CONSTRAINT "price_candidates_price_source_id_price_sources_id_fk" FOREIGN KEY ("price_source_id") REFERENCES "public"."price_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_components" ADD CONSTRAINT "price_components_price_version_id_provider_price_versions_id_fk" FOREIGN KEY ("price_version_id") REFERENCES "public"."provider_price_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_components" ADD CONSTRAINT "price_components_price_candidate_id_price_candidates_id_fk" FOREIGN KEY ("price_candidate_id") REFERENCES "public"."price_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_sources" ADD CONSTRAINT "price_sources_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_policies" ADD CONSTRAINT "rate_limit_policies_api_key_id_downstream_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."downstream_api_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_cases" ADD CONSTRAINT "reconciliation_cases_request_id_request_records_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_cases" ADD CONSTRAINT "reconciliation_cases_usage_event_id_usage_events_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_accounts" ADD CONSTRAINT "service_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_request_id_request_records_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_request_id_request_records_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."request_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_records" ADD CONSTRAINT "usage_records_usage_event_id_usage_events_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_tenant_created_idx" ON "alerts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "attempts_request_idx" ON "attempts" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "attempts_tenant_idx" ON "attempts" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_upstream_request_idx" ON "attempts" USING btree ("tenant_id","upstream_request_id");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_created_idx" ON "audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "budgets_tenant_scope_idx" ON "budgets" USING btree ("tenant_id","scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_versions_tenant_version_idx" ON "catalog_versions" USING btree ("tenant_id","version");--> statement-breakpoint
CREATE INDEX "channels_tenant_idx" ON "channels" USING btree ("tenant_id","enabled");--> statement-breakpoint
CREATE INDEX "channels_provider_idx" ON "channels" USING btree ("provider_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_snapshots_tenant_seq_idx" ON "gateway_snapshots" USING btree ("tenant_id","sequence_number");--> statement-breakpoint
CREATE INDEX "incidents_tenant_status_idx" ON "incidents" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "key_scopes_key_scope_idx" ON "key_scopes" USING btree ("api_key_id","scope");--> statement-breakpoint
CREATE INDEX "key_scopes_tenant_idx" ON "key_scopes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_tenant_code_idx" ON "ledger_accounts" USING btree ("tenant_id","code");--> statement-breakpoint
CREATE INDEX "ledger_accounts_tenant_wallet_idx" ON "ledger_accounts" USING btree ("tenant_id","wallet_id");--> statement-breakpoint
CREATE INDEX "ledger_postings_transaction_idx" ON "ledger_postings" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "ledger_postings_account_idx" ON "ledger_postings" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_postings_tenant_account_idx" ON "ledger_postings" USING btree ("tenant_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_transactions_tenant_idempotency_idx" ON "ledger_transactions" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_transactions_tenant_ref_idx" ON "ledger_transactions" USING btree ("tenant_id","reference_type","reference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_tenant_idempotency_idx" ON "outbox_events" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_events_status_idx" ON "outbox_events" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_tenant_idempotency_idx" ON "payments" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_external_idx" ON "payments" USING btree ("payment_provider","external_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_versions_policy_version_idx" ON "policy_versions" USING btree ("routing_policy_id","version");--> statement-breakpoint
CREATE INDEX "price_candidates_provider_model_status_idx" ON "price_candidates" USING btree ("provider_id","upstream_model_id","status");--> statement-breakpoint
CREATE INDEX "price_components_version_idx" ON "price_components" USING btree ("price_version_id");--> statement-breakpoint
CREATE INDEX "price_components_kind_idx" ON "price_components" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "price_sources_provider_model_idx" ON "price_sources" USING btree ("provider_id","upstream_model_id");--> statement-breakpoint
CREATE INDEX "rate_limit_policies_tenant_idx" ON "rate_limit_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "rate_limit_policies_key_idx" ON "rate_limit_policies" USING btree ("api_key_id");--> statement-breakpoint
CREATE INDEX "reconciliation_cases_tenant_status_idx" ON "reconciliation_cases" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "retention_policies_tenant_target_idx" ON "retention_policies" USING btree ("tenant_id","target_type");--> statement-breakpoint
CREATE INDEX "routing_policies_tenant_idx" ON "routing_policies" USING btree ("tenant_id","enabled");--> statement-breakpoint
CREATE INDEX "service_accounts_tenant_idx" ON "service_accounts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "sync_runs_tenant_status_idx" ON "sync_runs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "sync_runs_job_type_idx" ON "sync_runs" USING btree ("job_type");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_tenant_event_idx" ON "usage_events" USING btree ("tenant_id","event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_events_tenant_provider_req_idx" ON "usage_events" USING btree ("tenant_id","provider_request_id");--> statement-breakpoint
CREATE INDEX "usage_records_tenant_request_idx" ON "usage_records" USING btree ("tenant_id","request_id");--> statement-breakpoint
CREATE INDEX "usage_records_tenant_event_idx" ON "usage_records" USING btree ("tenant_id","usage_event_id");--> statement-breakpoint
CREATE INDEX "audit_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "downstream_keys_tenant_enabled_idx" ON "downstream_api_keys" USING btree ("tenant_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_tenant_idempotency_idx" ON "orders" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user_idx" ON "organization_memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_tenant_idx" ON "organizations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "credentials_provider_tenant_idx" ON "provider_credentials" USING btree ("provider_id","tenant_id");--> statement-breakpoint
CREATE INDEX "requests_tenant_created_idx" ON "request_records" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "requests_tenant_idempotency_idx" ON "request_records" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "sale_rules_tenant_model_idx" ON "sale_price_rules" USING btree ("tenant_id","provider_id","upstream_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_tenant_currency_idx" ON "wallet_accounts" USING btree ("tenant_id","currency");

-- ── Ledger balance invariant (ADR-0002, INVARIANTS #2 #3) ──────────────
-- Per (transaction_id, currency): sum(amount) must equal 0 (debits = credits).
-- Enforced as a DEFERRABLE constraint trigger checked at COMMIT so callers
-- can insert debit+credit postings within the same transaction before the
-- check fires. A BEFORE trigger on ledger_postings forbids UPDATE/DELETE
-- to guarantee immutability of posted entries (corrections use new
-- reversing/compensating transactions, never edits).

CREATE OR REPLACE FUNCTION enforce_ledger_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  unbalanced_count bigint;
BEGIN
  SELECT count(*) INTO unbalanced_count
  FROM (
    SELECT 1
    FROM ledger_postings
    GROUP BY transaction_id, currency
    HAVING sum(amount) <> 0
  ) s;
  IF unbalanced_count > 0 THEN
    RAISE EXCEPTION 'ledger_balance_violation: debit/credit mismatch for % transactions',
      unbalanced_count
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_balance_check
AFTER INSERT OR UPDATE ON ledger_postings
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_ledger_balance();--> statement-breakpoint

-- Block UPDATE and DELETE on ledger_postings (append-only / immutable).
CREATE OR REPLACE FUNCTION block_ledger_posting_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_posting_immutable: UPDATE and DELETE are forbidden on ledger_postings (use a compensating transaction)'
    USING ERRCODE = 'P0001';
END;
$$;--> statement-breakpoint

CREATE TRIGGER ledger_posting_no_update
BEFORE UPDATE ON ledger_postings
FOR EACH ROW
EXECUTE FUNCTION block_ledger_posting_mutation();--> statement-breakpoint

CREATE TRIGGER ledger_posting_no_delete
BEFORE DELETE ON ledger_postings
FOR EACH ROW
EXECUTE FUNCTION block_ledger_posting_mutation();--> statement-breakpoint

-- Backfill tenant_id from organization_id for existing rows (expand phase:
-- both columns coexist; contract phase later drops organization_id).
UPDATE organizations SET tenant_id = id WHERE tenant_id IS NULL OR tenant_id = '';--> statement-breakpoint
UPDATE organization_memberships SET tenant_id = organization_id WHERE tenant_id IS NULL OR tenant_id = '';--> statement-breakpoint
UPDATE wallet_accounts SET tenant_id = organization_id WHERE tenant_id IS NULL OR tenant_id = '';--> statement-breakpoint
UPDATE orders SET tenant_id = organization_id WHERE tenant_id IS NULL OR tenant_id = '';--> statement-breakpoint
UPDATE downstream_api_keys SET tenant_id = organization_id WHERE tenant_id IS NULL OR tenant_id = '';--> statement-breakpoint
UPDATE request_records SET tenant_id = organization_id WHERE tenant_id IS NULL OR tenant_id = '';--> statement-breakpoint
UPDATE audit_logs SET tenant_id = organization_id WHERE tenant_id IS NULL OR tenant_id = '';--> statement-breakpoint
UPDATE webhook_endpoints SET tenant_id = organization_id WHERE tenant_id IS NULL OR tenant_id = '';--> statement-breakpoint
UPDATE provider_credentials SET tenant_id = organization_id WHERE organization_id IS NOT NULL AND (tenant_id IS NULL OR tenant_id = '');--> statement-breakpoint
UPDATE sale_price_rules SET tenant_id = organization_id WHERE organization_id IS NOT NULL AND (tenant_id IS NULL OR tenant_id = '');--> statement-breakpoint