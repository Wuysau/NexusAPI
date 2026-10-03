// NexusAPI database schema.
//
// Money invariant: all monetary AMOUNTS (balances, charges, costs, ledger
// entries, reservations) are stored as bigint "micros" — integer 1e-6 of the
// currency unit (e.g. USD 1.234567 == 1234567). This avoids IEEE-754 float
// entirely. See src/lib/money.ts. PRICE RECORDS (per-unit rates from
// providers) use numeric(18,8) because provider rates are ratios, not
// settled amounts; they are converted to integer micros at charge time.
//
// Soft deletes use `deleted_at` rather than destructive deletes so billing
// and audit history remain intact (BYOK key deletion, user removal, etc.).

import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  numeric,
  doublePrecision,
  pgEnum,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// Task supervision is independent of gateway dispatch and settlement.
export const resourceRoutingPolicies = pgTable(
  'resource_routing_policies',
  {
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').notNull(),
    projectId: text('project_id').notNull(),
    policy: jsonb('policy').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.organizationId, t.projectId] })],
)

export const nexusTasks = pgTable(
  'nexus_tasks',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').notNull(),
    projectId: text('project_id').notNull(),
    originalGoal: text('original_goal').notNull(),
    cwd: text('cwd').notNull(),
    status: text('status').notNull().default('paused'),
    activeResource: text('active_resource'),
    activeTool: text('active_tool').notNull().default('codex'),
    activeSession: text('active_session'),
    context: jsonb('context').notNull().default({}),
    requestedAction: text('requested_action'),
    requestedConnectionId: text('requested_connection_id'),
    commandSeq: integer('command_seq').notNull().default(0),
    pauseReason: text('pause_reason'),
    nextResetAt: timestamp('next_reset_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('nexus_tasks_scope_idx').on(t.tenantId, t.organizationId, t.projectId)],
)

export const taskSessions = pgTable(
  'task_sessions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => nexusTasks.id),
    connectionId: text('connection_id').notNull(),
    profileRef: text('profile_ref').notNull(),
    tool: text('tool').notNull().default('codex'),
    externalSessionId: text('external_session_id'),
    status: text('status').notNull(),
    reason: text('reason'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('task_sessions_external_idx').on(t.tenantId, t.organizationId, t.tool, t.externalSessionId)],
)

export const taskHandoffSnapshots = pgTable(
  'task_handoff_snapshots',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => nexusTasks.id),
    sourceConnectionId: text('source_connection_id'),
    sourceSessionId: text('source_session_id'),
    targetConnectionId: text('target_connection_id'),
    reason: text('reason').notNull(),
    workspaceState: jsonb('workspace_state').notNull(),
    handoffSummary: jsonb('handoff_summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('task_snapshots_scope_idx').on(t.tenantId, t.organizationId, t.taskId)],
)

export const taskResourceTransitions = pgTable(
  'task_resource_transitions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').notNull(),
    taskId: text('task_id')
      .notNull()
      .references(() => nexusTasks.id),
    sourceConnectionId: text('source_connection_id'),
    targetConnectionId: text('target_connection_id').notNull(),
    sourceConversationId: text('source_conversation_id'),
    targetConversationId: text('target_conversation_id').notNull(),
    switchType: text('switch_type').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('task_resource_transitions_scope_idx').on(t.tenantId, t.organizationId, t.taskId)],
)

// External observations never reference financial usage/outbox tables.
export const projectWorkspaceRoots = pgTable(
  'project_workspace_roots',
  {
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').notNull(),
    root: text('root').notNull(),
    projectId: text('project_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.organizationId, t.root] })],
)

export const observerRuntime = pgTable(
  'observer_runtime',
  {
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').notNull(),
    instanceId: text('instance_id').notNull(),
    state: text('state').notNull(),
    enabled: boolean('enabled').notNull(),
    intervalSeconds: integer('interval_seconds').notNull(),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    lastSyncStartedAt: timestamp('last_sync_started_at', { withTimezone: true }),
    lastSyncCompletedAt: timestamp('last_sync_completed_at', { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', { withTimezone: true }),
    lastError: text('last_error'),
    nextSyncAt: timestamp('next_sync_at', { withTimezone: true }),
    lastNewSessions: integer('last_new_sessions').notNull().default(0),
    lastNewEvents: integer('last_new_events').notNull().default(0),
    lastUnassignedEvents: integer('last_unassigned_events').notNull().default(0),
    lastResult: jsonb('last_result').notNull().default({}),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.organizationId, t.instanceId] })],
)

export const observerScanCursors = pgTable(
  'observer_scan_cursors',
  {
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').notNull(),
    fileId: text('file_id').notNull(),
    parserVersion: text('parser_version').notNull(),
    byteOffset: bigint('byte_offset', { mode: 'number' }).notNull(),
    state: jsonb('state').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.organizationId, t.fileId] })],
)

export const externalObservedUsage = pgTable(
  'external_observed_usage',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').notNull(),
    usageSource: text('usage_source').notNull(),
    authority: text('authority').notNull(),
    externalSessionId: text('external_session_id').notNull(),
    sessionKind: text('session_kind'),
    parentSessionId: text('parent_session_id'),
    externalEventId: text('external_event_id').notNull(),
    turnId: text('turn_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    cwd: text('cwd'),
    providerIdentifier: text('provider_identifier'),
    provider: text('provider'),
    subscriptionProduct: text('subscription_product'),
    connectionId: text('connection_id'),
    model: text('model'),
    inputTokens: numeric('input_tokens', { precision: 30, scale: 0 }),
    cachedInputTokens: numeric('cached_input_tokens', { precision: 30, scale: 0 }),
    outputTokens: numeric('output_tokens', { precision: 30, scale: 0 }),
    reasoningTokens: numeric('reasoning_tokens', { precision: 30, scale: 0 }),
    totalTokens: numeric('total_tokens', { precision: 30, scale: 0 }),
    projectId: text('project_id'),
    projectName: text('project_name'),
    matchedRoot: text('matched_root'),
    attributedAt: timestamp('attributed_at', { withTimezone: true }),
    cliVersion: text('cli_version'),
    parserVersion: text('parser_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('observed_usage_event_unique').on(t.tenantId, t.usageSource, t.externalEventId),
    index('observed_usage_scope_time_idx').on(t.tenantId, t.organizationId, t.occurredAt),
  ],
)

// ──────────────────────────────────────────────────────────────────────
// Identity & organizations
// ──────────────────────────────────────────────────────────────────────

export const orgKind = pgEnum('org_kind', ['platform', 'customer'])
export const userStatus = pgEnum('user_status', ['active', 'suspended', 'invited'])
export const memberRole = pgEnum('member_role', ['owner', 'admin', 'developer', 'billing', 'viewer'])

export const organizations = pgTable(
  'organizations',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // tenant_id is the canonical tenant identifier. During the expand phase it
    // mirrors organization_id (= the org's own id); the contract phase later
    // drops organization_id from child tables and keeps only tenant_id.
    tenantId: text('tenant_id')
      .notNull()
      .default(sql`gen_random_uuid()`),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    kind: orgKind('kind').notNull().default('customer'),
    baseCurrency: text('base_currency').notNull().default('USD'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    slugIdx: uniqueIndex('organizations_slug_idx').on(t.slug),
    tenantIdx: uniqueIndex('organizations_tenant_idx').on(t.tenantId),
  }),
)

export const users = pgTable(
  'users',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name'),
    status: userStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    emailIdx: uniqueIndex('users_email_idx').on(t.email),
  }),
)

export const organizationMemberships = pgTable(
  'organization_memberships',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    tenantId: text('tenant_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: memberRole('role').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgUserIdx: uniqueIndex('memberships_org_user_idx').on(t.organizationId, t.userId),
    tenantUserIdx: uniqueIndex('memberships_tenant_user_idx').on(t.tenantId, t.userId),
  }),
)

