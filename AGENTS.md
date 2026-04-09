# Agent Notes

## Core workflow
- For runtime-affecting changes in `apps/api`, `apps/miniapp`, Prisma, Docker, MAX integration, default finish is: local validation plus deploy to VPS.
- Docs, `AGENTS.md`, `README.md`, test-only changes, debug cleanup, and other non-runtime repo maintenance do not require VPS deploy unless the user asks for it.
- Prefer repo scripts over long manual sequences:
  - Local push: `./infra/scripts/local-commit-push.sh "<message>" main`
  - VPS update: `./infra/scripts/vps-pull-build-up.sh main [services...]`
- `./infra/scripts/local-commit-push.sh` excludes `AGENTS.md` by default so agent-note edits do not get mixed into runtime commits. Use `--include-agents` only when intentionally committing `AGENTS.md`.
- Rebuild only changed services. In this repo that is usually `api` and/or `miniapp-static`.
- When a runtime change affects shared API code, remember that prod runs multiple API roles off the same image. In moderation/webhook/action work, a complete API deploy usually means recreating `api-ingress`, `api-admin`, `api-enqueue`, `api-moderation`, `api-moderation-critical`, `api-moderation-realtime-b`, `api-moderation-realtime-c`, `api-moderation-realtime-d`, `api-moderation-background`, and `api-action`.
- Prefer workspace-scoped validation before full repo runs:
  - `npm run typecheck --workspace @maxim/api`
  - `npm run typecheck --workspace @maxim/miniapp`
  - targeted `npm test --workspace @maxim/api -- <spec-or-pattern>`

## Fast mini app loop
- For layout, interaction, and native-feel work, prefer the local emulator before full screenshots:
  - `npm run emulator:miniapp -- --device iphone --reuse-server`
  - `npm run emulator:miniapp:android -- --reuse-server`
  - add `--route '<path>'` to jump directly to the screen under work
- Use screenshots after the layout is close, not as the first feedback loop.
- Avoid full Docker rebuilds for mini app CSS/TSX iteration unless the task specifically needs container parity.

## VPS
- Primary prod SSH alias: `ssh maxim-vps`
- Public site edge SSH alias: `ssh maxim-vps-edge`
- Legacy REG.RU fallback alias: `ssh maxim-vps-legacy`
- `maxim-vps` should point to the Yandex prod VM and use SSH multiplexing: `ControlMaster auto`, `ControlPersist 10m`, `Compression yes`.
- `maxim-vps-edge` points to the public edge VM on `84.201.186.244`; `maxim-vps` remains the main Yandex prod VM on `158.160.179.30`.
- Yandex Cloud fallback access is available locally through `~/.local/yandex-cloud/bin/yc` with the configured profile from `~/.config/yandex-cloud/config.yaml`; use it when public SSH hangs before banner exchange.
- Current Yandex Cloud inventory:
  - cloud: `b1gjv3sr1tmb6c0p08um`
  - folder: `b1go2mndnq5orif32ami`
  - prod VM: `maxim-prod-1` (`fv4ujtg5qln445qip9uv`, `158.160.179.30`, `10.130.0.29`)
  - edge VM: `maxim-site-edge-1` (`fv462spp3r1ortgbt3l9`, `84.201.186.244`, `10.130.0.11`)
- Useful Yandex Cloud recovery commands:
  - `~/.local/yandex-cloud/bin/yc compute instance list --folder-id b1go2mndnq5orif32ami`
  - `~/.local/yandex-cloud/bin/yc compute instance get maxim-prod-1 --full`
  - `~/.local/yandex-cloud/bin/yc compute instance update maxim-prod-1 --metadata serial-port-enable=1 --serial-port-settings ssh-authorization=instance_metadata`
  - `~/.local/yandex-cloud/bin/yc compute connect-to-serial-port --instance-name maxim-prod-1 --user maximadmin --ssh-key ~/.ssh/id_ed25519`
- Serial console is the current verified fallback for `maxim-prod-1`; direct SSH to `158.160.179.30:22` and `84.201.186.244:22` can accept TCP while stalling before the SSH banner, so prefer `yc` recovery when that happens.
- Current public prod routing:
  - `maxim.play-team.ru` is the canonical public domain for both mini app/API traffic and MAX webhook subscriptions
  - `maxim.play-team.ru` resolves to `84.201.186.244` via `maxim-site-edge-1`
  - `maxim-site-edge-1` runs `haproxy` in TCP passthrough mode to `10.130.0.29:80/443`
  - the backend app on `maxim-prod-1` still terminates TLS and still sees webhook/user traffic
