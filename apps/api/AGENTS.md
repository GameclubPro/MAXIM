# API Agent Notes

## Scope And Architecture

- These instructions apply to `apps/api`. Root workflow and deploy rules still apply.
- The NestJS/Fastify API uses Prisma/Postgres and BullMQ/Redis. Runtime processes share one image and split work with `APP_ROLE`; `APP_SERVICE_NAME` selects the typed queue/service profile in `src/runtime/runtime-topology.ts`.
- Keep the runtime topology aligned with both production Compose files and `infra/scripts/lib/deploy-topology.sh`.
- Ingress accepts public health/webhooks, admin serves `/api/v1/` and local owner APIs, enqueue materializes queue work, moderation roles process their assigned queues, and action dispatches MAX actions.
- `api-media-analysis` owns CPU-isolated commercial-image OCR; keep it single-concurrency, resource-capped, and in `shadow` until corpus gates authorize a wider rollout.
- Runtime hot paths must go through `WebhookIngestionService`, `ModerationExecutionService`, `MaxActionDispatchService`, and `ManagedEntitiesDiscoveryService`, not legacy implementations.
- Admin entry points should use `ManagedEntitiesService`, `AdminSettingsService`, `ManagedBroadcastService`, `ManualModerationService`, `ChannelDialogService`, and `ManagedGiveawayService` instead of growing legacy `AdminService`.
- Refactor guards track real `*.legacy` files. New code imports public facades; only thin facade modules may import legacy implementations.

## Validation And Prisma

- Focused validation: `npm run check:api`, `npm run check:prisma`, or a targeted `npm test --workspace @maxim/api -- <spec-or-pattern>` while iterating.
- Public API build/typecheck/test scripts serialize codegen through repo file locks. Do not invoke `*:unlocked`, `*:source`, raw Prisma Generate, and another API validation concurrently.
- The built entrypoint is `dist/apps/api/src/main.js`; `npm run build --workspace @maxim/api` cleans output and checks that stale modules are absent.
- Prisma 7 uses `apps/api/prisma.config.ts` from repo root or `prisma.config.ts` from this workspace. Dependency security anchors hoist the pinned CLI, so in API containers call `./node_modules/.bin/prisma` from repo root.
- Runtime code imports Prisma through `src/prisma/prisma-client.ts`, not `@prisma/client`; generated client output is ignored under `src/generated/prisma/`.
- Model, enum, or database mapping changes in `prisma/schema.prisma` require a migration; generator/datasource-only changes do not.
- `config/prisma-migration-policy.json` pins names and content digests through the latest committed migration. A new migration must advance that immutable baseline in the same reviewed change; `policyRulesAfter` is the fixed bootstrap cutoff and must never advance. Never edit or delete historical `migration.sql` files.
- Destructive column removal requires two runtime releases: first ship a client/schema that no longer selects the columns while DB columns remain, then drop them only after every API role runs the compatible client.
- Statistics participant names use `chat_user_display_names` before temporary local history. `allowRemoteLookup: false` disables MAX calls, not local resolution. Backfill only with bounded `npm run stats:backfill-display-names -- ...` runs.
- Raw `webhook_events` display-name fallback must keep the shared event-type allowlist and the exact predicate used by `webhook_events_local_display_name_chat_user_created_idx`; broad JSON scans are not an acceptable fallback.
- Retention cleanup runs sequentially in bounded ordered batches and does not run at process startup. Keep a shared total budget for status groups that previously cleaned together.

## MAX Transport

- Verify MAX Bot API, Mini Apps, `init_data`, webhooks, and deep links against current docs, in this order:
  1. `https://dev.max.ru/docs/`
  2. `https://dev.max.ru/docs-api/`
  3. `https://help.max.ru/help/bots`
  4. `https://github.com/max-messenger`