// Secure session tokens: only a hash is stored, token presented once to client.
export const sessions = pgTable(
  'sessions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    tokenHashIdx: uniqueIndex('sessions_token_hash_idx').on(t.tokenHash),
  }),
)

// ──────────────────────────────────────────────────────────────────────
// Owned access: projects, connections, leases and quota snapshots
// ──────────────────────────────────────────────────────────────────────

export const projects = pgTable(
  'projects',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    name: text('name').notNull(),
    status: text('status').notNull().default('active'),
    policyVersion: integer('policy_version').notNull().default(1),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({ projectTenantIdx: index('projects_tenant_idx').on(t.tenantId, t.status) }),
)

export const projectMemberships = pgTable(
  'project_memberships',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').notNull().default('member'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectUserIdx: uniqueIndex('project_memberships_project_user_idx').on(t.projectId, t.userId),
    pmTenantIdx: index('project_memberships_tenant_idx').on(t.tenantId),
  }),
)

export const ownedConnections = pgTable(
  'owned_connections',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id),
    projectId: text('project_id').references(() => projects.id),
    provider: text('provider').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull().default('pending'),
    credentialRef: text('credential_ref'),
    credentialFingerprint: text('credential_fingerprint'),
    capabilities: jsonb('capabilities').$type<Record<string, unknown>>().notNull().default({}),
    accountObservation: jsonb('account_observation').$type<Record<string, unknown>>(),
    runtimeObservation: jsonb('runtime_observation').$type<Record<string, unknown>>(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    connTenantIdx: index('owned_connections_tenant_idx').on(t.tenantId, t.status),
    connOwnerIdx: index('owned_connections_owner_idx').on(t.tenantId, t.ownerUserId),
  }),
)

export const connectorPairings = pgTable('connector_pairings', {
  connectionId: text('connection_id')
    .primaryKey()
    .references(() => ownedConnections.id, { onDelete: 'cascade' }),
  tenantId: text('tenant_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
})
export const connectorIdentities = pgTable('connector_identities', {
  id: text('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  connectionId: text('connection_id')
    .notNull()
    .unique()
    .references(() => ownedConnections.id, { onDelete: 'cascade' }),
  tenantId: text('tenant_id').notNull(),
  credentialHash: text('credential_hash').notNull().unique(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
export const connectorLeases = pgTable(
  'connector_leases',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => ownedConnections.id, { onDelete: 'cascade' }),
    leaseTokenHash: text('lease_token_hash').notNull(),
    connectorId: text('connector_id').references(() => connectorIdentities.id),
    readyModels: jsonb('ready_models').$type<string[]>().notNull().default([]),
    transportSeenAt: timestamp('transport_seen_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    leaseConnIdx: uniqueIndex('connector_leases_connection_idx').on(t.connectionId),
    leaseTokenIdx: uniqueIndex('connector_leases_token_idx').on(t.leaseTokenHash),
    leaseTenantIdx: index('connector_leases_tenant_idx').on(t.tenantId, t.expiresAt),
  }),
)

export const quotaSnapshots = pgTable(
  'quota_snapshots',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    connectionId: text('connection_id')
      .notNull()
      .references(() => ownedConnections.id),
    windowType: text('window_type').notNull(),
    observationId: text('observation_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    scope: text('scope').default('unknown'),
    sourceKind: text('source_kind').default('unknown'),
    attributionMode: text('attribution_mode').default('unknown'),
    availability: text('availability').default('unknown'),
    provenanceVersion: integer('provenance_version'),
    used: numeric('used', { precision: 30, scale: 12 }),
    remaining: numeric('remaining', { precision: 30, scale: 12 }),
    source: text('source').notNull(),
    confidence: text('confidence').notNull().default('unknown'),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow().notNull(),
    staleAt: timestamp('stale_at', { withTimezone: true }),
    resetAt: timestamp('reset_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    quotaTenantIdx: index('quota_snapshots_tenant_idx').on(t.tenantId, t.connectionId, t.observedAt),
    quotaObservationIdx: uniqueIndex('quota_snapshots_observation_idx').on(t.tenantId, t.connectionId, t.observationId),
  }),
)

// ──────────────────────────────────────────────────────────────────────
// Providers, credentials, models, aliases
// ──────────────────────────────────────────────────────────────────────

export const providers = pgTable(
  'providers',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    code: text('code').notNull(), // openai | anthropic | gemini | deepseek | qwen | ...
    name: text('name').notNull(),
    officialBaseUrl: text('official_base_url').notNull(),
    modelsEndpoint: text('models_endpoint'), // path appended to base url for listModels
    authScheme: text('auth_scheme').notNull().default('bearer'), // bearer | x-api-key | query
    enabled: boolean('enabled').notNull().default(true),
    supportsModelSync: boolean('supports_model_sync').notNull().default(false),
    supportsPriceSync: boolean('supports_price_sync').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    codeIdx: uniqueIndex('providers_code_idx').on(t.code),
  }),
)

export const credentialType = pgEnum('credential_type', ['api_key', 'oauth_token'])
export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    organizationId: text('organization_id').references(() => organizations.id), // null = platform-managed
    tenantId: text('tenant_id'), // null = platform-managed; mirrors organization_id during expand
    name: text('name').notNull(),
    encryptedSecret: text('encrypted_secret').notNull(), // AES-256-GCM ciphertext of the provider secret
    encryptionKeyVersion: integer('encryption_key_version').notNull().default(1), // KMS key version that wrapped the DEK
    encryptedDataKey: text('encrypted_data_key'), // KMS-wrapped data encryption key (envelope encryption)
    fingerprint: text('fingerprint'), // truncated sha256(plaintext) — detection only, not a security control
    credentialType: credentialType('credential_type').notNull().default('api_key'),
    isPlatformManaged: boolean('is_platform_managed').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    provOrgIdx: index('credentials_provider_org_idx').on(t.providerId, t.organizationId),
    provTenantIdx: index('credentials_provider_tenant_idx').on(t.providerId, t.tenantId),
  }),
)

export const modelLifecycle = pgEnum('model_lifecycle', ['draft', 'pending_review', 'active', 'deprecated', 'retired'])
export const upstreamModels = pgTable(
  'upstream_models',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    upstreamModelId: text('upstream_model_id').notNull(), // raw id from provider
    displayName: text('display_name').notNull(),
    description: text('description'),
    contextWindow: integer('context_window'),
    maxOutputTokens: integer('max_output_tokens'),
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
    lifecycleStatus: modelLifecycle('lifecycle_status').notNull().default('pending_review'),
    available: boolean('available').notNull().default(false),
    manuallyEnabled: boolean('manually_enabled').notNull().default(false),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    missingSyncCount: integer('missing_sync_count').notNull().default(0),
    rawMetadata: jsonb('raw_metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    provUpstreamIdx: uniqueIndex('upstream_models_provider_id_idx').on(t.providerId, t.upstreamModelId),
  }),
)

// Platform alias → (provider, upstream_model) with priority. Lets callers use a
// stable name ("fast-chat") routed to whichever provider is configured.
// Organization-owned display/configuration entries; never rewrite shared provider identities or prices.
export const organizationModelConfigurations = pgTable(
  'organization_model_configurations',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    upstreamModelId: text('upstream_model_id').notNull(),
    displayName: text('display_name').notNull(),
    notes: text('notes').notNull().default(''),
    version: integer('version').notNull().default(1),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    scopeModelIdx: uniqueIndex('org_model_config_scope_idx').on(
      t.tenantId,
      t.organizationId,
      t.providerId,
      t.upstreamModelId,
    ),
  }),
)

