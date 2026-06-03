# Agent Notes

## Purpose

- This file should accelerate work, not override the repo.
- If `AGENTS.md` conflicts with `package.json`, Docker Compose, scripts, or the current code, trust the repo and update this file.
- Keep this file short, stable, and repo-verified. Do not store temporary incidents, dated prod observations, or assumptions that will drift.

## Project shape

- Monorepo workspaces:
  - `apps/api`: NestJS/Fastify API, Prisma, BullMQ workers, Postgres, Redis.
  - `apps/miniapp`: React 19 + Vite MAX mini app. MAX Bridge is loaded from `https://st.max.ru/js/max-web-app.js`.
  - `packages/contracts`: shared Zod/API contracts. Contract changes normally require matching API, mini app, tests, and typechecks.
- Keep `packages/contracts` subpath exports, root `tsconfig.base.json` paths, and `apps/api/jest.config.cjs` mappers in sync so API Jest resolves ESM contract sources correctly.
- Production API uses one shared API image split by `APP_ROLE`; `api-ingress` is the public API role, `api-admin` is the local admin/API role, and moderation/action/enqueue roles process queues.
- Split API services also declare `APP_SERVICE_NAME`; keep the typed service/queue topology in `apps/api/src/runtime/runtime-topology.ts` aligned with compose service env.
- Production mini app is served under `/app/`.

## Core workflow

- For runtime-affecting changes in `apps/api`, `apps/miniapp`, `packages/contracts`, Prisma, Docker, or MAX integration, the default finish is: local validation plus VPS deploy, unless the user explicitly says not to deploy.
- Docs, `AGENTS.md`, `README.md`, test-only changes, and cleanup changes do not require VPS deploy unless the user asks for it.
- After every completed task, do a short self-learning pass before handoff:
  - fix small issues revealed by the work while the context is still fresh, if they are clearly in scope and low risk
  - add or update `AGENTS.md` only with durable, repo-verified knowledge that will speed future work or prevent repeated mistakes
  - prefer stable commands, service names, deploy rules, product invariants, integration quirks, and validation shortcuts
  - do not record one-off failures, guesses, temporary production state, secrets, personal notes, or details already obvious from nearby code
  - if a lesson is too specific to the changed code, encode it as a test, type, helper, or code comment instead of an agent note
- Prefer repo scripts over long manual sequences:
  - local push: `./infra/scripts/local-commit-push.sh "<message>" main`
  - local VPS deploy wrapper: `./infra/scripts/vps-connect.sh deploy main [services...]`
  - local runtime rollback wrapper: `./infra/scripts/vps-connect.sh rollback-runtime <git-ref> [services...]`
  - direct VPS deploy script, from the VPS host only: `./infra/scripts/vps-pull-build-up.sh main [services...]`
  - direct runtime rollback script, from the VPS host only: `./infra/scripts/vps-runtime-rollback.sh <git-ref> [services...]`
- `./infra/scripts/local-commit-push.sh` excludes `AGENTS.md` by default. Use `--include-agents` only when you intentionally want to commit agent-note changes. In a dirty tree it stages tracked changes broadly, so for partial commits use explicit `git add <paths> && git commit && git push`.
- Rebuild only changed services. In practice that is usually `miniapp-static` and/or the shared API image.
- If shared API code or `packages/contracts` changed, recreate every prod API role that uses that image:
  - `api-ingress`
  - `api-admin`
  - `api-enqueue`
  - `api-moderation`
  - `api-moderation-critical`
  - `api-moderation-join`
  - `api-moderation-realtime-b`
  - `api-moderation-realtime-c`
  - `api-moderation-realtime-d`
  - `api-moderation-background`
  - `api-action`
- Prefer workspace-scoped validation before broader runs:
  - `npm run typecheck:contracts`
  - `npm run check:api`
  - `npm run check:miniapp`
  - `npm run typecheck --workspace @maxim/api`
  - `npm run typecheck --workspace @maxim/miniapp`
  - `npm run build --workspace @maxim/miniapp` for Vite build and bundle budgets
  - `npm test --workspace @maxim/api -- <spec-or-pattern>`
  - `npm run check:refactor-guards` for hotspot line-count regression guards