- MAX removed bot-wide `GET /chats`; keep `listBotChats` compatibility out of production discovery and never build a new flow on it.
- Send bot tokens only as `Authorization: <token>`, never query parameters. Keep tokens and webhook secrets only in ignored env/VPS secrets.
- Production delivery uses webhooks. Long polling is development-only and cannot coexist with a webhook subscription.
- The MAX overview documents a 30 rps ceiling without defining its scope across unrelated tokens. This project enforces 30 rps independently per bot token and has no additional aggregate 30 rps hard guard; use existing per-bot queues, lane/source tags, route priorities, and per-role class limits rather than direct hot-path calls.
- The runtime image carries the Russian Trusted Root/Sub CA bundle under `infra/certs/` via `NODE_EXTRA_CA_CERTS`; preserve it in API Docker changes.
- MAX permissions are entity-sensitive: group-chat `write` permits message deletion and channel posting, but channel edit/delete requires `edit`/`edit_message` and `delete`/`delete_message` respectively.
- In hot paths prefer targeted `getCurrentChatMemberAccess` or `getChatMembersAccess`; fetch a full admin roster only when the feature needs it.
- For `GET /chats/{chatId}/members`, send multiple IDs as one comma-separated `user_ids` value; repeated parameters can collapse to the first user.

## Live MAX Test Entities

- The only default targets for live bot, moderation, and publication smokes are:
  - `CHAT` `Тест Коде`: `https://max.ru/join/dDW5RpVS-CNwz9H7SqhbQRIOtrBeQXhW8jeoNjMdwz4`
  - `CHANNEL` `Тест Кодекс`: `https://max.ru/join/rd2t2ZcjHfg48edf4won7Ur_8s6wUIyDYRoW_dfuM9c`
- Treat the join links as stable operator anchors, not entity IDs. Resolve the managed entity through the normal MAX discovery/binding flow and confirm its `CHAT` or `CHANNEL` type before any mutation.
- Run live mutations only while production is healthy. Use uniquely marked, agent-created test content and clean up only that same content after verification; never sanction real participants, delete pre-existing messages, or change unrelated settings.
- Do not use any other real chat or channel for agent-initiated live mutations unless the user explicitly designates it for that test.

## Webhooks And Deletion Safety

- `POST /subscriptions` is transport source of truth: public HTTPS on port 443, trusted full-chain TLS, HTTP 200 within 30 seconds, and `X-Max-Bot-Api-Secret` validation when configured.
- Keep required subscriptions aligned with `src/max/max-webhook-subscription.constants.ts`: the base set is `message_created`, `message_edited`, `message_callback`, `user_added`, `user_removed`, `bot_added`, `bot_removed`, `bot_started`, and `chat_title_changed`. Shadow/canary/on also subscribe to `message_removed`, `bot_stopped`, and `dialog_removed`; shadow records those events without applying terminal lifecycle transitions, while off omits them.
- `MAX_REQUIRED_WEBHOOK_UPDATE_TYPES` is the product subset of official updates. Add parser, queue, and product handling before subscribing to additional lifecycle events.
- After changing a webhook host/domain, read `GET /subscriptions` and recreate the target; do not assume its secret binding changed automatically.
- Keep `APP_BASE_URL` and `MAX_WEBHOOK_BASE_URL` aligned with the canonical host, currently `https://major-maksimov.ru`.
- Webhook `dedupKey` is bot-scoped (`botId:updateId`). Dedupe logical side effects later by message/update semantics.
- Use `Update.timestamp` as event/edit time; `Message.timestamp` is creation time and cannot identify successive edits.
- Moderation enforcement and retry-critical cleanup use durable `ModerationDeleteIntentService` intents. Direct delete belongs only inside intent execution or explicit shadow/off compatibility.
- `MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS` is an execution-time kill switch and must affect already stored intents.
- Replacement-message cleanup has a separate execution-time switch, `MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED`, limited to the exact rule-code allowlist in `ModerationDeleteIntentService`. Preserve requested routing while the switch is off, promote legacy `origin_only` rows during recovery, and allow survivor routing only for user-authored chat replacements; channel and bot-authored cleanup stays origin-only.
- Keep replacement-message cleanup disabled by default. Enable it only after a bounded capability/backlog audit confirms that critical-lane capacity can absorb the existing intents.
- A delete succeeds only on documented `{ success: true }` or message-specific absence confirmation. An arbitrary HTTP 404 is not proof that a message is gone.