export const modelAliases = pgTable(
  'model_aliases',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    alias: text('alias').notNull(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    upstreamModelId: text('upstream_model_id').notNull(), // references upstream_models.upstream_model_id within provider
    priority: integer('priority').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).defaultNow().notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    aliasProvIdx: uniqueIndex('model_aliases_alias_provider_idx').on(t.alias, t.providerId),
  }),
)

// ──────────────────────────────────────────────────────────────────────
// Pricing — provider cost, sale rules, snapshots, exchange rates
// ──────────────────────────────────────────────────────────────────────

export const priceStatus = pgEnum('price_status', ['pending', 'approved', 'active', 'superseded', 'rejected'])

export const exchangeRateSnapshots = pgTable(
  'exchange_rate_snapshots',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    baseCurrency: text('base_currency').notNull(),
    quoteCurrency: text('quote_currency').notNull(),
    rate: numeric('rate', { precision: 24, scale: 12 }).notNull(), // 1 base = rate quote
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
    effectiveAt: timestamp('effective_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pairIdx: index('fx_pair_idx').on(t.baseCurrency, t.quoteCurrency),
  }),
)

export const providerPriceVersions = pgTable(
  'provider_price_versions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    upstreamModelId: text('upstream_model_id').notNull(),
    currency: text('currency').notNull().default('USD'),
    region: text('region').notNull().default('global'),
    serviceTier: text('service_tier').notNull().default('default'),
    contextMin: integer('context_min'),
    contextMax: integer('context_max'),
    // Per-unit rates as numeric ratios (per the unit below). Not settled money.
    inputPrice: numeric('input_price', { precision: 18, scale: 8 }).notNull(),
    cachedInputPrice: numeric('cached_input_price', { precision: 18, scale: 8 }).notNull().default('0'),
    cacheWritePrice: numeric('cache_write_price', { precision: 18, scale: 8 }).notNull().default('0'),
    outputPrice: numeric('output_price', { precision: 18, scale: 8 }).notNull(),
    reasoningPrice: numeric('reasoning_price', { precision: 18, scale: 8 }).notNull().default('0'),
    requestPrice: numeric('request_price', { precision: 18, scale: 8 }).notNull().default('0'),
    toolPrice: numeric('tool_price', { precision: 18, scale: 8 }).notNull().default('0'),
    imagePrice: numeric('image_price', { precision: 18, scale: 8 }).notNull().default('0'),
    audioPrice: numeric('audio_price', { precision: 18, scale: 8 }).notNull().default('0'),
    unit: text('unit').notNull().default('per_million_tokens'), // per_million_tokens | per_token | per_request | per_image | per_second
    sourceType: text('source_type').notNull(), // official_api | official_market | parsed_page | imported_json | imported_csv | manual
    sourceUrl: text('source_url'),
    sourceDocumentHash: text('source_document_hash'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    status: priceStatus('status').notNull().default('pending'),
    approvedBy: text('approved_by').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    rawSourceData: jsonb('raw_source_data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    modelActiveIdx: index('ppv_model_status_idx').on(t.providerId, t.upstreamModelId, t.status),
  }),
)

export const salePricingMode = pgEnum('sale_pricing_mode', ['cost_multiplier', 'target_margin', 'fixed', 'markup'])

export const salePriceRules = pgTable(
  'sale_price_rules',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text('organization_id').references(() => organizations.id), // null = platform default
    tenantId: text('tenant_id'), // null = platform default; mirrors organization_id during expand
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    upstreamModelId: text('upstream_model_id').notNull(),
    pricingMode: salePricingMode('pricing_mode').notNull(),
    markupRate: numeric('markup_rate', { precision: 18, scale: 8 }).notNull().default('0'), // sale = cost * (1 + markup)
    targetMarginRate: numeric('target_margin_rate', { precision: 18, scale: 8 }).notNull().default('0.3'), // sale = cost / (1 - margin)
    fixedFee: numeric('fixed_fee', { precision: 18, scale: 8 }).notNull().default('0'), // per-request fixed sale price (mode=fixed)
    minimumCharge: numeric('minimum_charge', { precision: 18, scale: 8 }).notNull().default('0'), // floor on sale amount
    currency: text('currency').notNull().default('USD'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).defaultNow().notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ruleOrgModelIdx: index('sale_rules_org_model_idx').on(t.organizationId, t.providerId, t.upstreamModelId),
    ruleTenantModelIdx: index('sale_rules_tenant_model_idx').on(t.tenantId, t.providerId, t.upstreamModelId),
  }),
)

// Immutable published sale-price snapshot. Generated at publish time and
// referenced by every request so historical charges never change.
export const salePriceSnapshots = pgTable('sale_price_snapshots', {
  id: text('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  ruleId: text('rule_id')
    .notNull()
    .references(() => salePriceRules.id),
  providerPriceVersionId: text('provider_price_version_id')
    .notNull()
    .references(() => providerPriceVersions.id),
  exchangeRateSnapshotId: text('exchange_rate_snapshot_id').references(() => exchangeRateSnapshots.id),
  pricingMode: salePricingMode('pricing_mode').notNull(),
  // Per-unit rates use rateCurrency; fixed fees and floors use currency.
  inputPrice: numeric('input_price', { precision: 18, scale: 8 }).notNull(),
  outputPrice: numeric('output_price', { precision: 18, scale: 8 }).notNull(),
  cachedInputPrice: numeric('cached_input_price', { precision: 18, scale: 8 }).notNull().default('0'),
  reasoningPrice: numeric('reasoning_price', { precision: 18, scale: 8 }).notNull().default('0'),
  fixedFee: numeric('fixed_fee', { precision: 18, scale: 8 }).notNull().default('0'),
  minimumCharge: numeric('minimum_charge', { precision: 18, scale: 8 }).notNull().default('0'),
  providerCurrency: text('provider_currency'),
  rateCurrency: text('rate_currency'),
  provenanceVersion: text('provenance_version'),
  currency: text('currency').notNull().default('USD'),
  effectiveAt: timestamp('effective_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// ──────────────────────────────────────────────────────────────────────
// Wallet, ledger, orders, payments
// ──────────────────────────────────────────────────────────────────────

export const walletStatus = pgEnum('wallet_status', ['active', 'frozen', 'closed'])
export const ledgerType = pgEnum('ledger_type', [
  'recharge',
  'usage',
  'refund',
  'adjustment',
  'promotional_credit',
  'reservation',
  'reservation_release',
])

export const walletAccounts = pgTable(
  'wallet_accounts',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    tenantId: text('tenant_id').notNull(),
    currency: text('currency').notNull().default('USD'),
    status: walletStatus('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgCurrencyIdx: uniqueIndex('wallet_org_currency_idx').on(t.organizationId, t.currency),
    tenantCurrencyIdx: uniqueIndex('wallet_tenant_currency_idx').on(t.tenantId, t.currency),
  }),
)

// Append-only ledger. balanceAfter is denormalized for fast reads; the source
// of truth is the sum of entries, validated by the balance invariant.
export const walletLedgerEntries = pgTable(
  'wallet_ledger_entries',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    walletId: text('wallet_id')
      .notNull()
      .references(() => walletAccounts.id),
    type: ledgerType('type').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(), // signed micros; +credit / -debit
    balanceAfter: bigint('balance_after', { mode: 'bigint' }).notNull(),
    referenceType: text('reference_type'), // request | order | adjustment | ...
    referenceId: text('reference_id'),
    idempotencyKey: text('idempotency_key'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    walletCreatedIdx: index('ledger_wallet_created_idx').on(t.walletId, t.createdAt),
    idemIdx: uniqueIndex('ledger_idempotency_idx').on(t.walletId, t.idempotencyKey),
  }),
)

export const orderStatus = pgEnum('order_status', ['pending', 'paid', 'failed', 'refunded', 'cancelled'])
// Work Item G. `subscription` buys a plan version (BYOK-first SaaS; the amount
// is the plan version's fee and the payment is Nexus revenue). `managed_credits`
// buys a platform-managed credit top-up and is gated by the `managed_credits`
// feature flag + a fully approved tenant_compliance record (ADR-0004).
export const orderKind = pgEnum('order_kind', ['subscription', 'managed_credits'])
export const orders = pgTable(
  'orders',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    tenantId: text('tenant_id').notNull(),
    walletId: text('wallet_id')
      .notNull()
      .references(() => walletAccounts.id),
    // For managed_credits this is the credit amount; for subscription it is the
    // plan-version fee. ALWAYS recomputed server-side from the plan version —
    // a browser-supplied amount is never trusted (INVARIANT #15).
    amount: bigint('amount', { mode: 'bigint' }).notNull(), // micros payable
    currency: text('currency').notNull().default('USD'),
    paymentProvider: text('payment_provider').notNull().default('mock'),
    externalOrderId: text('external_order_id'),
    status: orderStatus('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key'),
    // Added by Work Item G (expand-only: NOT NULL with a default, so existing
    // rows and old writers keep working).
    kind: orderKind('kind').notNull().default('managed_credits'),
    planVersionId: text('plan_version_id').references(() => planVersions.id),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
  },
  (t) => ({
    orderExtIdx: uniqueIndex('orders_external_idx').on(t.paymentProvider, t.externalOrderId),
    orderIdemIdx: uniqueIndex('orders_idempotency_idx').on(t.organizationId, t.idempotencyKey),
    orderTenantIdemIdx: uniqueIndex('orders_tenant_idempotency_idx').on(t.tenantId, t.idempotencyKey),
    orderTenantKindIdx: index('orders_tenant_kind_idx').on(t.tenantId, t.kind, t.createdAt),
  }),
)

// ──────────────────────────────────────────────────────────────────────
// Downstream API keys, requests, channel health
// ──────────────────────────────────────────────────────────────────────

export const downstreamApiKeys = pgTable(
  'downstream_api_keys',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    hash: text('hash').notNull(), // sha-256 of the full key
    prefix: text('prefix').notNull(), // recognizable prefix only
    fingerprint: text('fingerprint'), // short fingerprint for display/lookup
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    projectId: text('project_id').references(() => projects.id),
    enabled: boolean('enabled').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    hashIdx: uniqueIndex('downstream_keys_hash_idx').on(t.hash),
    tenantEnabledIdx: index('downstream_keys_tenant_enabled_idx').on(t.tenantId, t.enabled),
  }),
)

