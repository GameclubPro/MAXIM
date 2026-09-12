# Rules Publication Cleanup

Resolve a failed `POST /api/v1/chats/<id>/rules/publish` from a bounded nginx log window,
then confirm the exact managed CHAT and supplied invite link through a targeted MAX read.
The miniapp error alone does not establish lost bot permissions: persistence and transport
exceptions also enter the same cleanup error handler.

Use the fixed metadata-only database report, after synchronizing reviewed audit tooling and
running `postgres-audit-provision` preview followed by its reviewed `--apply`:

Set `RULES_CHAT_ID` to the verified negative chat ID before invoking the report.

```bash
./infra/scripts/vps-connect.sh postgres-audit rules-cleanup "${RULES_CHAT_ID:?}" --explain
./infra/scripts/vps-connect.sh postgres-audit rules-cleanup "${RULES_CHAT_ID:?}"
```

The report uses the dedicated one-connection read-only audit role, shared audit lock, existing
server/wall deadlines, one chat unique-key lookup, and at most one linked-intent primary-key lookup.
Only ten publication metadata columns are granted; text, media, buttons, and contact links remain
unreadable. The report is opt-in and is not added to periodic `all` or monitor scans.

Compare `pending_cleanup_bot_id` with the exact remote message author and confirmed bot registry
identity. Never assume that the bot currently reading the chat authored an old post, and never
clear a cleanup fence on a generic 403/404. Publication retry remains unsafe while a send fence
is ambiguous. This report does not modify rules, permissions, intents, or remote messages.

## Updating a Blocked Publication

When an older republish cleanup is pending but the current rules post has a stored author bot,
the regular publish operation updates that exact post in place. Fresh bot membership and the exact
remote message author must agree, and MAX must return `success: true`. Text, image, and buttons
are replaced from the saved draft; the link stays stable. No new post is sent and the older cleanup
is neither cleared nor falsely marked successful. Pending reset and ambiguous send fences still block.

For an operator-reviewed recovery, the API image includes
`apps/api/dist/apps/api/src/scripts/repair-pending-rules-update.js`. Run only inside `api-admin`
with exact `--chat-id`, `--message-id`, `--pending-message-id`, and `--bot-id` arguments.
It defaults to metadata-only preview. A separately reviewed `--apply` additionally requires
`--expected-updated-at` equal to the preview timestamp and healthy non-degraded local readiness.
Use `--chat-id=-123...` argument syntax so a negative value cannot be parsed as another option.
This intentionally narrow command refuses enabled admin-contact formatting and empty auto-text
drafts; use the authenticated miniapp for those. Apply reuses the normal publication function,
records the operator actor, and structurally forbids all new sends and deletes.