## Message And Link Semantics

- User formatting arrives in `message.body.markup`, not literal Markdown. Preserve/reconstruct markup when importing, editing, or republishing.
- A forwarded message may include a supplemental `share` attachment whose URL is only a hidden preview. Publisher import must not append that URL or reject otherwise transferable text/media; use a credential-free `payload.url` only when the share is the sole transferable content.
- MAX can serve incoming photos as WebP or AVIF even though outbound image upload rejects those formats. For republishing, byte-validate first and apply the bounded JPEG/PNG normalizer only after the typed unsupported-format result.
- Publisher forward import prefers its authenticated persisted webhook receipt; a later exact-message GET is fallback only when that receipt is unavailable, because remote reads may omit nested forward content.
- A valid MAX `user_mention` markup entity is not a link-policy violation. Trust the markup discriminator, not a visible `@` label: `link` markup, unexpected `url` fields, shares, buttons, and plain HTTP(S) targets remain subject to link moderation even when their label looks like a participant mention.
- Treat `markup.from`/`length` as JavaScript string offsets in the original text; do not remap through code-point indexing on emoji-rich text.
- Resolve `max://user/<id>` labels from the full display name, including split first/last fields.
- For admin contact, prefer a direct HTTP(S) profile URL. With a saved label render `Связь с админом: [Display Name](max://user/<id>)`; without a label fall back to HTTP(S), because arbitrary-label mentions can render as plain text.
- Multi-bot links must use the same resolved `botId` for payload signing/dialog tokens and the `https://max.ru/<bot>?start=...` URL.
- Internal `startapp` links use `MAX_ENTRY_BOT_ID` with default-bot fallback, not whichever bot executes an action. Ordinary `start` links remain bot-specific.
- `startapp` payloads are limited to 512 characters and `[A-Za-z0-9_-]`; use `MaxBotLinkService`, `max-deep-link.util.ts`, and the shared launch-route patterns.
- Profile handoff payloads (`pmh-` and `pm2_`) are dedicated flows. Generic button schemas reject them, and profile caches remain route-bot-scoped.
- Trust validated `initData`/`WebAppData` with the correct bot-token HMAC only; `initDataUnsafe` is convenience data.
- Sanction explanations, warnings, and published rules append the fixed admin-contact link through dedicated `*AdminContactButtonEnabled`/`Url` fields. Mute/ban notices do not include it.
- Empty stored editable bot-speech text means inherited catalog copy; any non-empty value is custom even if it matches an old default. Never infer inheritance by string comparison.

## Publishing And Outbound Actions

