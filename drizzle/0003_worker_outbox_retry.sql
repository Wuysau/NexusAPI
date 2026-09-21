-- Work Item F — worker-owned outbox retry bookkeeping (expand-only).
--
-- The outbox relay/consumer needs to schedule exponential retries and to make a
-- claim observable. The original outbox_events shape (0001) only carries
-- status/attempts/last_error, which cannot express "eligible again at T".
--
-- All three columns are NULLABLE and ADDITIVE, so this migration is safe to
-- apply while the old gateway and a new worker run side by side: a writer that
-- does not know the columns keeps working (they default to NULL), and a NULL
-- next_attempt_at means "eligible now".
--
-- claimed_by/claimed_at are observability only — the authoritative claim is the
-- row lock taken with SELECT ... FOR UPDATE SKIP LOCKED, which is released by
-- commit/rollback even if a worker dies mid-batch.
ALTER TABLE "outbox_events" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN IF NOT EXISTS "claimed_by" text;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;--> statement-breakpoint
-- Claimable-batch lookup: status + eligibility time, matching the consumer's
-- WHERE clause so the hot poll never degrades to a seq scan.
CREATE INDEX IF NOT EXISTS "outbox_events_claim_idx" ON "outbox_events" USING btree ("status","next_attempt_at");--> statement-breakpoint