export const requestStatus = pgEnum('request_status', [
  'created',
  'reserved',
  'sent',
  'streaming',
  'completed',
  'failed',
  'unknown',
  'reconciled',
])
export const channelKind = pgEnum('channel_kind', ['platform', 'byok'])

export const requestRecords = pgTable(
  'request_records',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organizations.id),
    tenantId: text('tenant_id').notNull(),
    downstreamKeyId: text('downstream_key_id').references(() => downstreamApiKeys.id),
    projectId: text('project_id'), // historical ID; no live-entity FK
    projectName: text('project_name'),
    connectionId: text('connection_id'),
    executionMode: text('execution_mode'),
    attributionStatus: text('attribution_status'),
    requestModel: text('request_model').notNull(), // alias or model id as the client sent it
    resolvedProviderId: text('resolved_provider_id').references(() => providers.id),
    resolvedUpstreamModelId: text('resolved_upstream_model_id'), // actual upstream model used
    providerCredentialId: text('provider_credential_id').references(() => providerCredentials.id),
    channelKind: channelKind('channel_kind').notNull(),
    status: requestStatus('status').notNull().default('created'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    // Price & FX snapshots captured at request time → fully traceable charges.
    providerPriceVersionId: text('provider_price_version_id').references(() => providerPriceVersions.id),
    salePriceSnapshotId: text('sale_price_snapshot_id').references(() => salePriceSnapshots.id),
    exchangeRateSnapshotId: text('exchange_rate_snapshot_id').references(() => exchangeRateSnapshots.id),
    upstreamCostAmount: bigint('upstream_cost_amount', { mode: 'bigint' }), // micros, provider currency
    upstreamCostCurrency: text('upstream_cost_currency'),
    chargeAmount: bigint('charge_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`), // micros debited, org currency
    chargeCurrency: text('charge_currency').notNull().default('USD'),
    costInChargeCurrency: bigint('cost_in_charge_currency', { mode: 'bigint' }), // upstream cost converted
    grossMarginAmount: bigint('gross_margin_amount', { mode: 'bigint' }),
    grossMarginRate: numeric('gross_margin_rate', { precision: 18, scale: 8 }),
    reservationAmount: bigint('reservation_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    reservationReleased: boolean('reservation_released').notNull().default(false),
    reservationExpiresAt: timestamp('reservation_expires_at', { withTimezone: true }),
    idempotencyKey: text('idempotency_key'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'), // redacted, never upstream body
    upstreamRequestId: text('upstream_request_id'),
    traceId: text('trace_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    reqOrgIdx: index('requests_org_created_idx').on(t.organizationId, t.createdAt),
    reqIdemIdx: uniqueIndex('requests_idempotency_idx').on(t.organizationId, t.idempotencyKey),
    reqStatusIdx: index('requests_status_idx').on(t.status),
    reqTenantIdx: index('requests_tenant_created_idx').on(t.tenantId, t.createdAt),
    reqTenantIdemIdx: uniqueIndex('requests_tenant_idempotency_idx').on(t.tenantId, t.idempotencyKey),
  }),
)

export const circuitState = pgEnum('circuit_state', ['closed', 'open', 'half_open'])
export const channelHealth = pgTable(
  'channel_health',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    providerCredentialId: text('provider_credential_id')
      .notNull()
      .references(() => providerCredentials.id, { onDelete: 'cascade' }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    p50LatencyMs: integer('p50_latency_ms'),
    p95LatencyMs: integer('p95_latency_ms'),
    rate429: numeric('rate_429', { precision: 10, scale: 6 }).notNull().default('0'),
    rate5xx: numeric('rate_5xx', { precision: 10, scale: 6 }).notNull().default('0'),
    circuitState: circuitState('circuit_state').notNull().default('closed'),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    credIdx: uniqueIndex('channel_health_credential_idx').on(t.providerCredentialId),
  }),
)

// ──────────────────────────────────────────────────────────────────────
// Audit, background jobs, feature flags, compliance, webhooks
// ──────────────────────────────────────────────────────────────────────

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    actorUserId: text('actor_user_id'),
    organizationId: text('organization_id'),
    tenantId: text('tenant_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    auditOrgIdx: index('audit_org_created_idx').on(t.organizationId, t.createdAt),
    auditTenantIdx: index('audit_tenant_created_idx').on(t.tenantId, t.createdAt),
  }),
)

export const jobStatus = pgEnum('job_status', ['pending', 'running', 'completed', 'failed'])
export const backgroundJobs = pgTable(
  'background_jobs',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    type: text('type').notNull(), // model_sync | price_sync | fx_sync | health_check | reservation_cleanup | reconciliation | price_alert | model_retire_alert
    status: jobStatus('status').notNull().default('pending'),
    lockedBy: text('locked_by'), // instance id
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lastError: text('last_error'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    jobNextRunIdx: index('jobs_next_run_idx').on(t.status, t.nextRunAt),
    jobTypeIdx: index('jobs_type_idx').on(t.type),
  }),
)

export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  description: text('description'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  updatedBy: text('updated_by'),
})