- With `MAX_PUBLISHER_DISPATCH_ENABLED=false`, `api-publisher` may run identity attestation, heartbeat, webhook reconciliation, and passive lifecycle handling only; do not start publication, binding, suggestion, or chat/channel-comment recovery scans and do not probe MAX entity access.
- Publik entity discovery and user authorization are Publisher-owned. Use the exact `PublisherEntityBinding`, the Publisher bot catalog row, and a fresh `ManagedEntityAccessEdge` whose `botId` is the Publisher bot; never require a Major `ChatBotMembership` or copy a Major access edge into this scope.
- An authenticated Publisher `bot_added` or explicit `Старт` handshake may create the shared `Chat` shell and exact Publisher catalog/binding, but must not set `Chat.botId`, `primaryBotId`, or any `ChatBotMembership`. Grant user access only after the Publisher token confirms both bot and user admin/owner access.
- `publikEnabled` is the only Major-owned cross-bot policy switch and remains effectively enabled when no policy row exists; a persisted `false` excludes the entity from Publisher list/get/resolve/refresh. Publisher-profile policy writes may change only Publisher-owned secondary module settings.
- Mini app VK parsing routes live only under `/v1/publisher/entities/:entityType/:entityId/vk-parsing`, authorize only the Publisher profile, and require exact Publisher entity access. Do not restore the retired Major `/chats|channels/:id/vk-parsing` routes. Major settings writes, including bulk apply, must preserve Publisher-owned chat/channel-comment fields.
- For non-VK publication envelopes, `PUBLIK_V1` target authorization and execution use Publisher-owned access while `LEGACY_ROUTED` keeps the Major routing path for existing scheduled work; a missing Major primary bot must not block a Publik send. VK parsing is excluded from that compatibility rule and must reject every `LEGACY_ROUTED` intent.
- Managed broadcast/autopost MAX calls use `MAX_API_SOURCE_TAGS.MANAGED_BROADCAST`. User sends/tests are `interactive`; scheduled/startup delivery is `background` and honors governor pause/slow decisions. Uploads stay on the send lane.
- Publication `NOW` is user-triggered even when recovered by the action poller: materialize it ahead of background work and dispatch through the immediate lane.
- Keep DB-only publication rollups outside governor pauses; ambiguous sends require manual review.
- A message-send timeout is ambiguous. Never auto-retry an attempted send without `remoteMessageId`; uploads/preparation may retry transport timeouts.
- Legacy Publication deliveries created by the retired exact-absence classifier remain effectively `AMBIGUOUS`; never reset their remote message IDs through Retry. Normalize only reviewed explicit delivery IDs with `npm run publication:normalize-legacy-absence --workspace @maxim/api -- --delivery-id <id>` first, then repeat with `--apply --actor-user-id <id>` after the dry-run matches.
- Publisher suggestion recovery keeps literal action/status branches as separately limited `UNION ALL` queries with `(created_at, id)` keyset bounds aligned to their partial indexes. `OR`, `action IN`, or parameterized partial-index predicates are regressions and require both query-shape and representative PostgreSQL-plan coverage.
- Publisher suggestion admin DMs use `publisher-suggestion-admin`: submit/callback producers may enqueue from shared roles, but delivery, review, sync, and recovery run only in `api-publisher` with the exact Publisher bot. Keep this queue separate from Major `admin-suggestion-delivery`; reuse the crash-safe suggestion ledger with a Publisher-scoped `botKey`, access edge, and private-dialog route.
- KICK/BAN ledger rows are crash-fenced: never reclaim a stalled `IN_PROGRESS` row and retry only a proven pre-dispatch failure. Resolve an executable route before recording dispatch start; a confirmed UNBAN clears prior terminal BAN idempotency state so a later ban remains possible.
- Retries preserve the recorded content revision. Latest-content retry requires optimistic publication/content revision guards; never rewrite `SENT` or `AMBIGUOUS` attribution.
- Publication video input remains capped at 24 MB because it crosses base64 JSON, `bytea`, and in-memory buffers. Outbound resumable upload is not a reason to raise ingestion limits.
- Managed broadcast rows with `publicationOccurrenceId != null` are Publication execution envelopes. Legacy broadcast/autopost read, mutation, calendar overwrite, and retry APIs must hide them.
- MAX has no native poll endpoint; managed chat and channel polls use callback-button messages. Keep the published message body exactly equal to the administrator-authored question. Active button labels append `percent(count)` and include a bounded ten-cell result bar only when the authored option and full result fit the button visual limit; preserve the complete authored option by dropping the bar instead of compacting text. Keep callback payloads stable and bump the render format when this presentation changes so existing active polls are repaired. Replay dedupe is bounded and per-poll pseudonymous. Anonymous polls persist only identity hashes needed for revoting and never expose voters.
- Managed poll list endpoints select/expose persisted `imageCount` only; raw poll images belong to the details endpoint.
- Settings audit payloads contain only requested allowlisted keys and bounded media metadata. Keep the settings mutation and audit insert in one transaction; never copy base64 media, filenames, or full settings snapshots into the audit log.

