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

## Chat Delivery Modes

Chat comments default to a button sent as a reply, preserving the administrator's
message. Explicit `commentsReplaceOriginalEnabled` opts new administrator messages
into a bot-authored copy. Publik's own posts keep their existing inline buttons.
Older settings clients omit the mode and must not reset a stored choice.

Publisher replacement markers use `publisher_replace_with_bot_message`; their
confirmed bot-message receipt is stored in `reply_message_id`, with a source-content
hash in `publisher_source_content_hash`. The existing Publisher recovery queue
resumes receipt-backed cleanup without sending another copy. This marker-backed
post-action is executed only by `api-publisher`; it is not a legacy moderation
replacement and must not enter cross-bot cleanup or require sharing the Publisher
token with another role.

The original is retained after an ambiguous send, an unpersisted receipt/audit,
changed source content or settings, lost author access, an unconfirmed replacement,
or expiry of the 24-hour cleanup window. Delete success requires documented success
or exact-message absence, never a bare HTTP 404. Do not manually retry an ambiguous
copy as a fresh publication.

Local UI regression: `node apps/miniapp/test/publisher-comments.browser.mjs` after
contract builds finish. It covers separate full-screen chat/channel modules, mode persistence,
save failures and info dialogs on iPhone SE, Android and desktop in light/dark themes.