export const complianceFilings = pgTable(
  'compliance_filings',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    upstreamModelId: text('upstream_model_id').notNull(),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    filingName: text('filing_name'),
    filingNumber: text('filing_number'),
    filingRegion: text('filing_region'),
    filingSourceUrl: text('filing_source_url'),
    filingVerifiedAt: timestamp('filing_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    filingModelIdx: uniqueIndex('filings_provider_model_idx').on(t.providerId, t.upstreamModelId),
  }),
)

export const webhookEndpoints = pgTable('webhook_endpoints', {
  id: text('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  tenantId: text('tenant_id').notNull(),
  url: text('url').notNull(),
  secretHash: text('secret_hash').notNull(),
  events: jsonb('events').$type<string[]>().notNull().default([]),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastResponseCode: integer('last_response_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    deliveryPendingIdx: index('webhook_deliveries_pending_idx').on(t.status, t.createdAt),
  }),
)

// ──────────────────────────────────────────────────────────────────────
// New tables per DATA_MODEL.md — added in migration 0001 (expand-only)
// ──────────────────────────────────────────────────────────────────────
// These tables reconcile the schema to the authoritative DATA_MODEL.md
// aggregate list. Existing equivalent tables (organizations, users,
// organization_memberships, providers, provider_credentials, upstream_models,
// model_aliases, provider_price_versions, sale_price_rules, sale_price_snapshots,
// exchange_rate_snapshots, wallet_accounts, wallet_ledger_entries, orders,
// downstream_api_keys, request_records, channel_health, audit_logs,
// background_jobs, feature_flags, compliance_filings, webhook_endpoints,
// webhook_deliveries) are kept; tenant_id columns are added above.

// ── Identity: service_accounts ─────────────────────────────────────────
// DATA_MODEL: tenants/users/memberships/service_accounts.
// service_accounts are non-human principals (workers, integrations) scoped
// to a tenant. RBAC enforcement is Work Item C; we only land the schema.

export const serviceAccountStatus = pgEnum('service_account_status', ['active', 'suspended', 'deleted'])

export const serviceAccounts = pgTable(
  'service_accounts',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').references(() => organizations.id),
    name: text('name').notNull(),
    description: text('description'),
    status: serviceAccountStatus('status').notNull().default('active'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    saTenantIdx: index('service_accounts_tenant_idx').on(t.tenantId, t.status),
  }),
)

// ── Access: key_scopes, rate_limit_policies ───────────────────────────
// DATA_MODEL: api_keys/key_scopes/rate_limit_policies.
// api_keys maps to the existing downstream_api_keys table (hash/fingerprint,
// revocable, expirable). key_scopes and rate_limit_policies are new.

export const keyScopes = pgTable(
  'key_scopes',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    apiKeyId: text('api_key_id')
      .notNull()
      .references(() => downstreamApiKeys.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull(),
    scope: text('scope').notNull(), // e.g. "models:read", "chat:write", "*"
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ksKeyScopeIdx: uniqueIndex('key_scopes_key_scope_idx').on(t.apiKeyId, t.scope),
    ksTenantIdx: index('key_scopes_tenant_idx').on(t.tenantId),
  }),
)

export const rateLimitPolicies = pgTable(
  'rate_limit_policies',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    apiKeyId: text('api_key_id').references(() => downstreamApiKeys.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    requestsPerMinute: integer('requests_per_minute'),
    requestsPerDay: integer('requests_per_day'),
    tokensPerMinute: integer('tokens_per_minute'),
    tokensPerDay: integer('tokens_per_day'),
    concurrencyLimit: integer('concurrency_limit'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    rlpTenantIdx: index('rate_limit_policies_tenant_idx').on(t.tenantId),
    rlpKeyIdx: index('rate_limit_policies_key_idx').on(t.apiKeyId),
  }),
)

// ── Providers: channels (capability+region binding) ──────────────────
// DATA_MODEL: providers/provider_accounts/encrypted_credentials/channels.
// provider_accounts = existing providers table. encrypted_credentials =
// existing provider_credentials table. channels bind a credential to a
// capability/region for routing.

export const channelCapability = pgEnum('channel_capability', [
  'chat',
  'embeddings',
  'images',
  'audio',
  'tools',
  'multimodal',
])

export const channelsNew = pgTable(
  'channels',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id'), // null = platform channel
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    providerCredentialId: text('provider_credential_id').references(() => providerCredentials.id),
    name: text('name').notNull(),
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
    region: text('region').notNull().default('global'),
    weight: integer('weight').notNull().default(10),
    priority: integer('priority').notNull().default(0),
    enabled: boolean('enabled').notNull().default(true),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    chTenantIdx: index('channels_tenant_idx').on(t.tenantId, t.enabled),
    chProviderIdx: index('channels_provider_idx').on(t.providerId, t.enabled),
  }),
)

// ── Catalog: catalog_versions ─────────────────────────────────────────
// DATA_MODEL: models/model_aliases/capabilities/catalog_versions.
// models = existing upstream_models. model_aliases = existing model_aliases.
// catalog_versions is an immutable published snapshot of the full catalog.

export const catalogVersions = pgTable(
  'catalog_versions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id'), // null = platform catalog
    version: integer('version').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    checksum: text('checksum').notNull(), // SHA-256 of payload
    publishedBy: text('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    cvTenantVersionIdx: uniqueIndex('catalog_versions_tenant_version_idx').on(t.tenantId, t.version),
  }),
)

// ── Pricing: price_sources, price_candidates, price_components ─────────
// DATA_MODEL: price_sources/price_candidates/price_versions/price_components.
// price_versions maps to existing provider_price_versions. price_sources,
// price_candidates, price_components are new.

export const priceSourceType = pgEnum('price_source_type', [
  'official_api',
  'official_market',
  'parsed_page',
  'imported_json',
  'imported_csv',
  'manual',
])

export const priceSources = pgTable(
  'price_sources',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    upstreamModelId: text('upstream_model_id').notNull(),
    sourceType: priceSourceType('source_type').notNull(),
    sourceUrl: text('source_url'),
    contentSha256: text('content_sha256'),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).defaultNow().notNull(),
    parserVersion: text('parser_version'),
    region: text('region').notNull().default('global'),
    currency: text('currency').notNull().default('USD'),
    billingConditions: text('billing_conditions'),
    rawEvidenceRef: text('raw_evidence_ref'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    psProviderModelIdx: index('price_sources_provider_model_idx').on(t.providerId, t.upstreamModelId),
  }),
)

export const priceCandidateStatus = pgEnum('price_candidate_status', [
  'fetched',
  'validated',
  'pending_approval',
  'scheduled',
  'active',
  'superseded',
  'rejected',
])

export const priceCandidates = pgTable(
  'price_candidates',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    providerId: text('provider_id')
      .notNull()
      .references(() => providers.id),
    upstreamModelId: text('upstream_model_id').notNull(),
    priceSourceId: text('price_source_id').references(() => priceSources.id),
    currency: text('currency').notNull().default('USD'),
    region: text('region').notNull().default('global'),
    status: priceCandidateStatus('status').notNull().default('fetched'),
    highRiskFlag: boolean('high_risk_flag').notNull().default(false),
    riskReasons: jsonb('risk_reasons').$type<string[]>().notNull().default([]),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pcProviderModelStatusIdx: index('price_candidates_provider_model_status_idx').on(
      t.providerId,
      t.upstreamModelId,
      t.status,
    ),
  }),
)

export const priceComponentKind = pgEnum('price_component_kind', [
  'input',
  'cached_input',
  'output',
  'reasoning',
  'request',
  'image',
  'audio',
  'storage',
])

export const priceComponents = pgTable(
  'price_components',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    priceVersionId: text('price_version_id')
      .notNull()
      .references(() => providerPriceVersions.id, { onDelete: 'cascade' }),
    priceCandidateId: text('price_candidate_id').references(() => priceCandidates.id),
    kind: priceComponentKind('kind').notNull(),
    unit: text('unit').notNull().default('per_million_tokens'),
    amount: numeric('amount', { precision: 18, scale: 8 }).notNull(),
    conditions: jsonb('conditions').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pcompVersionIdx: index('price_components_version_idx').on(t.priceVersionId),
    pcompKindIdx: index('price_components_kind_idx').on(t.kind),
  }),
)