## Managed Entities And Multi-Bot

- Ownership is `Chat.primaryBotId` plus `ChatBotMembership`; `Chat.botId` is transitional compatibility.
- Centralize primary-bot scoring in `src/max/max-bot-access-policy.util.ts`; routing and ownership repair share this policy.
- One confirmed eligible active bot is enough. Do not mark a chat failed merely because its primary is weak/denied while another route candidate has rights.
- Keep UI, diagnostics, and tests list-oriented; never assume exactly one standby bot.
- Lifecycle policy lives in `src/max/max-bot-state.util.ts`: active bots execute/assist/promote, draining bots serve webhook/read/discovery only, and dormant/disabled bots are not route candidates.
- `GET /v1/system/bots` is local-only fleet state from registry, caches, metrics, and bounded Prisma aggregates; do not add live MAX access refreshes.
- Configured runtime bots are moderation-immune. Use `MaxBotRegistryService.isKnownBotUserId` or existing wrappers, not ad hoc IDs.
- Aggregate managed entities per unique chat/channel; never duplicate cards per bot.
- Roster/admin sync skips positive-ID private dialogs unless explicitly channel-typed.
- Terminal access loss routes through `ManagedEntityAccessLossService`. Treat `chat.denied`, `chat.not.found`, and bare send/read/lookup 403/404 as loss, but old-message `message.not.found` delete remains harmless.
- Keep `BOT_DENIED` bot-scoped. Do not block an entity or mass-mark edges when another runtime bot has fresh confirmed owner/admin access.
- Home access is based on fresh `GRANTED` `managed_entity_access_edges` plus active bot membership. Transient/bot-scoped 403 must not prune access before checking that edge.
- Missing-edge repair is allowlist-backed, preserves fresh denied state, and queues roster validation. Legacy allowlist rows missing bot ownership fields remain repair candidates.
- Fresh `bot_added` candidates appear only after MAX confirms both user and runtime-bot admin rights. Settings links come after the `Старт` handshake, not directly from onboarding.
- A successful handshake keeps the access edge, `ChatBotMembership`, `chat:admin-access` cache, and user snapshot aligned.
- Membership event time is the durable access epoch in SQL. Capture remote probe start before the MAX lookup, serialize grants against that epoch under the parent `Chat` lock, commit SQL before publishing Redis epoch/CAS mutations, and never await Redis while holding a PostgreSQL lock.
- Discovery uses `bot_added`, recent bootstrap/activity, allowlist, published snapshots, and targeted checks; never restore `GET /chats`, full bot-chat scans, or launch-context assumptions.
- When recent hydration resolves better metadata, update the user-scoped published snapshot so home does not retain fallback `Chat <id>` titles.
- Refresh is asynchronous and entity-type-specific. Diagnose CHAT and CHANNEL independently and trust refresh cursor/state, not only the first response.

## Moderation And Read Models

