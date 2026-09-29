CREATE TABLE connector_pairings (
  connection_id text PRIMARY KEY REFERENCES owned_connections(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
--> statement-breakpoint
CREATE TABLE connector_identities (
  id text PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id text NOT NULL UNIQUE REFERENCES owned_connections(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  credential_hash text NOT NULL UNIQUE,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE connector_leases ADD COLUMN connector_id text REFERENCES connector_identities(id);
ALTER TABLE connector_leases ADD COLUMN ready_models jsonb NOT NULL DEFAULT '[]';
ALTER TABLE connector_leases ADD COLUMN transport_seen_at timestamptz;
CREATE UNIQUE INDEX connector_leases_token_idx ON connector_leases(lease_token_hash);