- Refactor guards intentionally track the real `*.legacy` implementation files and allow `.legacy` imports only from thin facade files. New code should import the public facade modules instead of legacy files directly.
- Runtime hot-path entry points should route through focused boundary services: `WebhookIngestionService`, `ModerationExecutionService`, `MaxActionDispatchService`, and `ManagedEntitiesDiscoveryService`. Keep controllers/processors/lease managers from calling legacy webhook, moderation, action, or admin refresh implementations directly.
- Admin runtime entry points should route through focused admin domain facades where available: `ManagedEntitiesService`, `AdminSettingsService`, `ManagedBroadcastService`, `ManualModerationService`, `ChannelDialogService`, and `ManagedGiveawayService`. These facades are the stable extraction boundary around legacy `AdminService`; avoid adding new controller/runner/private-bot calls directly to `AdminService` when a facade exists.
- Use `npm run check` for a full local CI-style pass before broad or risky changes.
- Do not run API validation commands that invoke `prisma generate` in parallel with each other
  (for example API typecheck and API Jest); concurrent generation can corrupt the ignored
  generated client and cause a false Prisma output-path failure.
- If `apps/api/prisma/schema.prisma` model/enum/database mappings change, include a migration before push; generator/datasource config-only changes do not need a migration.
- Prisma 7 CLI commands must use `apps/api/prisma.config.ts` from repo root or `prisma.config.ts` inside `apps/api`; in API containers call the workspace binary at `./apps/api/node_modules/.bin/prisma` from repo root. Runtime code should import Prisma through `apps/api/src/prisma/prisma-client.ts`, not `@prisma/client`, because the generated client lives in ignored `apps/api/src/generated/prisma/`.

## Local development

- Use Node 24 LTS for local and container work. Root `.nvmrc` pins `24`, and Dockerfiles copy `package-lock.json` and run `npm ci`; keep Docker dependency layers lockfile-based when editing them.
- Quick start:
  - `docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml up -d postgres redis`
  - `npm run dev:all`
- Focused dev servers:
  - `npm run dev:api`
  - `npm run dev:miniapp`
- Mini app iteration:
  - `npm run emulator:miniapp -- --device iphone --reuse-server`
  - `npm run emulator:miniapp:android -- --reuse-server`
  - `npm run emulator:miniapp -- --device iphone-se --reuse-server`
  - add `--route '<path>'` to jump directly to the screen under work
- For material UI changes, verify in the emulator or screenshots instead of judging only by code.
- Prefer checking both iPhone and Android sized previews, safe-area behavior, and keyboard behavior.
- For MAX mini app top safe-area fixes, do not apply `safeTop`/CSS safe-area values as a blanket content offset; some MAX WebViews already account for system UI. Prefer `visualViewport` plus actual element measurements for guards around floating top controls.
- Use `npm run screenshots:miniapp` after the layout is close. Local screenshot output lives under `artifacts/miniapp-screenshots/`.
- `npm run screenshots:miniapp` defaults to the production app URL; for local UI checks, set `MINIAPP_SCREENSHOT_BASE_URL` to the local Vite `/app/` URL.
- For focused screenshot checks, set `MINIAPP_SCREENSHOT_SCENARIOS`, `MINIAPP_SCREENSHOT_DEVICE`, and `MINIAPP_SCREENSHOT_BASE_URL` instead of running every preview scenario.
- Prefer local iteration for mini app CSS/TSX work. Avoid full Docker rebuilds unless container parity is the point of the task.
- For Android MAX WebView file pickers, use a real transparent `<input type="file">` overlay on the tapped control; hidden 1px inputs plus programmatic `click()`/`showPicker()` can fail to open the picker.
- For time-only mini app inputs, use shared `TimeField` instead of native `<input type="time">`; Android MAX WebViews can hide native picker action buttons.
- Chat and channel broadcast/autoposting compose screens share components but keep page-level footer/validation copy in `apps/miniapp/src/pages/settings-page.legacy.tsx` and `apps/miniapp/src/pages/channel-settings-page.tsx`; keep those labels synchronized.
- Keep home-card statistics prefetch imports lazy. Static importing events/stats API clients into `chats-page.tsx` counts against the startup JS budget.
- Keep mini app chat/channel statistics routes off heavy shared chunks: stats API clients should import `@maxim/contracts` types only, and stats pages should use focused route CSS instead of `lazy-pages.css`.
- Keep `VkParsingCard` lazy-loaded from chat/channel settings pages; static importing it into those settings routes can push the settings JS chunk over budget.
- For native mini app behavior, prefer shared helpers over raw bridge calls:
  - register overlay/sheet/editor close behavior with `apps/miniapp/src/lib/native-back.ts`
  - mirror durable device-local state through `apps/miniapp/src/lib/native-storage.ts`
  - use `apps/miniapp/src/lib/max-bridge.ts` for MAX links, native share/download, haptics, ready, viewport, and BackButton.