- `hook.maxim.play-team.ru` is now legacy/fallback infrastructure on `158.160.179.30`, not the expected live subscription target.
- `./infra/scripts/vps-pull-build-up.sh` and `./infra/scripts/vps-pull-build-up-scale.sh` are meant to run on the VPS host. From local machine, invoke them through SSH. For shared API runtime changes, prefer the full prod API role set plus `miniapp-static` when the mini app changed.
- Use `docker compose` only. Do not use `docker-compose`.
- Main prod stack: `infra/docker-compose.yml`
- Split/load-testing stack: `infra/docker-compose.scale.yml`
- Do not keep both stacks running at the same time because they conflict on port `3001`.
- If `/var/www/Chat_bot/.env` is missing, restore it from the running `infra-api-1` container before `docker compose exec/run`.
- If `git pull --ff-only` is blocked by a dirty VPS worktree:
  - If current file contents already match `origin/<branch>`, allowed service flow is `git stash push -> git pull --ff-only -> git stash drop`.
  - If local VPS changes differ from `origin/<branch>`, stop and report the conflict instead of overwriting them.
- After a runtime deploy, always:
  - apply Prisma migrations,
  - rebuild only changed services,
  - recreate containers with `--force-recreate`,
  - check `live` and `ready` health locally and publicly,
  - check public mini app availability at `https://maxim.play-team.ru/app/` when the product includes mini app flows.
- During API deploys under live webhook traffic, `live` can recover before `ready`: temporary `503` on `ready` may only mean backlog accumulated in `webhook_events` during restart. If containers are healthy and queue lag is draining, wait for `ready` to return to `200`; after recovery the expected reason may be `recovery window in progress`.
- If `/app/` returns `502`, first check `docker compose ps miniapp-static`; API health can stay green while nginx fails on upstream `127.0.0.1:3000`.
- Deploy scripts `infra/scripts/vps-pull-build-up.sh` and `infra/scripts/vps-pull-build-up-scale.sh` now auto-include `miniapp-static` if it is unexpectedly down during an API deploy, but manual `/app/` verification is still required after incidents.
- Public `GET /api/v1/system/metrics/queues` is admin-auth protected; anonymous `401` there is expected. For unauthenticated checks use `/api/health/live` and `/api/health/ready`.
- When backlog diagnosis is unclear, compare both DB and Bull state: `webhook_events.status = 'QUEUED'` can coexist with Redis `bull:<queue>:prioritized` / `active` jobs, so `bull:<queue>:wait == 0` alone does not mean the drain is finished.
- For orphaned user-facing webhook rows, the repair window is intentionally much shorter than background: user-facing `QUEUED` rows are re-enqueued after about `20s`, while background lanes still wait much longer. If a queue lag incident grows for minutes with `repairs=0`, the problem is probably real hot-path pressure, not stale rows.

## Runtime architecture
- Realtime moderation is no longer a single-process/default-queue design. `message_created` traffic is sharded across multiple default queues and multiple realtime workers; critical/legacy work and background tasks are split into separate roles.
- Preserve per-chat ordering when changing webhook routing or moderation queue ownership. Do not collapse `message_created` back into one shared default queue or raise concurrency inside one shard as a first-line fix.
- In dynamic default-shard leases, a timed-out `worker.close()` is not a safe handoff signal. Keep ownership pinned to the current worker group until close actually resolves; do not release claims or reassign the shard on timeout alone.
- If a timed-out default-shard worker keeps backlog pinned after its retry cooldown, force-recycle that worker locally before assuming routing is wrong. A `prioritized` backlog with `active=0` on one shard is now a strong signal for a stale local worker, not just load skew.
- Required-subscription membership checks now use targeted MAX access checks with batching, short deadlines, per-chat backoff, and hot-channel degradation. Do not reintroduce one-request-per-user synchronous lookup loops in the hot path.
- Required-subscription enforcement now fails open not only on lookup errors, but also under runtime pressure and chat-level hot-timeout backoff. If tests cover required-subscription moderation, expect healthy-path enforcement and pressured-path skip behavior to coexist.
- Admin bypass and other moderation-side MAX lookups were moved away from the old expensive patterns. Before changing moderation logic, check whether a lookup is already cached, batched, or delegated to background.
- Ordinary `message_created` moderation now has a short chat-level circuit breaker: if one chat repeatedly trips the webhook watchdog and the system is already under pressure, the bot temporarily skips ordinary moderation for that chat instead of letting one hotspot degrade the whole cluster.
- `ready` now uses queue-lag hysteresis. For diagnostics, inspect both the top-level `ok` and `checks.queueLag.rawOk` / `softWarning`; short burst recovery can keep public readiness green while still surfacing early operator signals.
- Health and queue diagnostics are per-bot aware. In multi-bot work, inspect `ready.bots.{botId}` before assuming a global outage.