- `antiSpamEnabled` bans on the sixth plain-text/sticker message within six seconds. Exclude photos, video, files, voice, media batches, and forward-only links; do not expose threshold controls or route this burst through configurable escalation.
- Required-subscription moderation checks every target with bounded concurrency and confirms stale missing cache through MAX before sanctions. Save only verifiable targets; disable the feature if none remain and fail open on terminal target errors.
- Night mode/manual close is chat-only. It deletes non-admin chat messages in the event path; transitions/notices are scheduled background work. Do not add channel handling, list polling, per-chat sleeps, or user-message-triggered notices.
- Night-mode transition scheduling requires an active actionable `ChatBotMembership`; a legacy chat with no membership has no executable send route and must stay unscheduled until a proven live access recovery recreates the membership and reconciles the chat.
- Night-mode startup must not synthesize a pre-start catch-up. It may finish a current boundary only from an exact v4 durable registry/Bull intent, from an older intent whose boundary was still future when that process started, or from an exact terminal pre-dispatch access rejection after fresh actionable admin/owner access and a successful ledger CAS reset. A missing ledger without a durable intent remains a skip. Runtime recovery is exact-session only: stale Redis state must not replay, delete, or announce an older session inline.
- Historical night-mode close recovery discovery is owned by `api-moderation-background`, never `api-enqueue`; keep the global discovery scan aligned with `20260823170000_add_night_mode_recovery_discovery_index`, the per-chat missing-event anti-join aligned with `20260830014000_add_night_mode_per_chat_recovery_index`, and preserve the page backoff.
- Stop words include blocked words and domains. Blocked domains match exact hosts/subdomains independently of link moderation; an explicit allowlist suppresses that URL hit.
- Allowlist `DOMAIN` matches the host and subdomains; `EXACT` remains URL-specific.
- Moderation and membership feeds use maintained read models (`chat_moderation_feed_items`, `chat_moderation_affected_user_hours`, `chat_membership_activity_feed_items`), not raw-event reconstruction per request.
- Global spammer fanout is silent. Local BLOCK/ALLOW is admin-scoped and weak global evidence; natural bans are capped, and enforcement bans/kicks must not feed back as evidence.
- Review lists use `includeProfiles=false` and `includeObservations=false`, then lazy-load diagnostics. Distinguish cluster `observationsCount` from per-user counts.
- `GlobalSpammerIntelligenceService` owns observations, scoring, graph/reputation, decisions, diagnostics, and expiry. Active rows require future `expiresAt`; sanctions are gated by `evaluatePolicy` and active confirmed decisions.
- Developer Super Ban uses `global_spammers` with `DEVELOPER_FORCED`, respects per-chat `deleteSpammersEnabled`, avoids synchronous global fanout, and lets later webhooks enforce in opted-in chats. Keep the Redis `global-spammer:developer-forced:*` fast path and warm-marker self-heal aligned with those rows.
- Commercial detection lives under `src/moderation/commercial/`; scoring/policy changes update fixtures and benchmark while keeping `COMMERCIAL_AD` metadata explainable.
- Profanity sensitivity uses structured `CORE_MAT`, `SEVERE_ABUSE`, and `MILD_INSULT` decisions. `PROFANITY_V2_ROLLOUT_MODE=legacy` is the temporary execution-time rollback switch; keep new-chat/default policy `BALANCED` and preserve category metadata.
- Channel stats read rollups for membership/posts/views/reactions and only compact raw-post details. Do not block stats GET on MAX refresh; enqueue stale refresh and let the mini app request `includeActivityPreview=false` for first paint.
- Managed giveaway prize labels are unique before persistence/publication; normalize repeated names into numbered slots.

## Bounded Operational Commands

- Audit profanity and chat stop-word decisions with `npm run moderation:audit-profanity --workspace @maxim/api -- --since <iso> --until <iso> --limit <1..5000> --sample <0..100> --json`; text is omitted unless the reviewed `--include-sanitized-text` flag is present.
- Preview expired global-spammer cleanup before deletion: `npm run spammers:archive-expired --workspace @maxim/api -- --dry-run --json`.
- Audit commercial decisions locally with `npm run moderation:audit-commercial --workspace @maxim/api -- --since <iso> --until <iso> --limit <n>`.
- On VPS, run the built commercial audit inside `api-admin` with `node apps/api/dist/apps/api/src/scripts/audit-commercial-filter.js` and explicit bounded `--since`, `--until`, and `--limit` arguments. Full-window audits must use `--limit all --page-size <1..5000>` so candidates and JSONL exports remain memory-bounded. Use `--current-only` for routine full-window production audits until the historical `COMMERCIAL_AD` lookup has a reviewed `(chat_id, message_id, created_at, id)` partial index.
- Sanitized corpus export uses `--export-corpus-jsonl <path>` and, for full corpus-gate validation, `--export-all-corpus`. Validate with `npm run moderation:validate-commercial-corpus --workspace @maxim/api -- --input <path>`; relative inputs resolve from `apps/api`.

