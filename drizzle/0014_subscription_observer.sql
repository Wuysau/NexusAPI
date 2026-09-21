CREATE TABLE "external_observed_usage" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"usage_source" text NOT NULL,
	"authority" text NOT NULL,
	"external_session_id" text NOT NULL,
	"external_event_id" text NOT NULL,
	"turn_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"cwd" text,
	"provider_identifier" text,
	"provider" text,
	"subscription_product" text,
	"connection_id" text,
	"model" text,
	"input_tokens" numeric(30, 0),
	"cached_input_tokens" numeric(30, 0),
	"output_tokens" numeric(30, 0),
	"reasoning_tokens" numeric(30, 0),
	"total_tokens" numeric(30, 0),
	"project_id" text,
	"project_name" text,
	"matched_root" text,
	"attributed_at" timestamp with time zone,
	"cli_version" text,
	"parser_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "observer_scan_cursors" (
	"tenant_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"file_id" text NOT NULL,
	"parser_version" text NOT NULL,
	"byte_offset" bigint NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "observer_scan_cursors_tenant_id_organization_id_file_id_pk" PRIMARY KEY("tenant_id","organization_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "project_workspace_roots" (
	"tenant_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"root" text NOT NULL,
	"project_id" text NOT NULL,
	CONSTRAINT "project_workspace_roots_tenant_id_organization_id_root_pk" PRIMARY KEY("tenant_id","organization_id","root")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "observed_usage_event_unique" ON "external_observed_usage" USING btree ("tenant_id","usage_source","external_event_id");--> statement-breakpoint
CREATE INDEX "observed_usage_scope_time_idx" ON "external_observed_usage" USING btree ("tenant_id","organization_id","occurred_at");
--> statement-breakpoint
ALTER TABLE external_observed_usage ADD CONSTRAINT observed_source_authority CHECK (usage_source='codex_local' AND authority='client_observed');
ALTER TABLE external_observed_usage ADD CONSTRAINT observed_token_counts CHECK (
  input_tokens>=0 AND cached_input_tokens>=0 AND output_tokens>=0 AND reasoning_tokens>=0 AND total_tokens>=0
  AND cached_input_tokens<=input_tokens AND reasoning_tokens<=output_tokens AND total_tokens=input_tokens+output_tokens);
ALTER TABLE external_observed_usage ADD CONSTRAINT observed_attribution_shape CHECK (
  (project_id IS NULL AND project_name IS NULL AND matched_root IS NULL AND attributed_at IS NULL)
  OR (project_id IS NOT NULL AND project_name IS NOT NULL AND matched_root IS NOT NULL AND attributed_at IS NOT NULL));
ALTER TABLE observer_scan_cursors ADD CONSTRAINT observer_cursor_metadata_only CHECK (
  byte_offset>=0 AND jsonb_typeof(state)='object' AND
  state - ARRAY['sessionId','turnId','cwd','providerIdentifier','model','cliVersion','lastCounter']::text[]='{}'::jsonb);
--> statement-breakpoint
CREATE FUNCTION guard_observer_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'observer namespace mismatch'; END IF;
  IF TG_TABLE_NAME='external_observed_usage' THEN
    IF TG_OP='UPDATE' THEN
      IF OLD.project_id IS NOT NULL OR NEW.project_id IS NULL OR
        (to_jsonb(NEW)-ARRAY['project_id','project_name','matched_root','attributed_at']) IS DISTINCT FROM
        (to_jsonb(OLD)-ARRAY['project_id','project_name','matched_root','attributed_at'])
      THEN RAISE EXCEPTION 'observed fact is immutable'; END IF;
    END IF;
    IF NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM owned_connections WHERE id=NEW.connection_id AND tenant_id=NEW.tenant_id AND mode='subscription_interactive' AND revoked_at IS NULL) THEN RAISE EXCEPTION 'observer connection mismatch'; END IF;
  END IF;
  IF NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND tenant_id=NEW.tenant_id AND organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'observer project mismatch'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER observed_fact_guard BEFORE INSERT OR UPDATE ON external_observed_usage FOR EACH ROW EXECUTE FUNCTION guard_observer_scope();
CREATE TRIGGER workspace_scope_guard BEFORE INSERT OR UPDATE ON project_workspace_roots FOR EACH ROW EXECUTE FUNCTION guard_observer_scope();
--> statement-breakpoint
CREATE FUNCTION guard_subscription_connection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP='UPDATE' AND OLD.mode='subscription_interactive' AND NEW.mode<>'subscription_interactive') OR
    (NEW.mode='subscription_interactive' AND (NEW.credential_ref IS NOT NULL OR NEW.credential_fingerprint IS NOT NULL
      OR NEW.capabilities->>'routing' IS DISTINCT FROM 'false'
      OR NEW.capabilities->>'execution_mode' IS DISTINCT FROM 'interactive'
      OR NEW.capabilities->>'connection_type' IS DISTINCT FROM 'subscription'))
  THEN RAISE EXCEPTION 'subscription connections cannot authorize routing or hold credentials'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscription_connection_guard BEFORE INSERT OR UPDATE ON owned_connections FOR EACH ROW EXECUTE FUNCTION guard_subscription_connection();