## MAX
- For MAX Bot API, Mini Apps, `init_data`, webhook, and `open_app`, verify against current official MAX docs instead of memory.
- Source priority:
  1. `https://dev.max.ru/docs/`
  2. `https://dev.max.ru/docs-api/`
  3. `https://help.max.ru/help/bots`
  4. `https://github.com/max-messenger`
- When onboarding, moderation entry flows, or webhook behavior are in scope, inspect `GET /subscriptions`.
- Minimum expected webhook events are `message_created`, `user_added`, `bot_added`; in practice also check `bot_started`.
- Current prod expectation: both active bots should have exactly one webhook subscription each, and both should point to `https://maxim.play-team.ru/api/webhook/max/...`.
- After changing a bot's webhook host or domain, do not trust a side-by-side added subscription alone. Re-read `GET /subscriptions`, then delete and recreate the target subscription so MAX binds the current `secret` to that URL.
- Keep `APP_BASE_URL` and `MAX_WEBHOOK_BASE_URL` aligned in prod when the intended steady state is one canonical domain. If they diverge, webhook reconcile can silently steer subscriptions back to the old host.
- If `POST /api/webhook/max/...` on a new host returns `403` while the same bot/path/secret works in a local synthetic request, suspect a stale MAX subscription secret first, not nginx or VPS networking.
- In ingress logs, missing visible `x-max-bot-api-secret` is inconclusive because pino redacts that header. Confirm by watching the status transition after recreating the subscription and by checking whether new rows appear in `webhook_events`.
- Treat `initDataUnsafe` as convenience only. Authentication, user identity, and server trust must rely on validated `initData`.
- Keep MAX API client behavior aligned with current docs:
  - production uses Webhook, development/testing may use Long Polling,
  - Webhook endpoint must return HTTP `200` within `30s`,
  - recommended `platform-api.max.ru` ceiling is `30 rps`.
