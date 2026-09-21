ALTER TABLE "external_observed_usage" ADD COLUMN "session_kind" text;--> statement-breakpoint
ALTER TABLE "external_observed_usage" ADD COLUMN "parent_session_id" text;
--> statement-breakpoint
ALTER TABLE external_observed_usage ADD CONSTRAINT observed_session_metadata_shape CHECK (
 (session_kind IS NULL AND parent_session_id IS NULL) OR
 (session_kind IS NOT NULL AND session_kind IN ('desktop','subagent','cli','other') AND (parent_session_id IS NULL OR (parent_session_id<>external_session_id AND length(parent_session_id)<=160))));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_observer_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attribution_changed boolean; metadata_changed boolean;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM organizations WHERE id=NEW.organization_id AND tenant_id=NEW.tenant_id) THEN RAISE EXCEPTION 'observer namespace mismatch'; END IF;
  IF TG_TABLE_NAME='external_observed_usage' THEN
    IF TG_OP='UPDATE' THEN
      IF (to_jsonb(NEW)-ARRAY['project_id','project_name','matched_root','attributed_at','session_kind','parent_session_id']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['project_id','project_name','matched_root','attributed_at','session_kind','parent_session_id']) THEN RAISE EXCEPTION 'observed fact is immutable'; END IF;
      attribution_changed := ROW(NEW.project_id,NEW.project_name,NEW.matched_root,NEW.attributed_at) IS DISTINCT FROM ROW(OLD.project_id,OLD.project_name,OLD.matched_root,OLD.attributed_at);
      metadata_changed := ROW(NEW.session_kind,NEW.parent_session_id) IS DISTINCT FROM ROW(OLD.session_kind,OLD.parent_session_id);
      IF attribution_changed AND (OLD.project_id IS NOT NULL OR NEW.project_id IS NULL) THEN RAISE EXCEPTION 'observed attribution is immutable'; END IF;
      IF metadata_changed AND (OLD.session_kind IS NOT NULL OR OLD.parent_session_id IS NOT NULL OR NEW.session_kind IS NULL) THEN RAISE EXCEPTION 'observed session metadata is immutable'; END IF;
      -- Metadata enrichment of historical facts must work after revocation/archiving.
      -- It cannot change any original scope, connection, project or token field.
      IF NOT attribution_changed THEN RETURN NEW; END IF;
    END IF;
    IF NEW.connection_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM owned_connections WHERE id=NEW.connection_id AND tenant_id=NEW.tenant_id AND mode='subscription_interactive' AND revoked_at IS NULL) THEN RAISE EXCEPTION 'observer connection mismatch'; END IF;
  END IF;
  IF NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=NEW.project_id AND tenant_id=NEW.tenant_id AND organization_id=NEW.organization_id) THEN RAISE EXCEPTION 'observer project mismatch'; END IF;
  RETURN NEW;
END $$;
