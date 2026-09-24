CREATE TABLE "nexus_tasks" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"original_goal" text NOT NULL,
	"cwd" text NOT NULL,
	"status" text DEFAULT 'paused' NOT NULL,
	"active_resource" text,
	"active_tool" text DEFAULT 'codex' NOT NULL,
	"active_session" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_action" text,
	"requested_connection_id" text,
	"command_seq" integer DEFAULT 0 NOT NULL,
	"pause_reason" text,
	"next_reset_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_routing_policies" (
	"tenant_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"policy" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resource_routing_policies_tenant_id_organization_id_project_id_pk" PRIMARY KEY("tenant_id","organization_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "task_handoff_snapshots" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"source_connection_id" text,
	"source_session_id" text,
	"target_connection_id" text,
	"reason" text NOT NULL,
	"workspace_state" jsonb NOT NULL,
	"handoff_summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_sessions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"task_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"profile_ref" text NOT NULL,
	"tool" text DEFAULT 'codex' NOT NULL,
	"external_session_id" text,
	"status" text NOT NULL,
	"reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "task_handoff_snapshots" ADD CONSTRAINT "task_handoff_snapshots_task_id_nexus_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."nexus_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_sessions" ADD CONSTRAINT "task_sessions_task_id_nexus_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."nexus_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nexus_tasks_scope_idx" ON "nexus_tasks" USING btree ("tenant_id","organization_id","project_id");--> statement-breakpoint
CREATE INDEX "task_snapshots_scope_idx" ON "task_handoff_snapshots" USING btree ("tenant_id","organization_id","task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_sessions_external_idx" ON "task_sessions" USING btree ("tenant_id","organization_id","tool","external_session_id");