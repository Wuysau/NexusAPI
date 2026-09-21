CREATE TABLE "organization_model_configurations" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"upstream_model_id" text NOT NULL,
	"display_name" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_model_configurations" ADD CONSTRAINT "organization_model_configurations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_model_configurations" ADD CONSTRAINT "organization_model_configurations_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_model_config_scope_idx" ON "organization_model_configurations" USING btree ("tenant_id","organization_id","provider_id","upstream_model_id");
--> statement-breakpoint
ALTER TABLE organization_model_configurations ADD CONSTRAINT org_model_config_fields
  CHECK (version > 0 AND length(btrim(display_name)) BETWEEN 1 AND 120
    AND length(btrim(upstream_model_id)) BETWEEN 1 AND 200 AND length(notes) <= 2000);
--> statement-breakpoint
CREATE FUNCTION guard_organization_model_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND tenant_id=NEW.tenant_id)
    THEN RAISE EXCEPTION 'organization model namespace mismatch'; END IF;
  IF TG_OP='UPDATE' AND (OLD.id,OLD.tenant_id,OLD.organization_id,OLD.provider_id,OLD.upstream_model_id)
    IS DISTINCT FROM (NEW.id,NEW.tenant_id,NEW.organization_id,NEW.provider_id,NEW.upstream_model_id)
    THEN RAISE EXCEPTION 'organization model identity is immutable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organization_model_configuration_guard BEFORE INSERT OR UPDATE ON organization_model_configurations
FOR EACH ROW EXECUTE FUNCTION guard_organization_model_configuration();
