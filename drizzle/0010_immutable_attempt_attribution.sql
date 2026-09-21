ALTER TYPE "public"."attempt_status" ADD VALUE 'unknown';--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "resolved_model" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "execution_mode" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "price_version_id" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "catalog_version_id" text;--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "policy_version_id" text;
--> statement-breakpoint
-- New nullable dimensions opt in to captured attempt history. Legacy attempts
-- keep their old reconciliation and retention behavior during the expand window.
CREATE FUNCTION enforce_attempt_attribution() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE request_org text;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.execution_mode IS NOT NULL THEN RAISE EXCEPTION 'captured attempt is immutable'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.execution_mode IS NOT NULL THEN
    IF (NEW.id,NEW.request_id,NEW.tenant_id,NEW.provider_id,NEW.provider_credential_id,NEW.channel_id,NEW.attempt_number,
        NEW.connection_id,NEW.resolved_model,NEW.execution_mode,NEW.price_version_id,NEW.catalog_version_id,NEW.policy_version_id)
      IS DISTINCT FROM
       (OLD.id,OLD.request_id,OLD.tenant_id,OLD.provider_id,OLD.provider_credential_id,OLD.channel_id,OLD.attempt_number,
        OLD.connection_id,OLD.resolved_model,OLD.execution_mode,OLD.price_version_id,OLD.catalog_version_id,OLD.policy_version_id)
    THEN RAISE EXCEPTION 'captured attempt identity and pins are immutable'; END IF;
    -- Outcome/token reconciliation must not revalidate mutable live entities.
    RETURN NEW;
  END IF;
  SELECT organization_id INTO request_org FROM request_records
    WHERE id=NEW.request_id AND tenant_id=NEW.tenant_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt request tenant scope mismatch'; END IF;
  IF NEW.execution_mode IS NULL THEN
    IF NEW.connection_id IS NOT NULL OR NEW.resolved_model IS NOT NULL OR NEW.price_version_id IS NOT NULL OR
       NEW.catalog_version_id IS NOT NULL OR NEW.policy_version_id IS NOT NULL
    THEN RAISE EXCEPTION 'attempt capture requires execution mode'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.execution_mode NOT IN ('managed','byok') OR NEW.resolved_model IS NULL OR NEW.resolved_model='' OR
     NEW.price_version_id IS NULL OR NEW.price_version_id='' OR NEW.catalog_version_id IS NULL OR NEW.catalog_version_id='' OR
     NEW.provider_id IS NULL OR NEW.provider_credential_id IS NULL OR NEW.channel_id IS NULL
  THEN RAISE EXCEPTION 'attempt capture requires complete identity and pins'; END IF;
  PERFORM 1 FROM request_project_facts WHERE request_id=NEW.request_id AND tenant_id=NEW.tenant_id
    AND organization_id=request_org AND execution_mode=NEW.execution_mode
    AND catalog_version_id=NEW.catalog_version_id AND policy_version_id IS NOT DISTINCT FROM NEW.policy_version_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt request capture or version pins mismatch'; END IF;
  IF NEW.execution_mode='byok' AND NEW.connection_id IS NULL THEN RAISE EXCEPTION 'BYOK attempt connection scope missing'; END IF;
  IF NEW.connection_id IS NOT NULL THEN
    PERFORM 1 FROM owned_connections WHERE id=NEW.connection_id AND tenant_id=NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'attempt connection tenant scope mismatch'; END IF;
  END IF;
  PERFORM 1 FROM provider_credentials WHERE id=NEW.provider_credential_id AND provider_id=NEW.provider_id AND
    ((tenant_id=NEW.tenant_id AND organization_id=request_org) OR
     (tenant_id IS NULL AND organization_id IS NULL AND is_platform_managed AND NEW.execution_mode='managed')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt credential tenant scope mismatch'; END IF;
  PERFORM 1 FROM channels WHERE id=NEW.channel_id AND provider_id=NEW.provider_id AND
    (tenant_id=NEW.tenant_id OR (tenant_id IS NULL AND NEW.execution_mode='managed')) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt channel tenant scope mismatch'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER attempt_attribution_guard BEFORE INSERT OR UPDATE OR DELETE ON attempts FOR EACH ROW EXECUTE FUNCTION enforce_attempt_attribution();
--> statement-breakpoint
REVOKE ALL ON FUNCTION enforce_attempt_attribution() FROM PUBLIC;