// ── Routing: routing_policies, policy_versions, gateway_snapshots ──────
// DATA_MODEL: routing_policies/policy_versions/gateway_snapshots.
// Published versions are immutable, signed, monotonically sequenced.

export const routingPolicies = pgTable(
  'routing_policies',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id'), // null = platform default
    name: text('name').notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    rpTenantIdx: index('routing_policies_tenant_idx').on(t.tenantId, t.enabled),
  }),
)

export const policyVersions = pgTable(
  'policy_versions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    routingPolicyId: text('routing_policy_id')
      .notNull()
      .references(() => routingPolicies.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id'),
    version: integer('version').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    checksum: text('checksum').notNull(),
    credentialMode: text('credential_mode').notNull().default('byok'), // byok | managed
    modelRoutes: jsonb('model_routes')
      .$type<{ modelId: string; weight: number; priority?: number }[]>()
      .notNull()
      .default([]),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: text('published_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pvPolicyVersionIdx: uniqueIndex('policy_versions_policy_version_idx').on(t.routingPolicyId, t.version),
  }),
)

export const gatewaySnapshots = pgTable(
  'gateway_snapshots',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id'), // null = platform
    policyVersionId: text('policy_version_id').references(() => policyVersions.id),
    sequenceNumber: bigint('sequence_number', { mode: 'bigint' }).notNull(),
    signature: text('signature').notNull(), // Ed25519 / HMAC of the snapshot payload
    signingKeyId: text('signing_key_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).defaultNow().notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    gsTenantSeqIdx: uniqueIndex('gateway_snapshots_tenant_seq_idx').on(t.tenantId, t.sequenceNumber),
  }),
)

// ── Usage: attempts, usage_events, usage_records ──────────────────────
// DATA_MODEL: requests/attempts/usage_events/usage_records.
// requests = existing request_records. attempts/usage_events/usage_records new.
// Event id + provider request id idempotent.

export const attemptStatus = pgEnum('attempt_status', [
  'pending',
  'sent',
  'streaming',
  'completed',
  'failed',
  'retried',
  'unknown',
])

export const attempts = pgTable(
  'attempts',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    requestId: text('request_id')
      .notNull()
      .references(() => requestRecords.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull(),
    providerId: text('provider_id').references(() => providers.id),
    providerCredentialId: text('provider_credential_id').references(() => providerCredentials.id),
    channelNewId: text('channel_id'),
    connectionId: text('connection_id'),
    resolvedModel: text('resolved_model'),
    executionMode: text('execution_mode'),
    priceVersionId: text('price_version_id'),
    catalogVersionId: text('catalog_version_id'),
    policyVersionId: text('policy_version_id'),
    attemptNumber: integer('attempt_number').notNull(),
    status: attemptStatus('status').notNull().default('pending'),
    upstreamRequestId: text('upstream_request_id'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    upstreamCostAmount: bigint('upstream_cost_amount', { mode: 'bigint' }),
    upstreamCostCurrency: text('upstream_cost_currency'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    attReqIdx: index('attempts_request_idx').on(t.requestId),
    attTenantIdx: index('attempts_tenant_idx').on(t.tenantId, t.createdAt),
    attUpstreamReqIdx: index('attempts_upstream_request_idx').on(t.tenantId, t.upstreamRequestId),
  }),
)

export const usageEvents = pgTable(
  'usage_events',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    requestId: text('request_id').references(() => requestRecords.id),
    attemptId: text('attempt_id').references(() => attempts.id),
    eventId: text('event_id').notNull(), // idempotency key: unique per tenant
    eventType: text('event_type').notNull(), // request_completed | token_delta | upstream_error | ...
    providerRequestId: text('provider_request_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ueTenantEventIdx: uniqueIndex('usage_events_tenant_event_idx').on(t.tenantId, t.eventId),
    ueTenantProviderReqIdx: index('usage_events_tenant_provider_req_idx').on(t.tenantId, t.providerRequestId),
    ueRequestLatestIdx: index('usage_events_request_latest_idx').on(
      t.tenantId,
      t.requestId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
  }),
)

export const usageRecords = pgTable(
  'usage_records',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    requestId: text('request_id').references(() => requestRecords.id),
    usageEventId: text('usage_event_id').references(() => usageEvents.id),
    authoritativeMetering: jsonb('authoritative_metering').$type<Record<string, unknown>>(),
    frozenPricing: jsonb('frozen_pricing').$type<Record<string, unknown>>(),
    calculatorVersion: text('calculator_version'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    reasoningTokens: integer('reasoning_tokens').notNull().default(0),
    upstreamCostAmount: bigint('upstream_cost_amount', { mode: 'bigint' }),
    upstreamCostCurrency: text('upstream_cost_currency'),
    chargeAmount: bigint('charge_amount', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    chargeCurrency: text('charge_currency').notNull().default('USD'),
    estimatedAmount: boolean('estimated_amount').notNull().default(false), // true for migrated float amounts
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    urTenantReqIdx: index('usage_records_tenant_request_idx').on(t.tenantId, t.requestId),
    urTenantEventIdx: index('usage_records_tenant_event_idx').on(t.tenantId, t.usageEventId),
  }),
)

// ── Finance: ledger_accounts, ledger_transactions, ledger_postings, payments ──
// DATA_MODEL: accounts/ledger_entries/ledger_postings/invoices/payments.
// ADR-0002: PostgreSQL append-only ledger postings are the SOLE balance truth.
// Balance invariant: per (transaction, currency) sum(amount)=0.
// Postings are immutable (trigger blocks UPDATE/DELETE).
// wallet_accounts remains the user-facing balance aggregate (derived from
// ledger_postings); wallet_ledger_entries remains the legacy single-entry
// view during migration. ledger_accounts is the double-entry account.

export const ledgerAccountType = pgEnum('ledger_account_type', [
  'wallet',
  'revenue',
  'refund',
  'adjustment',
  'promotional',
  'reservation',
  'tax',
  'fee',
  'clearing',
])

export const ledgerAccounts = pgTable(
  'ledger_accounts',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    walletId: text('wallet_id').references(() => walletAccounts.id), // link to user-facing wallet
    type: ledgerAccountType('type').notNull(),
    currency: text('currency').notNull().default('USD'),
    code: text('code').notNull(), // human-readable account code within tenant
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    laTenantCodeIdx: uniqueIndex('ledger_accounts_tenant_code_idx').on(t.tenantId, t.code),
    laTenantWalletIdx: index('ledger_accounts_tenant_wallet_idx').on(t.tenantId, t.walletId),
  }),
)

export const ledgerTransactionType = pgEnum('ledger_transaction_type', [
  'recharge',
  'usage',
  'refund',
  'adjustment',
  'promotional_credit',
  'reservation',
  'reservation_release',
  'correction',
])

export const ledgerTransactions = pgTable(
  'ledger_transactions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    type: ledgerTransactionType('type').notNull(),
    currency: text('currency').notNull().default('USD'),
    idempotencyKey: text('idempotency_key').notNull(),
    referenceType: text('reference_type'), // request | order | adjustment | ...
    referenceId: text('reference_id'),
    description: text('description'),
    createdBy: text('created_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    ltTenantIdemIdx: uniqueIndex('ledger_transactions_tenant_idempotency_idx').on(t.tenantId, t.idempotencyKey),
    ltTenantRefIdx: index('ledger_transactions_tenant_ref_idx').on(t.tenantId, t.referenceType, t.referenceId),
  }),
)