- Do not put global `touch-action` or root `overscroll-behavior-y` locks on `html`/`body` in the mini app; MAX mobile WebViews can stop page or nested home-list scrolling. Scope `touch-action: pan-y` / `-webkit-overflow-scrolling: touch` to the actual scroll container instead.

## Deploy and VPS

- Primary aliases, if configured locally:
  - `ssh maxim-vps`
  - `ssh maxim-vps-edge`
  - `ssh maxim-vps-legacy`
- Portable repo-local access from any device:
  - copy `infra/env/vps.env.example` to root `.env.vps` and keep it out of git
  - verify with `./infra/scripts/vps-connect.sh doctor`
  - use `./infra/scripts/vps-connect.sh shell|health|ps|logs <service>|deploy main [services...]`
  - use `./infra/scripts/vps-connect.sh monitor-readonly [duration-sec] [interval-sec]` for read-only production observation; it samples health, compose status, restart counts, public `/app/`, and filtered API role logs without reconciling webhooks or sending bot messages
  - `npm run vps -- <command>` and `npm run prod -- <command>` call the same wrapper
- GitHub Actions `Deploy` is manual-only (`workflow_dispatch`) and runs `infra/scripts/vps-pull-build-up.sh` on the VPS with optional branch/services inputs. Pushes to `main` should be validated by `CI`; use the local `vps-connect.sh deploy` wrapper for normal deployments unless GitHub-hosted runner SSH access is known to be allowed.
- If plain SSH stalls before the banner or times out, treat that as a Yandex Cloud access issue first. Prefer `yc compute ssh` as the recovery path and verify that the VM security group allows `22/tcp` from the current public IP.
- Keep Yandex Cloud service-account keys only in local ignored files or configured `yc` profiles, never in git.
- `maxim.play-team.ru` enters through the Yandex edge VM `maxim-site-edge-1` (`84.201.186.244`, `maxim-vps-edge`), where HAProxy TCP-proxies `80/443` to the backend VM private IP `10.130.0.29`; deploy and runtime rollback still run on the backend host (`maxim-vps`), not on edge. The edge public IP uses Yandex DDoS Protection/Qrator, so keep edge `eth0` MTU at `1450` (TCP MSS 1410 expectation) when touching network config.
- Before applying `infra/nginx/maxim.play-team.ru.conf`, compare it with `/etc/nginx/sites-enabled/maxim.play-team.ru.conf` on the backend VPS; the live config may include additional sibling-app routes such as `reshenie` and `karavan`, and a blind apply can remove them.
- Do not keep nginx config backups inside `/etc/nginx/sites-enabled`; nginx parses every file there as active config, so move backups under `/root` or another non-included directory before running `nginx -t`.
- Use `docker compose` only.
- Main prod stack: `infra/docker-compose.yml`
- Split/load-testing stack: `infra/docker-compose.scale.yml`
- Do not run both stacks at the same time.
- The `vps-pull-build-up*.sh` scripts are designed to run on the VPS host. From local machine, invoke them through SSH.
- If `/var/www/Chat_bot/.env` is missing, restore it from any running API role container before `docker compose exec` or `docker compose run`. Current scripts check role-based containers first and keep `infra-api-1` only as a legacy fallback.
- If `git pull --ff-only` is blocked by a dirty VPS worktree:
  - if current tracked contents already match `origin/<branch>`, `git stash push -> git pull --ff-only -> git stash drop` is acceptable
  - if local VPS changes differ from `origin/<branch>`, stop and report the conflict
- After a runtime deploy, always:
  - apply Prisma migrations
  - rebuild only changed services
  - recreate containers with `--force-recreate`
  - check `/api/health/live` and `/api/health/ready` locally and publicly
  - check `https://maxim.play-team.ru/app/` when mini app flows were touched
- During API deploys, `ready` can recover later than `live` while queues drain. Treat that as a recovery window first, not an instant regression.
- If `/app/` returns `502`, check `docker compose ps miniapp-static` first.

## MAX integration

