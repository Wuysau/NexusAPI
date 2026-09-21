ALTER TABLE "sale_price_snapshots" ADD COLUMN "provider_currency" text;--> statement-breakpoint
ALTER TABLE "sale_price_snapshots" ADD COLUMN "rate_currency" text;--> statement-breakpoint
ALTER TABLE "sale_price_snapshots" ADD COLUMN "provenance_version" text;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "authoritative_metering" jsonb;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "frozen_pricing" jsonb;--> statement-breakpoint
ALTER TABLE "usage_records" ADD COLUMN "calculator_version" text;
--> statement-breakpoint
CREATE FUNCTION enforce_usage_record_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND (OLD.authoritative_metering IS NOT NULL OR OLD.frozen_pricing IS NOT NULL OR OLD.calculator_version IS NOT NULL) THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable usage provenance'; END IF;
    IF ROW(OLD.id,OLD.tenant_id,OLD.request_id,OLD.usage_event_id) IS DISTINCT FROM ROW(NEW.id,NEW.tenant_id,NEW.request_id,NEW.usage_event_id)
      OR (OLD.authoritative_metering IS NOT NULL AND OLD.authoritative_metering IS DISTINCT FROM NEW.authoritative_metering)
      OR (OLD.frozen_pricing IS NOT NULL AND OLD.frozen_pricing IS DISTINCT FROM NEW.frozen_pricing)
      OR (OLD.calculator_version IS NOT NULL AND OLD.calculator_version IS DISTINCT FROM NEW.calculator_version)
    THEN RAISE EXCEPTION 'immutable usage provenance'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.authoritative_metering IS NOT NULL OR NEW.frozen_pricing IS NOT NULL OR NEW.calculator_version IS NOT NULL THEN
    PERFORM 1 FROM public.request_records WHERE id=NEW.request_id AND tenant_id=NEW.tenant_id FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'usage request scope mismatch'; END IF;
    IF NEW.authoritative_metering IS NOT NULL AND
      (jsonb_typeof(NEW.authoritative_metering) IS DISTINCT FROM 'object'
       OR NEW.authoritative_metering->>'tenant_id' IS DISTINCT FROM NEW.tenant_id
       OR NEW.authoritative_metering->>'request_id' IS DISTINCT FROM NEW.request_id)
    THEN RAISE EXCEPTION 'usage canonical scope mismatch'; END IF;
    IF NEW.usage_event_id IS NOT NULL THEN
      PERFORM 1 FROM public.usage_events WHERE id=NEW.usage_event_id AND tenant_id=NEW.tenant_id AND request_id=NEW.request_id FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'usage event scope mismatch'; END IF;
    END IF;
    IF NEW.frozen_pricing IS NOT NULL AND jsonb_typeof(NEW.frozen_pricing) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'invalid frozen pricing'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enforce_usage_record_provenance() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER usage_record_provenance BEFORE INSERT OR UPDATE OR DELETE ON usage_records
FOR EACH ROW EXECUTE FUNCTION enforce_usage_record_provenance();
--> statement-breakpoint
CREATE FUNCTION enforce_sale_snapshot_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND (OLD.provenance_version IS NOT NULL OR EXISTS(
    SELECT 1 FROM public.request_records r JOIN public.request_project_facts f ON f.request_id=r.id
    WHERE r.sale_price_snapshot_id=OLD.id)) THEN
    IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable sale provenance'; END IF;
    IF OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'immutable sale provenance'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF NEW.provenance_version IS NULL THEN
    IF NEW.provider_currency IS NOT NULL OR NEW.rate_currency IS NOT NULL THEN RAISE EXCEPTION 'incomplete sale provenance'; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'legacy sale provenance requires independent evidence'; END IF;
  IF NEW.provenance_version <> 'provider-rates-v1' OR NEW.provider_currency IS NULL OR NEW.rate_currency IS DISTINCT FROM NEW.provider_currency
  THEN RAISE EXCEPTION 'invalid sale provenance'; END IF;
  PERFORM 1 FROM public.provider_price_versions WHERE id=NEW.provider_price_version_id AND currency=NEW.provider_currency FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'sale provider currency mismatch'; END IF;
  IF NEW.rate_currency <> NEW.currency THEN
    PERFORM 1 FROM public.exchange_rate_snapshots WHERE id=NEW.exchange_rate_snapshot_id AND base_currency=NEW.rate_currency AND quote_currency=NEW.currency AND rate>0 FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'sale directed exchange pin mismatch'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enforce_sale_snapshot_provenance() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER sale_snapshot_provenance BEFORE INSERT OR UPDATE OR DELETE ON sale_price_snapshots