- The MAX client now uses shared Redis slot reservation with short waits before failing on internal limits; it should smooth bursts instead of immediately self-throttling.
- Traffic classes may borrow spare headroom from the global `30 rps` budget, so new `interactive` / `critical` throttling is more likely to be a real per-chat hotspot than an internal class split artifact.
- In moderation or other request hot paths, prefer targeted member-access checks (`getChatMembersAccess`, `getCurrentChatMemberAccess`, MAX `GET /chats/{chatId}/members?user_ids=...`) over full admin-list fetches like `getChatAdminIds()` / `GET /members/admins`.
- Moderation admin bypass lookup is now batched per chat and uses shared cache plus chat-level backoff. Do not reintroduce one-request-per-user admin checks in hot paths.
- Required-subscription channel validation now relies on bot self-access (`getCurrentChatMemberAccess(chatId, { trafficClass: 'interactive' })`) rather than fetching the full admin list. When updating tests or mocks around required-subscription flows, provide `getCurrentChatMemberAccess`, not only `getChatAdminIds`.
- MAX group-chat membership snapshots can omit explicit delete aliases even when an admin bot can still remove user messages. For group-chat `delete_message`, do not gate only on explicit `delete_message` / `post_edit_delete_message` aliases; admin/owner must still count as delete-capable. Keep `moderate_member` stricter and tied to member-moderation capability.
- When diagnosing missed spam/link deletes, `ModerationEvent.action = NONE` is not enough to prove a broken delete. Normal flow records the rule event separately from `LINK_BLOCKED_DELETE` / `COMMERCIAL_AD_DELETE`; confirm incidents by looking for rule events that lack a paired `*_DELETE` for the same `chatId` + `messageId`.
- Channel suggestions from mini app and private-bot flows are now delivered asynchronously through Bull queue `admin-suggestion-delivery`; user-facing submission no longer guarantees immediate DM delivery to admins in the same request. For diagnostics, check Redis keys `bull:admin-suggestion-delivery:*` and the `AdminSuggestionDeliveryProcessor` logs.
- After the late-March 2026 fixes, remaining MAX rate-limit noise is more likely to come from real per-chat hotspots in required-subscription membership checks and from background channel jobs (`Failed channel auto post buttons scan`, channel stats startup sync) than from admin bypass lookups or synchronous suggestion delivery.
- For mini app deep links, keep `startapp` payload within the documented MAX constraints: up to `512` chars, only `A-Z`, `a-z`, `0-9`, `_`, `-`.
- Use `openMaxLink` only for MAX deep links like `https://max.ru/<botName>?startapp=...`; use `openLink` or normal browser navigation for external URLs.
- When content already exists as a bot message and the UX is share-first, prefer native `shareMaxContent()` over custom “copy/send” flows.
- Multi-bot readiness now lives in the shared runtime. Additional bots are configured through `MAX_BOTS_JSON`; the default bot also supports `MAX_BOT_CHARACTER_NAME` and `MAX_BOT_SPEECH_PERSONA`.
- Supported bot lifecycle states are `active`, `dormant`, `draining`, `disabled`. Use `dormant` for pre-provisioned bots that must appear in admin metadata but must not start webhook subscription reconcile or user-facing actions.
- Keep bot tokens and webhook secrets only in VPS secrets or `.env`, never in git. If a token was pasted into chat or another external surface, treat it as potentially exposed and rotate it before production activation.
- Bot-specific speech is now registry-level, not chat-level. Chat settings still control `botSpeechStyle`, while bot registry metadata controls persona fields like `speechPersona` and `characterName`.
- Current moderation/runtime speech resolves from the active `botId`. The legacy prod bot remains male by default (`Майор Максимов`); a future female bot should be introduced by setting `speechPersona: "female"` plus an explicit `characterName`, not by forking chat settings.
- For per-chat webhook gaps, compare MAX API reality against local ingestion before touching moderation code:
  - verify the bot still sees the chat via MAX API,
  - fetch recent chat messages from MAX API,
  - compare that with local `webhook_events` for the same `chatId`.
  If MAX has the messages and `webhook_events` does not, the issue is webhook delivery/subscription state, not the moderation handler.

## Multi-bot model
- The current data model is `Chat.primaryBotId` plus `ChatBotMembership`. Do not treat `Chat.botId` as the long-term source of truth for shared-presence logic; it remains a transitional compatibility field.
- Managed entities in API and mini app are already aggregated into one chat/channel card with `primaryBotId`, `assignedBots[]`, and `sharedMode`. Do not duplicate one chat into multiple rows just because multiple bots are present.
- Admin UX should stay unified: one chat-level settings surface, bot presence as system metadata. Do not fork moderation/giveaway/settings into separate per-bot forms unless the product explicitly moves to bot-specific capabilities later.
- The public mini app UI should not expose which bot is primary, standby, or currently executing a task. Keep multi-bot ownership and execution details in system/admin diagnostics, not in end-user settings screens.

