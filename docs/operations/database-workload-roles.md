# Database workload roles

The database role configuration separates runtime PostgreSQL identities from the migration/owner identity. Apply `infra/db-workload-roles.sql` through the provisioning script after installing the canonical schema. Provisioning is an explicit operator step, never an application startup migration. Existing migration checksums remain unchanged.

| Identity | Financial permissions | Other runtime permissions |
|---|---|---|
| `nexus_control` | Read ledger; append recharge, refund, adjustment, promotional credit, correction and explicit reservation release | Control Plane configuration/authentication tables |
| `nexus_gateway` | No ledger access | Read/insert/update requests, attempts and outbox |
| `nexus_budget` | Read ledger; append reservation only | Authorization/pricing reads, reserved request insert, ledger account creation and wallet binding required by the existing account helper |
| `nexus_worker` | Read ledger; append usage and reservation release | Pricing reads, outbox processing, request/usage/reconciliation records and append-only audit events |
| `nexus_owner` | Operator/migration ownership | Never used as a runtime workload credential |

Both financial tables use FORCE ROW LEVEL SECURITY. Transaction INSERT policies restrict transaction types. Posting INSERT policies verify the referenced transaction's tenant, currency and permitted type, so another workload cannot append postings to a Worker's usage transaction. Runtime roles receive no UPDATE or DELETE on either ledger table. Existing posting immutability and balance triggers remain active.

Provisioning rejects workload identities that own public objects/database, possess administrative attributes or role memberships. It also rejects unexpected existing financial RLS policies, since permissive policies could widen access. Review those conditions explicitly before retrying; do not give a runtime workload owner privileges to bypass them. Newly created roles start NOLOGIN. The script grants LOGIN only after setting the four passwords in the same transaction. Repeating the script reapplies grants/policies and rotates passwords atomically.

Set these environment variables through the operator's secret injection mechanism:

- `DATABASE_ADMIN_URL`: privileged provisioning connection; do not give it to an application.
- `DB_CONTROL_PASSWORD`, `DB_GATEWAY_PASSWORD`, `DB_WORKER_PASSWORD`, `DB_BUDGET_PASSWORD`: four distinct passwords, each at least 24 characters.

Run from the repository root:

```sh
node scripts/provision-workload-roles.mjs
```

Passwords are bound as SQL parameters to a temporary invoker function. That function uses PostgreSQL `format('%I', role)` and `format('%L', password)` semantics when executing ALTER ROLE. The script prints only success or a generic failure, never passwords, connection URLs, or SQL parameters. Operators must configure their database audit/logging product to redact password-setting statements and bound secrets; application silence does not establish server-side log redaction.

Install schema with the owner identity, provision roles, then deploy Worker and budget using their separate database users. Validate actual password login and denial tests before switching Gateway/Control Plane identities. Drain old runtime connections holding owner credentials; provisioning cannot revoke privileges of an already-running owner connection. Rotate and revoke superseded credentials after rollout. Rollback uses compatible application versions with these restricted identities; do not restore owner database URLs or a Control Plane final-usage writer.

These policies enforce workload responsibilities, **not tenant isolation**. Application tenant/org/key checks still apply. They also do not complete production KMS/secret-plane isolation. Production ownership, private network exposure, secret injection and server logging require deployment verification.

Verification:

```sh
# DATABASE_URL must identify a disposable test database: this suite resets public.
npx vitest run tests/integration/database-workload-roles.test.ts
```

The suite applies migrations, reapplies role provisioning, checks unauthorized final-usage/posting writes, permits balanced Worker usage and Control Plane funding, and executes the budget authorizer under its database role. Run it against a disposable database and retain the results for the revision being deployed.

The review also covers inherited permissions: provisioning removes PUBLIC table and column ACLs and public-schema function execution grants. It revokes default PUBLIC execution for functions created by the provisioning identity and `nexus_owner`, and refuses callable SECURITY DEFINER paths in other application schemas. Operators adding another migration identity must configure equivalent default privileges; future grants or privileged functions can reintroduce access and require revalidation.

Control Plane receives read-only access to final usage projections (`usage_records`, `usage_events`). Ledger account identity (tenant, wallet binding, type, currency, code and id) is immutable after creation. Existing account-helper upserts may write the same wallet binding, but cannot rebind historical postings to another wallet. A wallet account must reference a wallet of the same tenant and currency; non-wallet accounting accounts cannot carry wallet bindings. Repairing historical null or wrong bindings requires an explicit owner migration and financial reconciliation, not a runtime permission expansion. Budget reservation postings additionally enforce wallet debit / reservation credit directions, preventing a reservation-labelled transaction from crediting a wallet.

The follow-up review ran eleven real PostgreSQL tests in `convergence_roles11_review`, preserving the runtime fixture `convergence_roles11`. Tests reproduced inherited PUBLIC writes and mutable accounting/usage paths before hardening, then verified denial together with legitimate budget authorization and Control Plane funding. Workload roles can still act across tenants within their assigned accounting operation types; application authorization and restricted network access remain mandatory.

The final Worker permission check runs the actual side-effect-free `runWorkerTick` from `services/worker/tick.ts` under `nexus_worker`, with a nonempty valid event and invalid event. It verifies settlement, dead-letter audit, reconciliation and replay, including exactly one usage and one release transaction. Worker receives only SELECT/INSERT on `audit_events` (INSERT RETURNING requires SELECT), never audit UPDATE/DELETE. This test reproduced the missing audit grant as a failed settlement before the correction; the role suite now passes twelve tests.