FOR EACH ROW EXECUTE FUNCTION enforce_sale_snapshot_provenance();
--> statement-breakpoint
CREATE FUNCTION enforce_frozen_price_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE referenced boolean;
BEGIN
  IF TG_TABLE_NAME = 'exchange_rate_snapshots' THEN
    SELECT EXISTS(SELECT 1 FROM public.sale_price_snapshots WHERE exchange_rate_snapshot_id=OLD.id AND provenance_version IS NOT NULL)
      OR EXISTS(SELECT 1 FROM public.request_records r JOIN public.request_project_facts f ON f.request_id=r.id WHERE r.exchange_rate_snapshot_id=OLD.id) INTO referenced;
    IF referenced THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable frozen exchange rate'; END IF;
      IF OLD IS DISTINCT FROM NEW THEN RAISE EXCEPTION 'immutable frozen exchange rate'; END IF;
    END IF;
  ELSE
    SELECT EXISTS(SELECT 1 FROM public.sale_price_snapshots WHERE provider_price_version_id=OLD.id AND provenance_version IS NOT NULL)
      OR EXISTS(SELECT 1 FROM public.attempts WHERE price_version_id=OLD.id AND execution_mode IS NOT NULL)
      OR EXISTS(SELECT 1 FROM public.request_records r JOIN public.request_project_facts f ON f.request_id=r.id WHERE r.provider_price_version_id=OLD.id) INTO referenced;
    IF referenced THEN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable frozen provider price'; END IF;
      IF (to_jsonb(OLD)-ARRAY['status','approved_by','approved_at','effective_from','effective_to']) IS DISTINCT FROM
         (to_jsonb(NEW)-ARRAY['status','approved_by','approved_at','effective_from','effective_to'])
      THEN RAISE EXCEPTION 'immutable frozen provider price'; END IF;
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enforce_frozen_price_source() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER frozen_exchange_source BEFORE UPDATE OR DELETE ON exchange_rate_snapshots FOR EACH ROW EXECUTE FUNCTION enforce_frozen_price_source();
--> statement-breakpoint
CREATE TRIGGER frozen_provider_source BEFORE UPDATE OR DELETE ON provider_price_versions FOR EACH ROW EXECUTE FUNCTION enforce_frozen_price_source();
--> statement-breakpoint
CREATE FUNCTION lock_attempt_price_source() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.execution_mode IS NOT NULL THEN
    PERFORM 1 FROM public.provider_price_versions WHERE id=NEW.price_version_id FOR SHARE;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lock_attempt_price_source() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER attempt_price_source_lock BEFORE INSERT OR UPDATE OF execution_mode,price_version_id ON attempts FOR EACH ROW EXECUTE FUNCTION lock_attempt_price_source();
--> statement-breakpoint
CREATE FUNCTION lock_captured_request_price_sources() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r public.request_records%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.request_records WHERE id=NEW.request_id AND tenant_id=NEW.tenant_id;
  PERFORM 1 FROM public.provider_price_versions WHERE id=r.provider_price_version_id FOR SHARE;
  PERFORM 1 FROM public.sale_price_snapshots WHERE id=r.sale_price_snapshot_id FOR SHARE;
  PERFORM 1 FROM public.exchange_rate_snapshots WHERE id=r.exchange_rate_snapshot_id FOR SHARE;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lock_captured_request_price_sources() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER captured_request_price_source_lock BEFORE INSERT ON request_project_facts FOR EACH ROW EXECUTE FUNCTION lock_captured_request_price_sources();
