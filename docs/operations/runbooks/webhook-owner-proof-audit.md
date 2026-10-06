# Webhook owner proof diagnostics

Use this fixed read-only catalog when the oldest received webhook is blocked by an
earlier ordered event and the queue report cannot establish its execution state:

```bash
./infra/scripts/vps-connect.sh postgres-audit webhook-owner-proof --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-owner-proof
```

Synchronize the reviewed tooling and review the audit-role provision preview before
the separate maintenance apply. This mode needs 25 additional column SELECT grants;
it never provisions itself. Run catalogs sequentially under their shared audit lock.
Keep the exact runtime release identity and UTC observation window with the report.
The diagnostic is excluded from `all` and accepts no identifiers, SQL or input files.

## Selection and limits

The report selects the oldest `RECEIVED` row using `(status, created_at, id)`, then
exactly its first earlier ordered predecessor through the ordered-chat partial index.
It classifies that row even if its authority is missing or invalid; it never skips to
a later recoverable event. Source metadata without a supported ordered chat returns
`source_unknown`.

The semantic execution claim uses unique `(kind, semantic_key)`. A second lookup by
`(webhook_event_id, kind)` stops at two rows and detects conflicting links. If the
semantic claim is missing, exactly one linked claim can be inspected diagnostically.
The chosen claim and its canonical owner use primary keys. A different canonical
owner stays explicit; no recursive owner or mirror traversal occurs.

An optional exact `(chat_id, action_type='DELETE_MESSAGE', message_id)` ledger probe
reads at most 17 rows. Sixteen is the sample cap and the seventeenth is a saturation
sentinel. Its count is a lower bound; positive observations may include the sentinel.
These observations belong to the predecessor's message, not necessarily its exact
execution or edit version. A missing normalized message key makes the effect source
unavailable. Sends and sanctions are not searched without exact saved action keys.

Both execution and plain `EXPLAIN (FORMAT JSON)` first attest all seven complete index
definitions and effective privileges. Missing, invalid or changed indexes fail closed.
The existing single-session READ ONLY envelope, 2.5-second statement timeout,
250-millisecond lock timeout, eight-second wall ceiling, memory/temp limits and exact
backend cleanup remain in effect. `EXPLAIN ANALYZE` is not supported. Plans must show
index conditions for every application relation; a `LIMIT` alone does not bound work.

## What the result proves

The report exposes finite classifications and boolean checkpoint comparisons, never
source messages, identifiers, semantic keys, lease/dispatch tokens or raw errors.
Database failures return a fixed unavailable message and do not report a healthy result.

`finished_checkpoint_candidate_requires_runtime_validation` means only that the
stored fields match. `semantic_source_rebuild` and `finished_timestamp_validation`
remain `not_evaluated`. In particular, edit identity includes a trusted timestamp and
content digest that this SQL diagnostic does not reconstruct. `settlement_authorized`
is always false and `effect_completeness` is always unknown.

Only the runtime's exact finished-handler validator and fresh transactional receipt/
claim comparisons can authorize SQL-only settlement. A completed claim requiring
receipt reconciliation is distinct from a READY claim with a finished checkpoint.
Individual successful actions do not prove completion of the whole handler. Missing
claims, old age, missing business-start timestamps, absent ledger rows and absent remote
receipts never prove that historical effects did not occur. Preserve quarantine and
send idempotency when evidence remains unknown.

## Exact additional grants

| Table                      | Column SELECT grants                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook_execution_claims` | `id`, `kind`, `semantic_key`, `webhook_event_id`, `execution_bot_id`, `enforced`, `status`, `prepared_at`, `business_started_at`, `completed_at`, `lease_token`, `lease_expires_at`, `command_result` |
| `max_action_ledger`        | `chat_id`, `action_type`, `message_id`, `status`, `ambiguous`, `terminal`, `attempt_count`, `dispatch_token`, `dispatch_started_at`, `dispatch_bot_id`, `remote_message_id`, `completed_at`           |

Keys, tokens and the command journal are compared inside PostgreSQL and never included
in output. Provisioning grants both complete groups or neither on an older schema.
Generic catalogs allow zero or all 25 effective grants. This mode requires all 25;
partial grants, table SELECT, unexpected inherited/PUBLIC access and mutation grants
are rejected. Existing Antiduplicate grants remain a separate unchanged contract.

Local validation including native PostgreSQL plans:

```bash
node scripts/agent/with-test-stores.mjs -- node --test infra/scripts/webhook-owner-proof-audit.test.mjs infra/scripts/vps-postgres-audit.test.mjs
```