- For MAX Bot API, Mini Apps, `init_data`, webhook behavior, and deep links, verify against current official MAX docs instead of memory.
- Source priority:
  1. `https://dev.max.ru/docs/`
  2. `https://dev.max.ru/docs-api/`
  3. `https://help.max.ru/help/bots`
  4. `https://github.com/max-messenger`
- MAX API calls must send the bot token in `Authorization: <token>`. Do not use token query parameters.
- Production event delivery must use Webhook. Long Polling is for development/testing only and cannot be active with a webhook subscription.
- Keep `platform-api.max.ru` traffic within the documented 30 rps global limit. Prefer existing queues, source tags, route priorities, and per-role env limits over ad hoc direct calls in hot paths.
- Managed broadcast/autoposting MAX calls should use `MAX_API_SOURCE_TAGS.MANAGED_BROADCAST`; user-triggered sends/tests use `interactive`, while scheduled/startup delivery runs use `background`. Scheduled/startup runners should honor `BackgroundRuntimeGovernorService` pause/slow decisions, and media uploads should stay on the same lane/source tag as the send.
- When creating or reconciling webhook subscriptions, treat `POST /subscriptions` as the transport source of truth: public HTTPS on port 443, trusted full-chain TLS, HTTP 200 within 30 seconds, and `X-Max-Bot-Api-Secret` validation when a `secret` is configured.
- Keep required webhook event coverage aligned with `apps/api/src/max/max-webhook-subscription.constants.ts`; current product flows depend on `message_created`, `message_edited`, `message_callback`, `user_added`, `user_removed`, `bot_added`, `bot_removed`, `bot_started`, and `chat_title_changed`.
- When users format text in the MAX client, treat formatting as `message.body.markup`, not as literal markdown typed by the user. Preserve or reconstruct formatting from `markup` when importing, editing, or republishing text.
- Treat MAX `markup.from` and `markup.length` as JavaScript string offsets for the original text. Do not remap them through `Array.from(...)` or code-point indexing, especially on emoji-rich text.
- For `max://user/<id>` mentions, use the user's resolved display name, including `first_name + last_name` when MAX sends split fields. Username-only or first-name-only labels can render as plain text in MAX clients.
- For admin contact links, prefer a direct HTTP(S) `profileUrl` when MAX provides one. For profile handoff URLs with a saved display label, render `Связь с админом: [Display Name](max://user/<id>)`; without a label, fall back to the HTTP(S) handoff URL because MAX can render arbitrary-label user mentions as plain text.
- Treat `initDataUnsafe` as convenience only. Authentication and trust must rely on validated `initData` / `WebAppData` using the MAX HMAC flow with the correct bot token.
- Keep bot tokens and webhook secrets only in VPS secrets or `.env`, never in git.
- Treat MAX mini apps as bot-scoped entry points. Do not assume the launch context identifies a managed target chat or channel on home; user-facing discovery should rely on allowlist, published snapshots, and recent `bot_added` signals.
- For comment/dialog buttons that must open an internal mini app screen, prefer bot-scoped `https://max.ru/<bot>?startapp=...` links over direct `open_app` `webApp` URLs. Keep direct `webApp` launch only as a fallback.
- In multi-bot flows, build internal mini app `startapp` links through the entry bot (`MAX_ENTRY_BOT_ID`, falling back to the default bot), not the bot currently executing the channel/chat action. Keep ordinary bot `start` links bot-specific.
- MAX `startapp` payloads are limited to 512 chars and `[A-Za-z0-9_-]`. Use `MaxBotLinkService`, `max-deep-link.util.ts`, and `apps/miniapp/src/lib/launch-route.ts` patterns instead of hand-built payloads.
- Sanction explanations, warnings, and published chat rules use dedicated `*AdminContactButtonEnabled` / `*AdminContactButtonUrl` settings to append the fixed `Связь с админом` markdown link; mute/ban notices do not include that admin-contact link. Keep profile handoff links out of generic custom button fields.
- In mini app code, use `window.WebApp.openMaxLink` only for `https://max.ru/...` deep links; use `openLink` for external links.
- Public comments and post-suggestion dialog routes opened from bot buttons should close the MAX
  mini app on the native BackButton instead of navigating to the mini app home screen.
- Public legal routes linked from bot greetings (`/app/legal/agreement` and `/app/legal/privacy`,
  including prefixed standalone app paths) must render without MAX `initData`; keep them before the
  mini app init-data gate when editing startup routing.