## VK Parsing

- VK parsing is available only for Publisher-owned managed chats and channels through server capability, never a hardcoded client/user/channel allowlist. Endpoints enforce exact Publisher entity access.
- Persisted VK settings, sources, and posts are Publisher-only: database constraints require `owner_profile = PUBLISHER` with a nonblank exact `owner_bot_id`, and Prisma fields have no Major/empty defaults. The `MAJOR` enum value remains only for historical PostgreSQL compatibility; never create, recover, or branch on it in runtime code.
- VK publish intent execution is Publisher-only: active `PUBLIK_V1` rows use the exact Publisher bot and run only on `vk-parsing-publisher`/`api-publisher`. `vk-parsing-publish` and its `api-action` worker are retired; never restore, recover, or reschedule Major-owned/`LEGACY_ROUTED` VK work. Publisher dialog links use the domain-separated file key mounted only in `api-admin`, `api-action`, and `api-publisher`; never widen bot-token or init-data-key mounts to prepare links.
- Cached MAX upload payloads are bot-scoped. Persist and verify the internal upload-bot marker, strip it before sending to MAX, and re-upload legacy untagged payloads.
- Source sync runs only on `api-publisher` through BullMQ `vk-parsing-sync`. Scheduler selection, job envelopes, enqueue CAS, and database leases must all carry the exact Publisher owner scope; stale or Major-owned jobs complete without touching a source. Automation settings live per Publisher-owned managed entity in `vk_parsing_settings` and per source.
- Supported publishable content is text, links, photos, or one direct HTTPS `video.files.mp4_*` video. If a supported video is present, publish it and drop photos; never accept player pages, external/HLS streams, or mixed photo/video payloads.
- If `wall.get` lacks direct video files, enrich with `video.get` before declaring unsupported. Do not scrape the VK player.
- `VK_SERVICE_TOKEN` absence is reported as `NOT_CONFIGURED` only after admin access validation; working endpoints fail early with a clear 503.
- Keep `VkParsingService` thin: access in `VkParsingAccessService`, source/scheduler in `VkSourceService`, sync/leases in `VkSyncService`, delivery in `VkPublishService`, feed mapping in `VkParsingFeedService`, and HTTP/rate retry in `VkApiClientService`.
- Source identity is `wallOwnerId`; trust `wall.items[].owner_id`, reject posts from another owner, and do not infer identity from the first extended `groups` item.
- Photo CDN candidates remain tied to VK media identity. Retry another size on expiry/404 and never reuse a failed cache row for a different URL without reusable MAX upload data.
- Source leases use `syncLockedBy`, `syncAttemptCount`, `syncLockDeadlineAt`, and `syncHeartbeatAt`; recovery prefers the deadline and diagnostics expose stale locks.
- Circuit state persists `terminalFailureCount`, `circuitOpenedAt`, `circuitReasonCode`, `circuitReason`, and `circuitRetryAt`; scheduled sync skips open circuits, while manual refresh/re-add may clear and retry with the reason still visible.
- Initial source-added backfill and first successful sync do not autopublish history. Eligibility requires `autoPublishEnabledAt` and a real VK publication timestamp at/after that baseline.
- Entity and source automation settings both apply: baseline, mode, daily/min-interval limits, quiet hours, priority, and `publishScheduledAt` are rechecked by the worker.
- Governor `pause` defers VK autopublish; `slow` must not starve a single job. Increment publish attempts only at a real MAX attempt.
- Diagnose with `npm run vk-parsing:diagnose --workspace @maxim/api -- --json --limit 20`; set `REDIS_URL` for BullMQ counts and use `--window-hours` for the error window.