## Managed entities diagnostics
- The mini app shows only the intersection where the user is admin and the bot also has admin access to the same chat/channel.
- Counts for `Чаты` and `Каналы` can differ because the UI uses `chat_admin_allowlist` plus progressive refresh, not an instant full MAX snapshot.
- On an empty default load, managed entities now use a two-lane bootstrap: lightweight user-scoped candidates can appear immediately, while the server also starts background allowlist warmup and a durable remote full refresh without waiting for manual `refresh=1`.
- For newly added chats discovered through `user-scoped bot_added`, do not require `chatTitle` to be present in the webhook payload. The API now persists the chat by `chatId` with a provisional fallback title and then attempts a narrow immediate MAX `getChatSnapshot(chatId)` hydration so the real title/header can replace `Chat <id>` quickly without waiting for the wider header-hydration batch.
- Diagnose `CHAT` and `CHANNEL` separately.
- Explicit `refresh=1` on managed chats/channels is now an async refresh trigger, not a synchronous full MAX scan. The API should return cached allowlist data immediately and continue remote full refresh in background.
- For `refresh=1`, trust `refresh.cursor`, `refresh.complete`, `refresh.backoffActive`, and `refresh.nextPollAfterMs`; do not treat the first response as proof that discovery is finished.
- An empty or partial `refresh=1` response can be expected while the background scan is still progressing. Confirm completion only after the cursor reaches `-1`.
- Full refresh is complete only when the Redis cursor becomes `-1`.
- On cold default loads with an empty allowlist, the API now also enqueues the durable Bull job `managed-entities-refresh__<entityType>__<userId>` on queue `admin-managed-entities-refresh`; if discovery seems stalled, inspect Redis keys `bull:admin-managed-entities-refresh:*` alongside the managed refresh cursor/backoff keys.
- A passive cold-start should not leave a fake in-progress state behind: if queue scheduling fails before the job is accepted, the freshly initialized managed refresh cursor is cleared instead of being left at `0`.
- Home is now version-aware for published managed-entities snapshots: if the server keeps returning the same `snapshot.version`, the mini app should update `refresh` state only and keep the visible list stable instead of reapplying the same list.
- On home cold-starts without any visible cached list yet, the mini app should fetch the ordinary managed-entities snapshot/list first and only then continue with background refresh. If a first-open session still renders an empty home before sync settles, suspect a regression in the client cold-start path rather than the published-snapshot version logic.
- The home local cache now persists snapshot metadata together with managed entities. If a user reopens the mini app and sees the cached list immediately, the next server response should only replace it when `snapshot.version` changes.
- A visibility-return refresh on home is now expected only when the current snapshot is stale or missing. If the screen still visibly redraws while `snapshot.stale === false` and `snapshot.version` is unchanged, treat that as a client regression, not normal progressive sync behavior.
- In multi-bot mode, visibility should still be reasoned about per unique chat/channel, not per bot. Use `assignedBots` and `primaryBotId` to understand presence/ownership before assuming the entity is missing.
- For visibility problems, check:
  - `chat_admin_allowlist` rows for the `user_id`,
  - Redis keys `chat:managed-refresh-cursor:v1:<entityType>:<userId>` and `chat:managed-refresh-backoff:v1:<entityType>:<userId>`,
  - refreshed `AdminService.listChats(..., { refresh: true })` or `AdminService.listChannels(..., { refresh: true })`.
- For slow event-history screens, check admin logs for `Slow moderation events query completed` and separate `adminCheckMs` from `queryMs` before assuming the database is the bottleneck.
- Read-only admin endpoints such as chat events now skip persisted allowlist writes when admin access is already cached as granted. If latency regresses there, suspect MAX admin-access cache misses first, not `chat_admin_allowlist` upserts.

## Mini app UI work
- For material UI changes, verify the result in preview or screenshots instead of judging only by code.
- Prefer the newest screenshots in `artifacts/miniapp-screenshots/<timestamp>`.
- If local Playwright/browser deps are unavailable, use the VPS flow:
  - `cd /var/www/Chat_bot && ./infra/scripts/vps-miniapp-preview-screenshots.sh`
- Default quality bar for MAX-native mobile UI:
  - verify both iPhone and Android profiles,
  - respect safe-area and keyboard behavior,
  - avoid desktop-density layouts on 375px width,
  - prefer bridge-backed native actions like haptics, back button, close confirmation, and in-app MAX navigation where appropriate.
- Use MAX UI docs as a reference for spacing, hierarchy, and component behavior. Do not mix `@maxhub/max-ui` into isolated screens casually; adopt it deliberately and coherently.
- The mini app size guardrail is strict on `settings-page`; small gzip differences can appear between local and VPS/Alpine builds. If a deploy fails only on the budget step, compare the actual gzip numbers before changing code or widening budgets.

## Repo hygiene
- Keep the repo root focused on source, docs, infra, and stable config.
- Do not commit local exports, dumps, one-off debug files, or build artifacts.
- Safe cleanup targets are generated outputs such as `dist/`, `coverage/`, screenshot artifacts, root debug exports like `rostov-*`, `autorinok-users.txt`, and temporary files like `TEST_COMMIT.txt`.
