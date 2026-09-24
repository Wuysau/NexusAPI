CREATE TABLE "task_resource_transitions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"source_connection_id" text,
	"target_connection_id" text NOT NULL,
	"source_conversation_id" text,
	"target_conversation_id" text NOT NULL,
	"switch_type" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_resource_transitions" ADD CONSTRAINT "task_resource_transitions_task_id_nexus_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."nexus_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_resource_transitions_scope_idx" ON "task_resource_transitions" USING btree ("tenant_id","organization_id","task_id");