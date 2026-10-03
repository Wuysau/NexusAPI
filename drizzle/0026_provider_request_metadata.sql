-- Provider identifiers are opaque diagnostic metadata. Operation idempotency
-- remains anchored by request/attempt identities and tenant-scoped event IDs.
DROP INDEX "attempts_upstream_request_idx";
--> statement-breakpoint
CREATE INDEX "attempts_upstream_request_idx" ON "attempts" USING btree ("tenant_id", "upstream_request_id");
--> statement-breakpoint
DROP INDEX "usage_events_tenant_provider_req_idx";
--> statement-breakpoint
CREATE INDEX "usage_events_tenant_provider_req_idx" ON "usage_events" USING btree ("tenant_id", "provider_request_id");