- In hot moderation paths, prefer targeted MAX access checks such as `getCurrentChatMemberAccess` or `getChatMembersAccess` over full admin-list fetches unless the feature truly needs the full roster.
- For `GET /chats/{chatId}/members`, send multiple `user_ids` as one comma-separated query value. Repeated `user_ids` parameters can be treated by MAX as only the first user.
- Managed-entity roster/admin sync should skip private direct dialogs (positive numeric chat IDs) unless the update is explicitly channel-typed; those IDs are not managed chat/channel roster targets.
- Terminal MAX access loss for managed chats/channels must route through `ManagedEntityAccessLossService`: treat `chat.denied`, `chat.not.found`, and bare `403/404` on send/read/lookup as lost access, keep `message.not.found` on old message deletes harmless, and stop/re-arm background work there instead of adding feature-local retry loops.
- In multi-bot access-loss handling, keep `BOT_DENIED` bot-scoped: do not mass-mark all access edges when the lost bot cannot be resolved, and do not surface entity-wide lost-access diagnostics or block background work while another runtime bot has fresh confirmed admin/owner access.
- After changing webhook host or domain, re-read `GET /subscriptions` and recreate the target subscription instead of assuming MAX updated its bound secret automatically.
- Keep `APP_BASE_URL` and `MAX_WEBHOOK_BASE_URL` aligned when the intended canonical prod host is `https://maxim.play-team.ru`.

## Data model and product rules

