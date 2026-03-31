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
- Legacy REG.RU fallback alias: `ssh maxim-vps-legacy`
- `maxim-vps` should point to the Yandex prod VM and use SSH multiplexing: `ControlMaster auto`, `ControlPersist 10m`, `Compression yes`.
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

## Multi-bot model
- The current data model is `Chat.primaryBotId` plus `ChatBotMembership`. Do not treat `Chat.botId` as the long-term source of truth for shared-presence logic; it remains a transitional compatibility field.
- Managed entities in API and mini app are already aggregated into one chat/channel card with `primaryBotId`, `assignedBots[]`, and `sharedMode`. Do not duplicate one chat into multiple rows just because multiple bots are present.
- Admin UX should stay unified: one chat-level settings surface, bot presence as system metadata. Do not fork moderation/giveaway/settings into separate per-bot forms unless the product explicitly moves to bot-specific capabilities later.
- The public mini app UI should not expose which bot is primary, standby, or currently executing a task. Keep multi-bot ownership and execution details in system/admin diagnostics, not in end-user settings screens.

## Managed entities diagnostics
- The mini app shows only the intersection where the user is admin and the bot also has admin access to the same chat/channel.
- Counts for `Чаты` and `Каналы` can differ because the UI uses `chat_admin_allowlist` plus progressive refresh, not an instant full MAX snapshot.
- Diagnose `CHAT` and `CHANNEL` separately.
- Full refresh is complete only when the Redis cursor becomes `-1`.
- In multi-bot mode, visibility should still be reasoned about per unique chat/channel, not per bot. Use `assignedBots` and `primaryBotId` to understand presence/ownership before assuming the entity is missing.
- For visibility problems, check:
  - `chat_admin_allowlist` rows for the `user_id`,
  - Redis keys `chat:managed-refresh-cursor:v1:<entityType>:<userId>` and `chat:managed-refresh-backoff:v1:<entityType>:<userId>`,
  - refreshed `AdminService.listChats(..., { refresh: true })` or `AdminService.listChannels(..., { refresh: true })`.

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