--> statement-breakpoint
CREATE FUNCTION lock_budget_pricing_sources(p_tenant text,p_org text,p_key text,p_price text,p_sale text,p_fx text,p_provider text,p_model text,p_currency text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE price public.provider_price_versions%ROWTYPE;
DECLARE sale public.sale_price_snapshots%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.downstream_api_keys k JOIN public.organizations o ON o.id=k.organization_id
    WHERE k.id=p_key AND k.tenant_id=p_tenant AND k.organization_id=p_org AND o.tenant_id=p_tenant
      AND k.enabled=true AND k.revoked_at IS NULL AND k.deleted_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())
      AND o.status='active' AND o.deleted_at IS NULL FOR SHARE OF k,o;
  IF NOT FOUND THEN RAISE EXCEPTION 'budget pricing identity scope mismatch'; END IF;
  SELECT v.* INTO price FROM public.provider_price_versions v JOIN public.providers p ON p.id=v.provider_id
    WHERE v.id=p_price AND p.code=p_provider AND p.enabled AND v.upstream_model_id=p_model AND v.status='active'
      AND (v.effective_from IS NULL OR v.effective_from<=now()) AND (v.effective_to IS NULL OR v.effective_to>now()) FOR SHARE OF v;
  IF NOT FOUND THEN RAISE EXCEPTION 'budget provider price pin mismatch'; END IF;
  SELECT * INTO sale FROM public.sale_price_snapshots WHERE id=p_sale FOR SHARE;
  IF NOT FOUND OR sale.provider_price_version_id IS DISTINCT FROM p_price OR sale.exchange_rate_snapshot_id IS DISTINCT FROM p_fx
    OR sale.currency IS DISTINCT FROM p_currency THEN RAISE EXCEPTION 'budget sale pin mismatch'; END IF;
  PERFORM 1 FROM public.sale_price_rules WHERE id=sale.rule_id AND provider_id=price.provider_id AND upstream_model_id=p_model
    AND (tenant_id=p_tenant OR tenant_id IS NULL) AND (organization_id=p_org OR organization_id IS NULL) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'budget sale ownership scope mismatch'; END IF;
  IF sale.provenance_version IS NULL THEN
    IF price.currency IS DISTINCT FROM sale.currency THEN RAISE EXCEPTION 'ambiguous legacy sale provenance'; END IF;
  ELSIF sale.provenance_version <> 'provider-rates-v1' OR sale.provider_currency IS DISTINCT FROM price.currency OR sale.rate_currency IS DISTINCT FROM price.currency THEN
    RAISE EXCEPTION 'invalid sale provenance';
  END IF;
  IF p_fx IS NOT NULL THEN
    PERFORM 1 FROM public.exchange_rate_snapshots WHERE id=p_fx AND base_currency=price.currency AND quote_currency=p_currency AND rate>0 FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'budget directed exchange pin mismatch'; END IF;
  ELSIF price.currency IS DISTINCT FROM p_currency THEN RAISE EXCEPTION 'budget missing exchange pin'; END IF;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION lock_budget_pricing_sources(text,text,text,text,text,text,text,text,text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION enforce_captured_request_pricing_pins() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE captured_mode text;
DECLARE terminal boolean;
BEGIN
  SELECT execution_mode INTO captured_mode FROM public.request_project_facts WHERE request_id=OLD.id AND tenant_id=OLD.tenant_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  terminal := OLD.status::text IN ('completed','failed','unknown','reconciled');
  IF (captured_mode='managed' OR terminal OR OLD.provider_price_version_id IS NOT NULL) AND
    ROW(OLD.provider_price_version_id,OLD.sale_price_snapshot_id,OLD.exchange_rate_snapshot_id,OLD.charge_currency)
    IS DISTINCT FROM ROW(NEW.provider_price_version_id,NEW.sale_price_snapshot_id,NEW.exchange_rate_snapshot_id,NEW.charge_currency)
  THEN RAISE EXCEPTION 'immutable captured request pricing pins'; END IF;
  IF terminal AND (ROW(OLD.resolved_provider_id,OLD.resolved_upstream_model_id) IS DISTINCT FROM ROW(NEW.resolved_provider_id,NEW.resolved_upstream_model_id)
    OR NEW.status::text NOT IN ('completed','failed','unknown','reconciled'))
  THEN RAISE EXCEPTION 'immutable terminal request pricing identity'; END IF;
  IF NOT terminal THEN
    PERFORM 1 FROM public.provider_price_versions WHERE id=NEW.provider_price_version_id FOR SHARE;
    PERFORM 1 FROM public.sale_price_snapshots WHERE id=NEW.sale_price_snapshot_id FOR SHARE;
    PERFORM 1 FROM public.exchange_rate_snapshots WHERE id=NEW.exchange_rate_snapshot_id FOR SHARE;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION enforce_captured_request_pricing_pins() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER captured_request_pricing_pins BEFORE UPDATE ON request_records FOR EACH ROW EXECUTE FUNCTION enforce_captured_request_pricing_pins();
