# Exact webhook source envelope diagnostics

Use this opt-in read-only catalog after a source admission refuses a known owner
with `source_forward_shape`. It inspects one exact receipt, without searching for
a more convenient source or changing its execution authority.

```bash
./infra/scripts/vps-connect.sh postgres-audit webhook-source-envelope "$OWNER_RECEIPT_ID" --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-source-envelope "$OWNER_RECEIPT_ID"
```

`OWNER_RECEIPT_ID` must be a previously nominated opaque receipt identifier: one
ASCII alphanumeric character followed by up to 127 alphanumeric, `_` or `-`
characters. UUIDs are supported. Review the plain JSON plan first. Synchronize
reviewed exact-green tooling before production use; no new database grants are
required. Run catalogs sequentially under the existing shared audit lock.

The report attests the complete primary-key index and reads at most one
`webhook_events` row. Before materializing JSON, it checks the original column's
storage size and compression metadata. Only an uncompressed value of at most
262,144 bytes is inspected. Missing receipts, SQL NULL, compressed or oversized
values remain explicit; no JSON extraction or unpacking is used to decide that
admission. A compressed small stored size does not bound decoded work.

Output contains fixed kinds, known type labels and structure booleans for the
normalized event, original message, direct body, flat linked body, linked sender
and linked chat identity. Absent and explicit null metadata remain distinct.
Only ten attachments and 32 formatting entries per body may be expanded; an
over-cap collection is reported uninspected. Unknown keys/attachment/formatting
types are boolean or `other`, never their original names or values. Text, URLs,
tokens, actor/chat/message identifiers and raw errors are not returned. The
structured report omits the requested receipt ID; its plain EXPLAIN may include
that exact caller-supplied opaque ID in the primary-key index condition.

The shape checks separate the deciding forward guard families: object kinds,
allowed keys, outer/linked identity and sequence fields, text and bot-field types,
linked sender presence, sender metadata, attachment and markup structures. They
are diagnostics, not the runtime source validator. Parser text equivalence,
command detection, full media/URL validation, formatting bounds against original
UTF-16 text and complete descendant/effect coverage are not evaluated. An
apparently supported shape grants no no-effects, replay or settlement proof.

The existing audit-role privileges, READ ONLY session, pinned schema resolution,
2.5-second statement limit, 250-millisecond lock limit, eight-second wall ceiling,
memory/temp limits, private error handling and exact-backend cleanup remain in
force. The mode is excluded from `all`; it accepts no SQL, file, repair option,
payload or arbitrary range. Its SELECT does not lock the receipt for update.

For an irreversible discard, continue with the complete current
[exact-source abandonment](webhook-source-abandonment.md) admission and cold
protocol. Do not rewrite a source to pass validation, change the predecessor's
status, or infer an outer source identity from forwarded content.

Focused validation with PostgreSQL 16:

```bash
node scripts/agent/with-test-stores.mjs -- node --test --test-concurrency=1 infra/scripts/webhook-source-envelope-audit.test.mjs infra/scripts/vps-postgres-audit.test.mjs
```

Fixtures cover retained history, exact indexed work, locked rows, malformed and
nullable shapes, over-cap collections, compressed/oversized payloads, index drift,
limited column grants, privacy, wrapper argument rejection and private SQL errors.
Timed execution plans are local-only; production supports plain EXPLAIN.
