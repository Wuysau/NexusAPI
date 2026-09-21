CREATE TYPE "public"."compliance_approval" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."entitlement_kind" AS ENUM('boolean', 'limit');--> statement-breakpoint
CREATE TYPE "public"."order_kind" AS ENUM('subscription', 'managed_credits');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."plan_version_status" AS ENUM('draft', 'published', 'retired');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'canceled', 'expired');--> statement-breakpoint
CREATE TABLE "entitlements" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_version_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" "entitlement_kind" DEFAULT 'limit' NOT NULL,
	"limit_value" bigint,
	"boolean_value" boolean,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" "plan_version_status" DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"price_micros" bigint DEFAULT 0 NOT NULL,
	"billing_interval" text DEFAULT 'month' NOT NULL,
	"included_credits_micros" bigint DEFAULT 0 NOT NULL,
	"trial_days" integer DEFAULT 0 NOT NULL,
	"effective_from" timestamp with time zone,
	"effective_to" timestamp with time zone,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tier" text DEFAULT 'team' NOT NULL,
	"status" "plan_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"organization_id" text,
	"plan_version_id" text NOT NULL,
	"status" "subscription_status" DEFAULT 'active' NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_compliance" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"organization_id" text,
	"contract_status" "compliance_approval" DEFAULT 'pending' NOT NULL,
	"payment_status" "compliance_approval" DEFAULT 'pending' NOT NULL,
	"tax_status" "compliance_approval" DEFAULT 'pending' NOT NULL,
	"region_status" "compliance_approval" DEFAULT 'pending' NOT NULL,
	"region" text,
	"contract_reference" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "kind" "order_kind" DEFAULT 'managed_credits' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "plan_version_id" text;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_compliance" ADD CONSTRAINT "tenant_compliance_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "entitlements_version_key_idx" ON "entitlements" USING btree ("plan_version_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_plan_version_idx" ON "plan_versions" USING btree ("plan_id","version");--> statement-breakpoint
CREATE INDEX "plan_versions_status_idx" ON "plan_versions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_code_idx" ON "plans" USING btree ("code");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_effective_idx" ON "subscriptions" USING btree ("tenant_id","effective_from");--> statement-breakpoint
CREATE INDEX "subscriptions_tenant_status_idx" ON "subscriptions" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_compliance_tenant_idx" ON "tenant_compliance" USING btree ("tenant_id");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_tenant_kind_idx" ON "orders" USING btree ("tenant_id","kind","created_at");