// Append-only double-entry postings. amount is signed: +credit / -debit.
// Balance invariant enforced at DB level: per (transaction_id, currency)
// sum(amount) = 0. A trigger forbids UPDATE/DELETE on this table.
// Corrections use a new reversing/compensating transaction, never edits.
export const ledgerPostings = pgTable(
  'ledger_postings',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    transactionId: text('transaction_id')
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: 'restrict' }),
    tenantId: text('tenant_id').notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: 'restrict' }),
    currency: text('currency').notNull().default('USD'),
    amount: bigint('amount', { mode: 'bigint' }).notNull(), // signed micros: +credit / -debit
    entryType: text('entry_type').notNull(), // debit | credit
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    lpTransactionIdx: index('ledger_postings_transaction_idx').on(t.transactionId),
    lpAccountIdx: index('ledger_postings_account_idx').on(t.accountId, t.createdAt),
    lpTenantAccountIdx: index('ledger_postings_tenant_account_idx').on(t.tenantId, t.accountId),
  }),
)

export const paymentStatus = pgEnum('payment_status', ['pending', 'completed', 'failed', 'refunded'])

export const payments = pgTable(
  'payments',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    orderId: text('order_id').references(() => orders.id),
    paymentProvider: text('payment_provider').notNull().default('mock'),
    externalPaymentId: text('external_payment_id'),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    status: paymentStatus('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => ({
    payTenantIdemIdx: uniqueIndex('payments_tenant_idempotency_idx').on(t.tenantId, t.idempotencyKey),
    payExtIdx: uniqueIndex('payments_external_idx').on(t.paymentProvider, t.externalPaymentId),
  }),
)

// ── Governance: budgets, alerts, retention_policies, audit_events ─────
// DATA_MODEL: budgets/alerts/audit_events/retention_policies.
// budgets composable per project/key/member/model.

export const budgets = pgTable(
  'budgets',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    name: text('name').notNull(),
    scopeType: text('scope_type').notNull(), // project | key | member | model | global
    scopeId: text('scope_id'), // the scoped entity id (or null for global)
    amountLimit: bigint('amount_limit', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull().default('USD'),
    period: text('period').notNull().default('monthly'), // daily | weekly | monthly | quarterly | yearly
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    budTenantScopeIdx: index('budgets_tenant_scope_idx').on(t.tenantId, t.scopeType, t.scopeId),
  }),
)

export const alertSeverity = pgEnum('alert_severity', ['info', 'warning', 'critical'])

export const alerts = pgTable(
  'alerts',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    budgetId: text('budget_id').references(() => budgets.id, { onDelete: 'cascade' }),
    severity: alertSeverity('severity').notNull().default('warning'),
    message: text('message').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    acknowledged: boolean('acknowledged').notNull().default(false),
    acknowledgedBy: text('acknowledged_by'),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    alertTenantIdx: index('alerts_tenant_created_idx').on(t.tenantId, t.createdAt),
  }),
)

export const retentionPolicies = pgTable(
  'retention_policies',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id'), // null = platform default
    targetType: text('target_type').notNull(), // request_logs | audit_logs | usage_records | ...
    retentionDays: integer('retention_days').notNull(),
    hardDeleteAfterDays: integer('hard_delete_after_days'),
    legalHold: boolean('legal_hold').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    retTenantTargetIdx: uniqueIndex('retention_policies_tenant_target_idx').on(t.tenantId, t.targetType),
  }),
)

export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id'),
    actorUserId: text('actor_user_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    aeTenantIdx: index('audit_events_tenant_created_idx').on(t.tenantId, t.createdAt),
    aeActorIdx: index('audit_events_actor_idx').on(t.actorUserId),
  }),
)

// ── Operations: sync_runs, reconciliation_cases, outbox_events, incidents ──
// DATA_MODEL: sync_runs/reconciliation_cases/outbox_events/incidents.
// Outbox committed in same tx as business (ADR-0005).

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id'), // null = platform sync
    jobType: text('job_type').notNull(), // model_sync | price_sync | fx_sync | ...
    providerId: text('provider_id').references(() => providers.id),
    status: text('status').notNull().default('pending'), // pending | running | completed | failed
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    resultSummary: jsonb('result_summary').$type<Record<string, unknown>>().notNull().default({}),
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    srTenantStatusIdx: index('sync_runs_tenant_status_idx').on(t.tenantId, t.status),
    srJobTypeIdx: index('sync_runs_job_type_idx').on(t.jobType),
  }),
)

export const reconciliationStatus = pgEnum('reconciliation_status', ['open', 'investigating', 'resolved', 'unresolved'])

export const reconciliationCases = pgTable(
  'reconciliation_cases',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id'),
    requestId: text('request_id').references(() => requestRecords.id),
    usageEventId: text('usage_event_id').references(() => usageEvents.id),
    status: reconciliationStatus('status').notNull().default('open'),
    reason: text('reason').notNull(), // unknown_completion | amount_mismatch | missing_event | ...
    expectedAmount: bigint('expected_amount', { mode: 'bigint' }),
    actualAmount: bigint('actual_amount', { mode: 'bigint' }),
    currency: text('currency'),
    resolution: text('resolution'),
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    rcTenantStatusIdx: index('reconciliation_cases_tenant_status_idx').on(t.tenantId, t.status),
  }),
)

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    aggregateType: text('aggregate_type').notNull(), // request | usage | payment | ...
    aggregateId: text('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status').notNull().default('pending'), // pending | published | failed
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    // Work Item F — worker retry bookkeeping (expand-only, nullable).
    // next_attempt_at: NULL means "eligible now". claimed_by/claimed_at are
    // observability only; the authoritative claim is the row lock.
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    oeTenantIdemIdx: uniqueIndex('outbox_events_tenant_idempotency_idx').on(t.tenantId, t.idempotencyKey),
    oeStatusIdx: index('outbox_events_status_idx').on(t.status, t.createdAt),
    oeClaimIdx: index('outbox_events_claim_idx').on(t.status, t.nextAttemptAt),
  }),
)

export const incidentSeverity = pgEnum('incident_severity', ['info', 'warning', 'major', 'critical'])

export const incidents = pgTable(
  'incidents',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id'),
    providerId: text('provider_id').references(() => providers.id),
    severity: incidentSeverity('severity').notNull().default('warning'),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('open'), // open | monitoring | resolved
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    incTenantStatusIdx: index('incidents_tenant_status_idx').on(t.tenantId, t.status),
  }),
)

// ── Commercial: plans, entitlements, subscriptions, tenant compliance ──
// DATA_MODEL: plans/plan_versions/entitlements/subscriptions.
// PRODUCT_COMMERCIAL.md is binding: plan limits are published through
// plan_versions + entitlements and are NEVER hardcoded in the UI. A historical
// subscription binds a plan VERSION, and upgrades/downgrades take effect at an
// explicit effective time.
//
// managed credits (ADR-0004): a controlled capability, enabled per tenant only
// after the supplier contract, payment/tax and region requirements are all
// approved. The `managed_credits` feature flag gates it and defaults OFF.

export const planStatus = pgEnum('plan_status', ['draft', 'active', 'retired'])

export const plans = pgTable(
  'plans',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    code: text('code').notNull(), // free | team | enterprise | ...
    name: text('name').notNull(),
    description: text('description'),
    tier: text('tier').notNull().default('team'), // free | team | enterprise
    status: planStatus('status').notNull().default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    planCodeIdx: uniqueIndex('plans_code_idx').on(t.code),
  }),
)

export const planVersionStatus = pgEnum('plan_version_status', ['draft', 'published', 'retired'])

