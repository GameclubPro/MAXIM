# Interrupted multibot index preparation

Use `./infra/scripts/vps-connect.sh recover-multibot-index-migration` for a
preview of `20261005016100_index_multibot_retention_cursor` only. Synchronize
reviewed tooling with the normal `deploy main --plan` first. The connector
requires green Required and CodeQL checks for the exact source SHA, and the
remote helper requires the same clean source under the shared deploy lock.

The fixed preview reads catalog metadata and bounded Prisma receipts, never
webhook rows. Its output contains fixed index names, presence/readiness flags,
table bytes, checksum-match booleans and an allowlisted failure family. Receipt
identities, original errors, predicates, content and user identifiers stay out
of the report. A rejected preview is evidence to review, not permission to
change a receipt.

The helper requires the exact successful nullable-column and semantic-order
migrations, their unchanged column/index definitions, and one checksum-matching
target receipt. Only a zero-step Prisma/server lock-timeout or statement-timeout
block is recoverable. A bare SQLSTATE, user cancellation, conflicting error
blocks, another failed migration, a table larger than 128 GiB, metadata larger
than 8 MiB, repair artifacts or another owned online session aborts recovery.

After reviewing an accepted preview, use the same command with `--apply`.
Ingress and admin must have raw-ready queues and normal system mode before
each operation and before resolution. Missing indexes are created concurrently;
an exact invalid index is reindexed concurrently. The helper never drops an
index, uses `IF NOT EXISTS`, changes message data or alters the immutable SQL.

At most two repairs run, sequentially. Each statement retains the original
five-second lock and 1,800-second statement deadlines, disables parallel
maintenance workers and caps maintenance memory at 64 MiB and temporary files
at 10 GiB. Before each repair, the existing capacity probe checks its actual
data/temp/WAL/Docker devices. Non-overlapping samples every two seconds must
retain at least 10 GiB on each device; a missing sample, changed device, signal,
deadline or reserve breach cancels only that attempt. This sampled reserve is
not a worst-case disk guarantee. The wrapper bounds the whole attempt at
3,900 seconds and permits a separate bounded cleanup window.

Cleanup stops and reaps the owned launcher before checking absence of its exact
UUID-tagged database sessions and one-off container. A shell-only disconnect
cannot leave a launcher free to start another operation after cleanup. An
unconfirmed cleanup is a distinct failure and requires fresh inspection before
retry. No production role, stateful service, queue fence or release manifest is
changed by this helper.

Only after both exact indexes are valid, ready and live, and the same receipt
and prerequisites are rechecked, may a retained protected API image mark this
one migration applied. Its migration source is mounted read-only; the resolver
tags `DATABASE_URL` in memory so Prisma sessions are owned without putting
credentials in arguments or output. An unknown resolver result is not retried
inside the attempt: take a fresh preview to determine the actual receipt state.

After successful recovery, resume the normal guarded deployment with explicit
adoption of the single valid interrupted release journal. Recovery does not
activate the new multibot runtime or authorize replay of old moderation work.
