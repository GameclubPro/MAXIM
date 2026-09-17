# Publisher Comments Diagnostics

When a published comment button fails, first correlate the bounded HTTP access
logs with the exact chat and status, without exporting tokens or init data.

Use the fixed read-only catalog for readiness metadata:

```sh
./infra/scripts/vps-connect.sh postgres-audit publisher-comments "$COMMENT_CHAT_ID" --explain
./infra/scripts/vps-connect.sh postgres-audit publisher-comments "$COMMENT_CHAT_ID"
```

Set `COMMENT_CHAT_ID` to the exact negative numeric chat ID from the failed request.
After synchronizing new catalog tooling, preview and apply the reviewed audit-role
provisioner to grant the fourteen allowlisted Publisher metadata columns. The
report uses three primary-key lookups with the standard audit role, timeouts,
read-only transaction, single-session lock, and backend cleanup. It does not read
comment text, author identities, bot tokens, or raw permission snapshots.

Distinguish creating new comment buttons from accessing an already published
thread. A disabled creation switch is not evidence that the link is malformed or
that its existing comments were deleted. Do not repair a read failure by enabling
publication settings, changing bot access, or republishing the original message.