// A published plan version is IMMUTABLE: new prices/limits are a new version.
// Historical subscriptions reference the version they bought, so a bill can
// always be reproduced (INVARIANT #4, PRODUCT_COMMERCIAL.md).
export const planVersions = pgTable(
  'plan_versions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id),
    version: integer('version').notNull(),
    status: planVersionStatus('status').notNull().default('draft'),
    currency: text('currency').notNull().default('USD'),
    // Subscription fee per billing interval, integer micros (INVARIANT #6).
    priceMicros: bigint('price_micros', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    billingInterval: text('billing_interval').notNull().default('month'), // month | year
    // Managed-credit package granted by this version, integer micros. Also the
    // server-side source of the amount for a managed_credits order.
    includedCreditsMicros: bigint('included_credits_micros', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    trialDays: integer('trial_days').notNull().default(0),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishedBy: text('published_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pvPlanVersionIdx: uniqueIndex('plan_versions_plan_version_idx').on(t.planId, t.version),
    pvStatusIdx: index('plan_versions_status_idx').on(t.status),
  }),
)

export const entitlementKind = pgEnum('entitlement_kind', ['boolean', 'limit'])

// What a plan version grants. Read through the active subscription; a UI must
// query these rather than hardcode limits.
export const entitlements = pgTable(
  'entitlements',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    planVersionId: text('plan_version_id')
      .notNull()
      .references(() => planVersions.id, { onDelete: 'cascade' }),
    key: text('key').notNull(), // api_keys | members | byok_channels | audit_retention_days | routing_advanced | managed_credits | ...
    kind: entitlementKind('kind').notNull().default('limit'),
    limitValue: bigint('limit_value', { mode: 'bigint' }), // kind = limit
    booleanValue: boolean('boolean_value'), // kind = boolean
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    entVersionKeyIdx: uniqueIndex('entitlements_version_key_idx').on(t.planVersionId, t.key),
  }),
)

export const subscriptionStatus = pgEnum('subscription_status', [
  'trialing',
  'active',
  'past_due',
  'canceled',
  'expired',
])

// tenant → plan version over an explicit effective range. Upgrade/downgrade
// schedules a new row whose effectiveFrom closes the previous row, so an
// entitlement lookup "as of T" is deterministic.
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').references(() => organizations.id),
    planVersionId: text('plan_version_id')
      .notNull()
      .references(() => planVersions.id),
    status: subscriptionStatus('status').notNull().default('active'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }).defaultNow().notNull(),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    subTenantEffectiveIdx: index('subscriptions_tenant_effective_idx').on(t.tenantId, t.effectiveFrom),
    subTenantStatusIdx: index('subscriptions_tenant_status_idx').on(t.tenantId, t.status),
  }),
)

export const complianceApproval = pgEnum('compliance_approval', ['pending', 'approved', 'rejected'])

// Per-tenant managed-credit compliance gate. Managed credits may only be sold
// once contract, payment, tax and region are ALL `approved` (ADR-0004).
export const tenantCompliance = pgTable(
  'tenant_compliance',
  {
    id: text('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').references(() => organizations.id),
    contractStatus: complianceApproval('contract_status').notNull().default('pending'),
    paymentStatus: complianceApproval('payment_status').notNull().default('pending'),
    taxStatus: complianceApproval('tax_status').notNull().default('pending'),
    regionStatus: complianceApproval('region_status').notNull().default('pending'),
    region: text('region'),
    contractReference: text('contract_reference'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tcTenantIdx: uniqueIndex('tenant_compliance_tenant_idx').on(t.tenantId),
  }),
)

// ──────────────────────────────────────────────────────────────────────
// Legacy tables (preserved during migration, not dropped)
// ──────────────────────────────────────────────────────────────────────
// relay_channels / relay_keys / relay_logs / relay_settings remain for the
// data-migration step (Phase 5). They are NOT used by the new billing path.
// The old gateway/admin/server still reference them during the transition.

export const channels = pgTable('relay_channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  provider: text('provider').notNull(),
  baseUrl: text('base_url').notNull(),
  secret: text('secret'),
  models: jsonb('models').$type<string[]>().notNull(),
  weight: integer('weight').notNull().default(10),
  enabled: boolean('enabled').notNull().default(true),
  latency: integer('latency').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
export const apiKeys = pgTable('relay_keys', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  hash: text('hash').notNull().unique(),
  prefix: text('prefix').notNull(),
  budget: doublePrecision('budget').notNull().default(100),
  spent: doublePrecision('spent').notNull().default(0),
  reserved: doublePrecision('reserved').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
export const requestLogs = pgTable('relay_logs', {
  id: text('id').primaryKey(),
  model: text('model').notNull(),
  channel: text('channel').notNull(),
  keyName: text('key_name').notNull(),
  status: integer('status').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cost: doublePrecision('cost').notNull().default(0),
  latency: integer('latency').notNull().default(0),
  demo: boolean('demo').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
})
export const settings = pgTable('relay_settings', {
  id: text('id').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
})

// Explicit legacy import provenance; archived usage is never billable usage.
export const legacyMigrationRuns = pgTable('legacy_migration_runs', {
  namespace: text('namespace').primaryKey(),
  sourceDigest: text('source_digest').notNull(),
  manifestDigest: text('manifest_digest').notNull(),
  report: jsonb('report').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const legacyMigrationMappings = pgTable(
  'legacy_migration_mappings',
  {
    id: text('id').primaryKey(),
    namespace: text('namespace')
      .notNull()
      .references(() => legacyMigrationRuns.namespace),
    sourceTable: text('source_table').notNull(),
    sourceId: text('source_id').notNull(),
    tenantId: text('tenant_id').notNull(),
    sourceDigest: text('source_digest').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id'),
  },
  (t) => ({
    sourceTargetIdx: uniqueIndex('legacy_mapping_source_target_idx').on(
      t.namespace,
      t.sourceTable,
      t.sourceId,
      t.targetKind,
    ),
  }),
)

export const legacyUsageArchive = pgTable('legacy_usage_archive', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull(),
  organizationId: text('organization_id')
    .notNull()
    .references(() => organizations.id),
  sourceDigest: text('source_digest').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  cachedTokens: integer('cached_tokens'),
  reasoningTokens: integer('reasoning_tokens'),
  projectId: text('project_id'),
  downstreamKeyId: text('downstream_key_id'),
  priceVersionId: text('price_version_id'),
  costAmount: bigint('cost_amount', { mode: 'bigint' }).notNull(),
  currency: text('currency').notNull(),
  estimatedAmount: boolean('estimated_amount').notNull().default(true),
  status: integer('status').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

// Append-only request-time attribution; IDs are historical, not live entity joins.
export const requestProjectFacts = pgTable(
  'request_project_facts',
  {
    requestId: text('request_id')
      .primaryKey()
      .references(() => requestRecords.id),
    tenantId: text('tenant_id').notNull(),
    organizationId: text('organization_id').notNull(),
    projectId: text('project_id'),
    projectName: text('project_name'),
    apiKeyId: text('api_key_id'),
    connectionId: text('connection_id'),
    principalId: text('principal_id'),
    catalogVersionId: text('catalog_version_id'),
    policyVersionId: text('policy_version_id'),
    credentialId: text('credential_id'),
    channelId: text('channel_id'),
    providerId: text('provider_id'),
    requestedModel: text('requested_model'),
    resolvedModel: text('resolved_model'),
    modelId: text('model_id'),
    priceVersionId: text('price_version_id'),
    keyKind: text('key_kind'),
    evidenceSource: text('evidence_source'),
    evidenceDigest: text('evidence_digest'),
    executionMode: text('execution_mode').notNull(),
    attributionStatus: text('attribution_status').notNull(),
    streaming: boolean('streaming'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tenantProjectCreatedIdx: index('request_project_facts_tenant_project_created_idx').on(
      t.tenantId,
      t.projectId,
      t.createdAt,
    ),
  }),
)
