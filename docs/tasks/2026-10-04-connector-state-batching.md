# Batch existing connector state projections

## Existing query graph and source

[DataLoader v2.2.3's batching design](https://github.com/graphql/dataloader/blob/v2.2.3/README.md#batching) collects related keys into one backend read and maps the values back to the requested order. Its request scope guidance prevents users from sharing authorization-dependent results. NexusAPI can implement this directly in its existing SQL/helper without adding a dependency or a lasting cache.

`GET /api/connections` submits one state query per local connection through Promise.all. `GET /api/resources` waits serially for one state query per local resource, including multiple Channel scopes for one connection. The state SQL itself contains one correlated approved-model aggregation; it is one query, not three. With 32 visible local connections and one Channel each, the source predicts 35 and 37 total queries respectively, including two context queries. These are query counts, not measured latency claims.

## Minimum implementation under native characterization

Add `connectorStates(ctx, requests)` with ordered `(connectionId, optional channelId)` inputs and states in the same order. Use sequential chunks of 32 and a requested-input SQL relation with ordinal positions. Reuse the existing visibility, enabled Provider/credential/Channel checks and shared Chat capability predicate. Preserve each Channel's approved-model scope and the connection-level approval union. Reuse one state projector; retain the scalar connectorState interface, missing-object 404, expiry/revocation/35-second transport freshness and unknown states. No authorization grant, resource identity, inference, pricing or persistent cache is added.

Both list routes use the batch results while keeping their existing JSON order, resource IDs and status/health rules. Empty local lists need no state query. Missing/hidden requested objects still fail the response before exposing a partial result. SQL rows map to the input ordinal rather than relying on database order; duplicate inputs remain separate requested results. Live permissions and expiry are observed for each batch, and results are not retained across requests.

An explicit empty or unknown Channel scope stays inside the approved-model subquery: it returns the visible connector's transport state with no approved ready models, rather than widening to the connection-level union. The expiry clock is sampled after each database read. Schema uniqueness gives at most one current lease per connection; input ordinality still distinguishes multiple resources linked to that connection.

## Proof and ownership

Use only the explicit query/fragment-free loopback `55439` fixture `connector_test_projection_batch_round60`, with current_database proof before reset, all 28 canonical migrations, real sessions and native GET handlers. The only additional permitted target is the already-verified serial CI fixture convergence_ci15 on the same loopback port. Query counters must delegate to real pool.query and retain no SQL/parameters. Compare frozen facts in memory and print only safe counts/booleans.

First measure actual OLD 32-object query counts and compare all states to real single-object GET responses. Controls include two Channel approval scopes on one connection, chunk boundaries, no local objects, hidden/foreign objects, expired/offline/revoked and disabled/unapproved model states. GREEN must reduce counted round trips while preserving projections and facts. No model execution or financial settlement is claimed by these view tests. The agent owns only its new integration test and ignored fixture; root owns production, docs, verification and Git.

## Actual results and reproduction

The stable count-only OLD run has exactly three expected query-count failures and three passing controls (Vitest 7.58s, runner 7.97s). The counter increments one integer and calls the original pool.query with its original receiver; it retains no SQL or parameter history. All scalar GET comparisons, ordering, resource identity, Channel scope and complete fact comparisons pass before the query-count assertions.

| Visible local connections | Connections OLD → GREEN | Resources OLD → GREEN |
|---|---:|---:|
| 32 | 35 → 4 | 37 → 6 |
| 65 | 68 → 6 | 70 → 8 |

The unchanged native integration test passes all six groups after implementation (8.64s; runner 9.00s). Empty/non-local catalogs issue no state query. Two Channels on one connection retain separate approval scopes; a reported online connector with no installed approved model remains pending. Hidden/private/foreign objects and ten state/readiness controls retain their existing responses. Domain, session, audit, request, usage and accounting rows are unchanged. All owned processes, pools and inspection clients close; activeOtherSessions is zero. These results establish reduced round trips and equivalent facts, not a production latency benchmark.

Run against a pre-created disposable database with an explicitly supplied DATABASE_URL matching the guard:

```sh
npx vitest run tests/integration/connector-state-batch.test.ts --no-file-parallelism
npx tsc --noEmit --incremental false
```

The test proves current_database before reset and runs all 28 canonical migrations. No application environment file is needed. The ignored fixture runner derives only the known Docker test-container credentials and preserves separate OLD/GREEN logs; no fixture credential or SQL/parameter dump enters the repository.

Related TypeScript unit/contracts pass 146 checks in 3.24s, including unordered rows, duplicate scopes, missing positions, an empty Channel scope, post-read expiry and empty requests. Fresh TypeScript compilation, scoped ESLint and formatting pass. The actual separate-process private-TLS connector regression passes all nineteen scenarios in 29.24s, including model discovery, non-streaming/streaming calls and attribution. Its clients/processes close. No Go code or migration changes this round; Round59's full native/race/vet and scoped minimum-version evidence remains applicable. The single-Gateway transport deployment limit remains.

Independent read-only review of the exact eight commit paths is clear. Secret scanning and diff checks pass. The ignored current-task handoff is updated locally; future pairing work is excluded from this commit. All verification clients/processes have closed. Integration follows explicit-path commits and the repository's automatic separate-main-worktree merge/push hook.
