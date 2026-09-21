-- Run transactionally through scripts/provision-workload-roles.mjs after canonical schema installation.
DO $$
DECLARE role_name text;
BEGIN
  IF to_regclass('public.ledger_transactions') IS NULL OR to_regclass('public.request_records') IS NULL
     OR to_regclass('public.usage_records') IS NULL THEN
    RAISE EXCEPTION 'canonical schema prerequisite missing';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['nexus_owner','nexus_control','nexus_gateway','nexus_worker','nexus_budget'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',role_name);
    END IF;
    IF role_name <> 'nexus_owner' AND (
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
      OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=role_name AND c.relnamespace='public'::regnamespace)
      OR EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner WHERE r.rolname=role_name AND n.nspname='public')
      OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE r.rolname=role_name AND p.pronamespace='public'::regnamespace)
      OR EXISTS(SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE r.rolname=role_name AND d.datname=current_database())
      OR EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=role_name)
    ) THEN RAISE EXCEPTION 'unsafe existing workload role: %',role_name; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_policy WHERE polrelid IN ('public.ledger_transactions'::regclass,'public.ledger_postings'::regclass)
    AND polname NOT IN ('workload_read','budget_insert','worker_insert','control_insert')) THEN
    RAISE EXCEPTION 'unexpected existing ledger RLS policy: review before provisioning';
  END IF;
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC,nexus_control,nexus_gateway,nexus_worker,nexus_budget;
GRANT USAGE ON SCHEMA public TO nexus_control,nexus_gateway,nexus_worker,nexus_budget;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,nexus_control,nexus_gateway,nexus_worker,nexus_budget;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC,nexus_control,nexus_gateway,nexus_worker,nexus_budget;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE nexus_owner IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN (VALUES('nexus_control'),('nexus_gateway'),('nexus_worker'),('nexus_budget')) AS w(role_name)
    WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')
      AND has_schema_privilege(w.role_name,n.oid,'USAGE') AND has_function_privilege(w.role_name,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'accessible SECURITY DEFINER function: remove privilege before provisioning';
  END IF;
END $$;
-- Table-level REVOKE does not remove column-level ACLs.
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT c.oid::regclass AS relation,string_agg(format('%I',a.attname),',') AS columns
    FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
    GROUP BY c.oid LOOP
    EXECUTE format('REVOKE SELECT (%s),INSERT (%s),UPDATE (%s),REFERENCES (%s) ON %s FROM PUBLIC,nexus_control,nexus_gateway,nexus_worker,nexus_budget',
      item.columns,item.columns,item.columns,item.columns,item.relation);
  END LOOP;
END $$;
-- Control owns product configuration/authentication. Financial append-only tables are overridden below.
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO nexus_control;
REVOKE ALL ON ledger_transactions,ledger_postings FROM nexus_control;
REVOKE INSERT,UPDATE,DELETE ON usage_records,usage_events FROM nexus_control;
GRANT SELECT,INSERT ON ledger_transactions,ledger_postings TO nexus_control,nexus_worker,nexus_budget;
GRANT SELECT,INSERT,UPDATE ON request_records,attempts,outbox_events TO nexus_gateway;
-- Expansion compatibility: installations before 0008 do not have this table.
DO $$ BEGIN
  IF to_regclass('public.request_project_facts') IS NOT NULL THEN
    REVOKE ALL ON request_project_facts FROM nexus_control,nexus_gateway,nexus_worker,nexus_budget;
    GRANT SELECT ON request_project_facts TO nexus_control,nexus_gateway,nexus_worker,nexus_budget;
    GRANT INSERT ON request_project_facts TO nexus_gateway,nexus_budget;
  END IF;
END $$;
GRANT SELECT ON organizations,downstream_api_keys,providers,provider_price_versions,sale_price_rules,
 sale_price_snapshots,exchange_rate_snapshots,wallet_accounts,request_records,ledger_accounts TO nexus_budget;
GRANT INSERT ON request_records,ledger_accounts TO nexus_budget;
GRANT UPDATE(wallet_id) ON ledger_accounts TO nexus_budget;
GRANT SELECT ON organizations,wallet_accounts,provider_price_versions,price_components,sale_price_rules,
 sale_price_snapshots,exchange_rate_snapshots,ledger_accounts,attempts TO nexus_worker;
GRANT SELECT,INSERT,UPDATE ON request_records,outbox_events,usage_events,usage_records,reconciliation_cases TO nexus_worker;
GRANT INSERT ON ledger_accounts TO nexus_worker;
GRANT SELECT,INSERT ON audit_events TO nexus_worker;
GRANT UPDATE(wallet_id) ON ledger_accounts TO nexus_worker;
-- Workload identities never own these tables; even an accidentally owning identity remains subject to RLS.
ALTER TABLE ledger_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_postings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_postings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workload_read ON ledger_transactions;
CREATE POLICY workload_read ON ledger_transactions FOR SELECT TO nexus_control,nexus_worker,nexus_budget USING (true);
DROP POLICY IF EXISTS workload_read ON ledger_postings;
CREATE POLICY workload_read ON ledger_postings FOR SELECT TO nexus_control,nexus_worker,nexus_budget USING (true);
DROP POLICY IF EXISTS budget_insert ON ledger_transactions;
CREATE POLICY budget_insert ON ledger_transactions FOR INSERT TO nexus_budget WITH CHECK (type='reservation');
DROP POLICY IF EXISTS worker_insert ON ledger_transactions;
CREATE POLICY worker_insert ON ledger_transactions FOR INSERT TO nexus_worker WITH CHECK (type IN ('usage','reservation_release'));
DROP POLICY IF EXISTS control_insert ON ledger_transactions;
CREATE POLICY control_insert ON ledger_transactions FOR INSERT TO nexus_control WITH CHECK
 (type IN ('recharge','refund','adjustment','promotional_credit','correction','reservation_release'));
DROP POLICY IF EXISTS budget_insert ON ledger_postings;
CREATE POLICY budget_insert ON ledger_postings FOR INSERT TO nexus_budget WITH CHECK
 (EXISTS(SELECT 1 FROM ledger_transactions t WHERE t.id=transaction_id AND t.tenant_id=ledger_postings.tenant_id AND t.currency=ledger_postings.currency AND t.type='reservation')
 AND EXISTS(SELECT 1 FROM ledger_accounts a WHERE a.id=account_id AND a.tenant_id=ledger_postings.tenant_id AND a.currency=ledger_postings.currency
   AND ((a.type='wallet' AND entry_type='debit' AND amount<=0) OR (a.type='reservation' AND entry_type='credit' AND amount>=0))));
DROP POLICY IF EXISTS worker_insert ON ledger_postings;
CREATE POLICY worker_insert ON ledger_postings FOR INSERT TO nexus_worker WITH CHECK
 (EXISTS(SELECT 1 FROM ledger_transactions t WHERE t.id=transaction_id AND t.tenant_id=ledger_postings.tenant_id AND t.currency=ledger_postings.currency AND t.type IN ('usage','reservation_release')));
DROP POLICY IF EXISTS control_insert ON ledger_postings;
CREATE POLICY control_insert ON ledger_postings FOR INSERT TO nexus_control WITH CHECK
 (EXISTS(SELECT 1 FROM ledger_transactions t WHERE t.id=transaction_id AND t.tenant_id=ledger_postings.tenant_id AND t.currency=ledger_postings.currency AND t.type IN ('recharge','refund','adjustment','promotional_credit','correction','reservation_release')));

-- Rebinding an existing account changes the meaning of historical postings.
-- No-op wallet upserts remain compatible with ensureWalletLedgerAccount.
CREATE OR REPLACE FUNCTION guard_ledger_account_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.tenant_id,NEW.wallet_id,NEW.type,NEW.currency,NEW.code)
    IS DISTINCT FROM (OLD.id,OLD.tenant_id,OLD.wallet_id,OLD.type,OLD.currency,OLD.code) THEN
    RAISE EXCEPTION 'ledger_account_identity_immutable';
  END IF;
  IF (NEW.type='wallet' AND (NEW.wallet_id IS NULL OR NOT EXISTS(SELECT 1 FROM wallet_accounts w
      WHERE w.id=NEW.wallet_id AND w.tenant_id=NEW.tenant_id AND w.currency=NEW.currency)))
    OR (NEW.type<>'wallet' AND NEW.wallet_id IS NOT NULL) THEN
    RAISE EXCEPTION 'ledger_account_wallet_binding_invalid';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_ledger_account_identity() FROM PUBLIC,nexus_control,nexus_gateway,nexus_worker,nexus_budget;
DROP TRIGGER IF EXISTS ledger_account_identity_guard ON ledger_accounts;
CREATE TRIGGER ledger_account_identity_guard BEFORE INSERT OR UPDATE ON ledger_accounts
 FOR EACH ROW EXECUTE FUNCTION guard_ledger_account_identity();

-- Only the Budget workload may acquire scoped pricing-source locks before authorization.
DO $$ BEGIN
  IF to_regprocedure('public.lock_budget_pricing_sources(text,text,text,text,text,text,text,text,text)') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.lock_budget_pricing_sources(text,text,text,text,text,text,text,text,text) TO nexus_budget;
  END IF;
END $$;
