-- Refuse previously inconsistent facts rather than blessing them by migration.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM request_project_facts f LEFT JOIN request_records r ON r.id=f.request_id
    LEFT JOIN organizations o ON o.id=f.organization_id
    WHERE r.id IS NULL OR o.id IS NULL OR r.tenant_id<>f.tenant_id OR r.organization_id<>f.organization_id OR o.tenant_id<>f.tenant_id)
  THEN RAISE EXCEPTION 'existing request fact tenant scope mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM request_project_facts f LEFT JOIN projects p ON p.id=f.project_id
    WHERE f.project_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>f.tenant_id OR p.organization_id<>f.organization_id))
    OR EXISTS (SELECT 1 FROM request_records r LEFT JOIN projects p ON p.id=r.project_id
    WHERE r.project_id IS NOT NULL AND (p.id IS NULL OR p.tenant_id<>r.tenant_id OR p.organization_id<>r.organization_id))
  THEN RAISE EXCEPTION 'existing project tenant scope requires operator review'; END IF;
  IF EXISTS (SELECT 1 FROM request_project_facts f LEFT JOIN downstream_api_keys k ON k.id=f.api_key_id
    WHERE f.api_key_id IS NOT NULL AND (k.id IS NULL OR k.tenant_id<>f.tenant_id OR k.organization_id<>f.organization_id))
    OR EXISTS (SELECT 1 FROM request_project_facts f LEFT JOIN owned_connections c ON c.id=f.connection_id
    WHERE f.connection_id IS NOT NULL AND (c.id IS NULL OR c.tenant_id<>f.tenant_id))
  THEN RAISE EXCEPTION 'existing key or connection tenant scope requires operator review'; END IF;
  IF EXISTS (SELECT 1 FROM request_project_facts f JOIN request_records r ON r.id=f.request_id WHERE
    (f.api_key_id IS NOT NULL AND r.downstream_key_id IS DISTINCT FROM f.api_key_id) OR
    (r.project_id IS NOT NULL AND r.project_id IS DISTINCT FROM f.project_id) OR
    (r.attribution_status IS NOT NULL AND (r.project_id,r.project_name,r.connection_id,r.execution_mode,r.attribution_status)
      IS DISTINCT FROM (f.project_id,f.project_name,f.connection_id,f.execution_mode,f.attribution_status)))
  THEN RAISE EXCEPTION 'existing request attribution mismatch requires operator review'; END IF;
