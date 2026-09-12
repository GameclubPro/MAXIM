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
