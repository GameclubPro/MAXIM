# Stop-Word Policy Rollout

## Compatibility Release

Deploy the additive `20260916130000_add_stop_words_policy` migration and compatible API runtime first. Keep the original lists and message-limit columns. A null policy is a compatibility state; a malformed non-null policy disables stop-list enforcement instead of falling back to broader legacy matching.

All 13 API roles and the OCR auxiliary must use the same green exact-SHA image. The normal deploy wrapper owns queue fencing, migrations, health checks and the release manifest. Do not recreate PostgreSQL or Redis. Commercial OCR promotion is separate and remains subject to its existing certification gates.

The compatible rollback floor requires the typed policy reader, current-message stop-word delete guard, and independent-sanction guard. Do not roll back to pre-policy code after any policy has been saved.

## Data Migration

Inside the compatible `api-admin` container, preview the bounded migration:

```bash
node apps/api/dist/apps/api/src/scripts/migrate-stop-words-policy.js --limit 1000 --json
```

Review `eligible`, `invalid`, `conflicts`, `exhausted` and `nextCursor`. The command prints no configured text, message templates, media or credentials. It reads one settings row per batch through the primary-key cursor and stops after 60 seconds or the row limit. Media is stored in `stop_words_media`, separately from `stop_words_policy`, so dispatch guards never select image payloads.

Repeat with `--apply` only after the compatible release is healthy. Resume from the returned `--after <nextCursor>` until `exhausted` is true. Invalid rows remain unchanged; concurrent changes are skipped and require a fresh preview. A policy save and its audit are transactional, followed by shared context-cache invalidation. A failed invalidation stops the command; restore Redis health and rerun from the previous cursor. Apply also refreshes caches for already migrated rows, recovering a commit followed by an interrupted invalidation without rewriting policies.

Migration preserves configured sanctions, mute duration, messages, buttons and nonempty media. Only the checked-in phrase mapping expands known built-in compounds; no dictionary guessing or suffix removal is used. Existing IDs are deterministic. Newly created policies default to exact matching, and new chats default to disabled enforcement.

## Editor Release

Deploy `miniapp-major-static` after compatible APIs. Use only `https://major-maksimov.ru/app/`. The editor saves through `PUT /chats/:chatId/stop-words` with `expectedRevision`; ordinary settings updates cannot write the policy. Section copy transfers policy content, increments each target's own revision, and leaves the allowlist in its existing ownership boundary.

`GET /stop-words/status` exposes revision and effective OCR availability without returning policy/media. `POST /stop-words/preview` uses the production matcher, requires chat-admin access and does not persist test text or create actions.

## Acceptance

Run the full repository check plus mobile browser flows covering atomic phrases, invalid batches, capacity limits, rule editing, masking, module disable/enable, discarded buffers, stale revisions, save retries and selected-chat copy. Check iPhone and Android, light and dark themes, keyboard overlap, scrolling and maximum-length entries.

After deployment, verify the canonical mini app, ingress/admin health, exact API image parity and OCR sandbox readiness. Verify new policy and old-client rejection using only the designated test chat. Do not sanction real participants or replay historical messages. Observe stop-word decision and guard-rejection metrics without retaining source text.