- Multi-bot chat ownership is modeled as `Chat.primaryBotId` plus `ChatBotMembership`. Treat `Chat.botId` as transitional compatibility only.
- Keep primary-bot access scoring centralized in `apps/api/src/max/max-bot-access-policy.util.ts`; routing and ownership repair should share it instead of duplicating permissions-snapshot scoring.
- Multi-bot UI, diagnostics, and tests should stay list-oriented. Avoid copy, caps, or assumptions that only one extra/standby bot exists.
- Multi-bot lifecycle policy lives in `apps/api/src/max/max-bot-state.util.ts`: `active` bots may execute actions, assist, and primary promotion; `draining` bots stay usable for webhooks/read/discovery only; `dormant`/`disabled` bots should not be selected for routes.
- Configured runtime bots are moderation-immune: do not kick/ban/mute/delete their messages, do not add them to global spammer observations/registry, and use `MaxBotRegistryService.isKnownBotUserId` / existing wrappers for bot-user checks instead of ad hoc ID comparisons.
- Managed entities are aggregated per unique chat or channel. Do not duplicate cards per bot.
- The public mini app should not expose internal primary, standby, or execution-owner details.
- Home readiness is user-scoped. Keep user-visible completion separate from long-running global discovery completion.
- Home visibility is access-edge scoped: show managed entities only from fresh `GRANTED` `managed_entity_access_edges` for the current user and runtime bot.
- Inline repair of missing managed-entity access edges must be allowlist-backed, preserve fresh denied edge states, and queue roster validation instead of trusting published snapshots alone.
- Legacy allowlist rows can lack `primaryBotId`, `botId`, and bot memberships; keep those rows eligible for access-edge repair instead of filtering them out before repair.
- Fresh `bot_added` candidates must not appear on home until MAX confirms that both the user and at least one runtime bot have admin rights.
- New managed chats should reach home through `bot_added` signals, recent bootstrap, allowlist, and published snapshots. Do not reintroduce launch-context assumptions for target chat discovery.
- When recent hydration resolves better chat metadata, keep the user-scoped published snapshot aligned so home does not linger on fallback titles like `Chat <id>`.
- Managed-entities refresh is async. Diagnose `CHAT` and `CHANNEL` separately and trust refresh state/cursor, not only the first response.
- `ChatSettings.antiSpamEnabled` is the fast per-chat sender flood guard for plain non-media messages only. The hard threshold is `MESSAGE_RATE_LIMIT` on the 6th non-media message within 6 seconds; exclude media attachments/batches from this counter, do not expose threshold controls, and hard-ban only matching non-media burst senders instead of routing them through configurable message-limit escalation.
- Required subscription moderation must check every configured chat/channel, not only a hot-path prefix. Keep checks bounded by `REQUIRED_SUBSCRIPTION_LOOKUP_CONCURRENCY`, and confirm stale missing membership cache with a fresh MAX lookup before delete/sanction.
- Required subscription settings must let admins pick managed chats and channels from fresh managed-entity lists; manual refresh should refresh both entity types, with external links kept as the fallback for entities outside the admin's list.
- Night mode and manual group close stay webhook-only delete gates for incoming user messages: delete non-admin messages in `handleUpdate`, do not add `listMessages` polling, per-chat sleeps, user-message-triggered bot notices, or greeting sends while the chat is closed. Night mode close/open notices are schedule-driven transition work in the background role, not reactions to user messages.
- Stop-words settings are their own section and include both `messageLimitsBlockedWords` and `messageLimitsBlockedDomains`; blocked domains match exact hosts and subdomains independently of link moderation policy, but an explicit link/domain allowlist match suppresses the blocked-domain hit for that allowed link.
- Link allowlist `DOMAIN` rules (`domain:example.com`) match the exact host and its subdomains; `EXACT` rules stay URL-specific. Mini app allowlist entry creation defaults to `DOMAIN` so host-only inputs do not become exact root links by accident.
- Moderation dashboard/feed and membership activity feed should read from maintained read models (`chat_moderation_feed_items`, `chat_moderation_affected_user_hours`, `chat_membership_activity_feed_items`) instead of rebuilding from raw events on each request.
- Global spammer fanout tracking is silent: do not send chat warnings for cross-chat mass posting; use registry/candidate signals plus enforcement or review instead.
- Global spammer registry decisions stay cautious: local admin `BLOCK`/`ALLOW` applies only to that admin scope and is only a weak global reputation signal; natural bans are capped reputation signals, and bans/kicks caused by global-spammer enforcement must not feed back as new evidence.
- In spammer dossier UX, campaign `observationsCount` is cluster-wide scale; show per-user signal counts from observations, graph signals, and campaign-member `userObservationsCount` separately from total campaign observations.
- Keep spammer review lists lightweight: use `includeProfiles=false` and `includeObservations=false` for candidate lists, then load profile/details lazily through the diagnostics sheet.
- Commercial-ad detection lives in `apps/api/src/moderation/commercial/`. Changes to scoring, suppressors, subtypes, campaign lift, or action policy should update the commercial fixtures/benchmark and keep `COMMERCIAL_AD` metadata explainable.
- Global spammer observations, scoring, suppression, graph signals, source reputation, policy diagnostics, review decisions, and expired-row archiving live in `GlobalSpammerIntelligenceService`; active `global_spammers` rows must have a future `expiresAt` because nullable legacy rows are treated as expired. Runtime sanctions should be gated by `evaluatePolicy`/active confirmed decisions, and admin review/diagnostic endpoints should stay in `ManualModerationService` instead of growing legacy `AdminService`. Use `npm run spammers:archive-expired --workspace @maxim/api -- --dry-run --json` before deleting expired registry rows.
- Developer Super Ban uses existing `global_spammers` rows with `DEVELOPER_FORCED`, not a separate blacklist table. Keep the Redis `global-spammer:developer-forced:*` fast path and warm-marker self-heal aligned with `DEVELOPER_FORCED` registry rows, and keep forced entries above local admin `ALLOW` and `deleteSpammersEnabled=false`. It should not synchronously fan out across every managed chat; handle the source chat immediately, send a DB-estimated coverage notice, and let later webhook moderation enforce the blacklist when bots see the user.
- Use `npm run moderation:audit-commercial --workspace @maxim/api -- --since <iso> --until <iso> --limit <n>` for local commercial-filter audits. On VPS run the built script inside `api-admin`, for example `docker compose -p infra -f infra/docker-compose.yml exec -T api-admin node apps/api/dist/apps/api/src/scripts/audit-commercial-filter.js --since <iso> --until <iso> --limit <n>`.
- For sanitized commercial corpus exports, pass `--export-corpus-jsonl <path>` to the audit command and add `--export-all-corpus` when validating corpus gates so stable-clear negative candidates are included. Validate with `npm run moderation:validate-commercial-corpus --workspace @maxim/api -- --input <path>`; relative inputs resolve from `apps/api`, so use `src/...` or an absolute path.
- Channel statistics should open from cached/read-model data. Use `channel_stats_bucket_rollups` for membership, posts, views, and reactions; keep raw `channel_posts` reads limited to compact top-post/top-reaction details. Do not block `GET /channels/:chatId/stats` on MAX refresh; queue stale refresh in the background and request `includeActivityPreview=false` for the mini app's first stats paint.
- Channel statistics audience graphs should plot joined/left net growth from `series.membership`; use `series.participants` only as total-audience context. Period views should use observed `viewsDelta` when it exists, with `latestTotal`/`viewsTotal` only as the no-delta fallback.
- Channel statistics screens should stay factual. Do not add "What to do next", smart recommendations, pseudo-AI advice, or coaching copy; prefer neutral metrics, freshness/source coverage, charts, top posts, and best publishing windows.
- VK parsing is available for managed chats and channels. Mini app visibility comes from the server capability endpoint; do not reintroduce a hardcoded mini app allowlist, user allowlist, or channel-only UI. Backend endpoints must enforce managed entity admin access. Current supported VK import media are text, photos, and links only, and source sync runs through the BullMQ `vk-parsing-sync` queue with DB source leases.
- VK parsing requires `VK_SERVICE_TOKEN` in API environment. Capability should still verify admin access first, then return `NOT_CONFIGURED` for admins when the token is missing; working endpoints should fail early with a clear 503 instead of reaching VK HTTP calls.
- Keep `VkParsingService` as the thin VK parsing facade. Put access/capability in `VkParsingAccessService`, source CRUD/scheduler in `VkSourceService`, source sync/import leases in `VkSyncService`, manual/autopublish delivery in `VkPublishService`, feed/summary mapping in `VkParsingFeedService`, and VK HTTP/rate-limit retry in `VkApiClientService`.
- VK source identity is `vk_parsing_sources.wallOwnerId`. When resolving or syncing sources, use the wall owner from `wall.items[].owner_id` and ignore imported posts whose `owner_id` differs from the saved source wall owner; do not trust the first `groups` item from extended VK responses as the source identity.
- VK photo CDN URLs from `photo.sizes` can expire or 404 independently. Keep same-photo size candidates tied to the VK media identity and retry another size before failing a publish; do not reuse a failed media-cache row for a different URL of the same identity unless it has a reusable MAX upload payload.
- VK parsing source leases use `syncLockedBy`, `syncAttemptCount`, `syncLockDeadlineAt`, and `syncHeartbeatAt`; scheduler recovery should prefer the deadline field and keep diagnostics exposing stale sync locks.
- VK parsing source circuit breaker state lives on `vk_parsing_sources` (`terminalFailureCount`, `circuitOpenedAt`, `circuitReasonCode`, `circuitReason`, `circuitRetryAt`). Scheduled sync must skip open circuits; manual refresh/source re-add can clear and retry them, and diagnostics/dashboard should keep the reason visible.
- Use `npm run vk-parsing:diagnose --workspace @maxim/api -- --json --limit 20` for VK parsing source/media/publish/queue diagnostics; pass `--window-hours` to change the recent-error window and ensure `REDIS_URL` is available for BullMQ counts.
- VK parsing automation settings are stored per managed entity in `vk_parsing_settings`. Scheduled/manual sync can autopublish newly imported posts, but the initial `source-added` backfill and the first successful source sync with no previous `lastSuccessAt` must not autopublish old fetched posts. Autopublish eligibility must require `autoPublishEnabledAt` plus a real VK publish timestamp at or after that baseline; do not fall back to local import time for posts with missing VK dates.
- VK autoposting is controlled by both managed-entity settings and per-source settings. Source-level `autoPublishEnabled`, baseline, mode, daily/min-interval limits, quiet hours, and priority must be respected before queueing; queued posts use `publishScheduledAt` and must be rechecked by the publish worker before sending.
- VK autoposting should treat `BackgroundRuntimeGovernorService` `pause` decisions as deferrable, but `slow` decisions must not fully starve single publish jobs. Count `publishAttemptCount` only when a job reaches a real MAX publish attempt, not when it is locked or deferred.

## Repo hygiene

- Do not commit secrets, local exports, dumps, build artifacts, or one-off debug files.
- Safe cleanup targets include `dist/`, `coverage/`, screenshot artifacts, and temporary root debug exports.
- Keep local agent/tooling traces ignored. Repo-local Codex leftovers such as `.codex` must not remain tracked or untracked at handoff.
- Before finalizing work, run `git status --short` and leave the tree clean: commit intentional changes, and remove or ignore transient files.
- At handoff, update `AGENTS.md` when the completed task revealed a stable repo workflow, validation command, deploy rule, service name, or product invariant that future agents should reuse. Do not add one-off incident notes.
- When runtime topology, deploy scripts, service names, or core workflows change, update this file in the same line of work.