END $$;
--> statement-breakpoint
ALTER TABLE request_records DROP CONSTRAINT request_records_project_id_projects_id_fk;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN credential_id text;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN channel_id text;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN provider_id text;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN requested_model text;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN resolved_model text;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN model_id text;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN price_version_id text;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN key_kind text;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN evidence_source text;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN evidence_digest text;
--> statement-breakpoint
ALTER TABLE request_project_facts ADD COLUMN streaming boolean;
--> statement-breakpoint
CREATE FUNCTION enforce_request_project_fact() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'request project fact is immutable'; END IF;
  PERFORM 1 FROM request_records WHERE id=NEW.request_id AND tenant_id=NEW.tenant_id AND organization_id=NEW.organization_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'request tenant scope mismatch'; END IF;
  IF EXISTS (SELECT 1 FROM request_records r WHERE r.id=NEW.request_id AND
    ((NEW.api_key_id IS NOT NULL AND r.downstream_key_id IS DISTINCT FROM NEW.api_key_id) OR
     (r.project_id IS NOT NULL AND r.project_id IS DISTINCT FROM NEW.project_id) OR
     (r.attribution_status IS NOT NULL AND (r.project_id,r.project_name,r.connection_id,r.execution_mode,r.attribution_status)
      IS DISTINCT FROM (NEW.project_id,NEW.project_name,NEW.connection_id,NEW.execution_mode,NEW.attribution_status))))
  THEN RAISE EXCEPTION 'request attribution mismatch'; END IF;
  PERFORM 1 FROM organizations WHERE id=NEW.organization_id AND tenant_id=NEW.tenant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization tenant scope mismatch'; END IF;
  IF NEW.project_id IS NOT NULL THEN
    PERFORM 1 FROM projects WHERE id=NEW.project_id AND tenant_id=NEW.tenant_id AND organization_id=NEW.organization_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'project tenant scope mismatch'; END IF;
  END IF;
  IF NEW.api_key_id IS NOT NULL THEN
    PERFORM 1 FROM downstream_api_keys WHERE id=NEW.api_key_id AND tenant_id=NEW.tenant_id AND organization_id=NEW.organization_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'key tenant scope mismatch'; END IF;
  END IF;
  IF NEW.key_kind = 'shared' AND NEW.principal_id IS NOT NULL THEN RAISE EXCEPTION 'shared key principal must be null'; END IF;
  IF NEW.connection_id IS NOT NULL THEN
    PERFORM 1 FROM owned_connections WHERE id=NEW.connection_id AND tenant_id=NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'connection tenant scope mismatch'; END IF;
  END IF;
  IF NEW.credential_id IS NOT NULL THEN
    PERFORM 1 FROM provider_credentials WHERE id=NEW.credential_id AND
      ((tenant_id=NEW.tenant_id AND organization_id=NEW.organization_id) OR
       (tenant_id IS NULL AND organization_id IS NULL AND is_platform_managed AND NEW.execution_mode='managed')) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'credential tenant scope mismatch'; END IF;
  END IF;
  IF NEW.channel_id IS NOT NULL THEN
    PERFORM 1 FROM channels WHERE id=NEW.channel_id AND (tenant_id=NEW.tenant_id OR (tenant_id IS NULL AND NEW.execution_mode='managed')) FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'channel tenant scope mismatch'; END IF;
  END IF;
  IF NEW.execution_mode NOT IN ('managed','byok','unknown') OR NEW.attribution_status NOT IN ('attributed','unattributed','unknown') THEN RAISE EXCEPTION 'invalid attribution state'; END IF;
  IF (NEW.attribution_status = 'attributed') <> (NEW.project_id IS NOT NULL) THEN RAISE EXCEPTION 'inconsistent project attribution'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER request_project_fact_guard BEFORE INSERT OR UPDATE OR DELETE ON request_project_facts FOR EACH ROW EXECUTE FUNCTION enforce_request_project_fact();
--> statement-breakpoint
CREATE FUNCTION protect_request_fact_scope() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
  IF (NEW.id, NEW.tenant_id, NEW.organization_id, NEW.downstream_key_id, NEW.request_model) IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.organization_id, OLD.downstream_key_id, OLD.request_model)
    AND (OLD.project_id IS NOT NULL OR OLD.attribution_status IS NOT NULL OR EXISTS (SELECT 1 FROM request_project_facts WHERE request_id=OLD.id)) THEN
    RAISE EXCEPTION 'immutable request fact scope';
  END IF;
  IF (OLD.attribution_status IS NOT NULL OR OLD.project_id IS NOT NULL) AND
    (NEW.project_id,NEW.project_name,NEW.connection_id,NEW.execution_mode,NEW.attribution_status)
      IS DISTINCT FROM (OLD.project_id,OLD.project_name,OLD.connection_id,OLD.execution_mode,OLD.attribution_status)
  THEN RAISE EXCEPTION 'immutable request attribution'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM request_project_facts f WHERE f.request_id=NEW.id AND
    ((NEW.project_id IS NOT NULL AND NEW.project_id IS DISTINCT FROM f.project_id) OR
     (NEW.attribution_status IS NOT NULL AND (NEW.project_id,NEW.project_name,NEW.connection_id,NEW.execution_mode,NEW.attribution_status)
      IS DISTINCT FROM (f.project_id,f.project_name,f.connection_id,f.execution_mode,f.attribution_status))))
  THEN RAISE EXCEPTION 'immutable request attribution mismatch'; END IF;
  IF NEW.project_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.project_id IS DISTINCT FROM NEW.project_id) THEN
    PERFORM 1 FROM projects WHERE id=NEW.project_id AND tenant_id=NEW.tenant_id AND organization_id=NEW.organization_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'request project tenant scope mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER request_fact_scope_guard BEFORE INSERT OR UPDATE ON request_records FOR EACH ROW EXECUTE FUNCTION protect_request_fact_scope();
--> statement-breakpoint
REVOKE ALL ON FUNCTION enforce_request_project_fact() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION protect_request_fact_scope() FROM PUBLIC;
