-- Align the existing connector constraints with the ORM generator names.
-- Rename preserves each constraint and its enforcement; UNIQUE backing indexes
-- are renamed by PostgreSQL as part of the same operation.
ALTER TABLE "connector_pairings" RENAME CONSTRAINT "connector_pairings_connection_id_fkey" TO "connector_pairings_connection_id_owned_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "connector_pairings" RENAME CONSTRAINT "connector_pairings_token_hash_key" TO "connector_pairings_token_hash_unique";
--> statement-breakpoint
ALTER TABLE "connector_identities" RENAME CONSTRAINT "connector_identities_connection_id_fkey" TO "connector_identities_connection_id_owned_connections_id_fk";
--> statement-breakpoint
ALTER TABLE "connector_identities" RENAME CONSTRAINT "connector_identities_connection_id_key" TO "connector_identities_connection_id_unique";
--> statement-breakpoint
ALTER TABLE "connector_identities" RENAME CONSTRAINT "connector_identities_credential_hash_key" TO "connector_identities_credential_hash_unique";
--> statement-breakpoint
ALTER TABLE "connector_leases" RENAME CONSTRAINT "connector_leases_connector_id_fkey" TO "connector_leases_connector_id_connector_identities_id_fk";
