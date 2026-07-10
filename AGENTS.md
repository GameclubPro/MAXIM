# Agent Notes

## Purpose

- This file should accelerate work, not override the repo.
- If `AGENTS.md` conflicts with `package.json`, Docker Compose, scripts, or the current code, trust the repo and update this file.
- Keep this file short, stable, and repo-verified. Do not store temporary incidents, dated prod observations, or assumptions that will drift.

## Project shape

- Monorepo workspaces:
  - `apps/api`: NestJS/Fastify API, Prisma, BullMQ workers, Postgres, Redis.
  - `apps/miniapp`: React 19 + Vite MAX mini app. MAX Bridge is loaded from `https://st.max.ru/js/max-web-app.js`.
  - `apps/admin`: closed React/Vite Safety Desk for owner-side moderation review; not a MAX mini app.
  - `packages/contracts`: shared Zod/API contracts. Contract changes normally require matching API, mini app, tests, and typechecks.
- Keep `packages/contracts` subpath exports, root `tsconfig.base.json` paths, and `apps/api/jest.config.cjs` mappers in sync so API Jest resolves ESM contract sources correctly.
- Production API uses one shared API image split by `APP_ROLE`; nginx routes public health/webhooks to `api-ingress`, public `/api/v1/` and local admin/API traffic to `api-admin`, and moderation/action/enqueue roles process queues.
- Split API services also declare `APP_SERVICE_NAME`; keep the typed service/queue topology in `apps/api/src/runtime/runtime-topology.ts` aligned with compose service env.
- Production mini app is served under `/app/`.
- Production Safety Desk is served on `https://admin.major-maksimov.ru/` through nginx Basic Auth and `admin-static` on `127.0.0.1:3004`.

## Core workflow

- For runtime-affecting changes in `apps/api`, `apps/miniapp`, `packages/contracts`, Prisma, Docker, or MAX integration, the default finish is: local validation plus VPS deploy, unless the user explicitly says not to deploy.
- Docs, `AGENTS.md`, `README.md`, test-only changes, and cleanup changes do not require VPS deploy unless the user asks for it.
- CDN/app2 mini app delivery is paused. Hard rule for routine mini app work: no CDN/app2/Object Storage deploys, publishes, smokes, fallback plans, or checklist items. Treat `https://major-maksimov.ru/app/` as the only production mini app deploy/smoke target.
- After every completed task, do a short self-learning pass before handoff:
  - fix small issues revealed by the work while the context is still fresh, if they are clearly in scope and low risk
  - add or update `AGENTS.md` only with durable, repo-verified, useful knowledge that will speed future work or prevent repeated mistakes
  - prefer stable commands, service names, deploy rules, product invariants, integration quirks, and validation shortcuts
  - do not record noise, guesses, temporary observations, one-off command output, secrets, personal notes, or details already obvious from nearby code
  - if a lesson is too specific to the changed code, encode it as a test, type, helper, or code comment flag instead of an agent note
  - use code comment flags only for important invariants or sensitive edit zones; prefix new flags with `FLAG:` so future agents know to pause before editing that block
  - before changing a flagged block, read the flag and think through the invariant twice
  - do not delete existing flags incidentally; remove or rewrite them only as an intentional improvement when the old comment is obsolete or misleading
- Prefer repo scripts over long manual sequences:
  - local push: `./infra/scripts/local-commit-push.sh "<message>" main`
  - local VPS deploy wrapper: `./infra/scripts/vps-connect.sh deploy main [services...]`
  - local runtime rollback wrapper: `./infra/scripts/vps-connect.sh rollback-runtime <git-ref> [services...]`
  - direct VPS deploy script, from the VPS host only: `./infra/scripts/vps-pull-build-up.sh main [services...]`
  - direct runtime rollback script, from the VPS host only: `./infra/scripts/vps-runtime-rollback.sh <git-ref> [services...]`
- `./infra/scripts/local-commit-push.sh` excludes `AGENTS.md` by default. Use `--include-agents` only when you intentionally want to commit agent-note changes. In a dirty tree it stages tracked changes broadly, so for partial commits use explicit `git add <paths> && git commit && git push`.
- Rebuild only changed services. In practice that is usually `miniapp-static` and/or the shared API image.
- `https://major-maksimov.ru/app/` is served by `miniapp-major-static`; `miniapp-static` serves `https://maxim.play-team.ru/app/`. For routine mini app production deploys while Major is primary, deploy `miniapp-major-static`.
- For closed admin/Safety Desk changes, deploy `admin-static`. It is intentionally built without Docker cache during VPS deploys so the Vite-baked `ADMIN_ACCESS_CODE` from `/var/www/Chat_bot/.env` is refreshed; do not print that code. Server Basic Auth password is stored on the VPS at `/root/maxim-admin-basic-auth-password.txt`.
- Closed Safety Desk/support API calls use same-origin `https://admin.major-maksimov.ru/api/v1/...`, proxied by `infra/nginx/admin.major-maksimov.ru.conf` to `api-admin`; the API guard requires admin nginx `X-Forwarded-Host` plus Basic Auth `X-Remote-User`, and public nginx sites must keep `/api/v1/safety-desk` and `/api/v1/support-requests` denied before the generic `/api/v1/` proxy. Apply the admin nginx config separately with `./infra/scripts/vps-apply-major-admin-site.sh maxim-vps` when changing that route.
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
- `npm run screenshots:miniapp` defaults to `https://major-maksimov.ru/app/`; for current production-origin UI checks, set `MINIAPP_SCREENSHOT_BASE_URL=https://major-maksimov.ru/app/`; for local UI checks, set it to the local Vite `/app/` URL.
- For focused screenshot checks, set `MINIAPP_SCREENSHOT_SCENARIOS`, `MINIAPP_SCREENSHOT_DEVICE`, and `MINIAPP_SCREENSHOT_BASE_URL` instead of running every preview scenario.
- Native mini app emulator/screenshots (`--target native`) install the safe MAX Bridge visual shim by default; use `--no-max-bridge` or `MINIAPP_SCREENSHOT_MAX_BRIDGE=0` only for browser-without-bridge checks.
- Prefer local iteration for mini app CSS/TSX work. Avoid full Docker rebuilds unless container parity is the point of the task.
- Direct mini app CSS imports from TS/TSX must be fully wrapped in an explicit `@layer` block; `apps/miniapp/src/styles.css` is the only global CSS entrypoint and must keep imports as `@import ... layer(...)`. Use `npm run check:miniapp-css` for the focused guard.
- For Android MAX WebView file pickers, use a real transparent `<input type="file">` overlay on the tapped control; hidden 1px inputs plus programmatic `click()`/`showPicker()` can fail to open the picker.
- For time-only mini app inputs, use shared `TimeField` instead of native `<input type="time">`; Android MAX WebViews can hide native picker action buttons.
- Chat and channel broadcast/autoposting compose screens share components but keep page-level footer/validation copy in `apps/miniapp/src/pages/settings-page.legacy.tsx` and `apps/miniapp/src/pages/channel-settings-page.tsx`; keep those labels synchronized.
- Chat settings section apply targets must fail safe to the current chat. Keep `applySettingsTargetSchema`, mini app apply-target defaults, and preview transport defaults aligned on `current`; applying a section to all chats must require an explicit `mode: 'all'`.
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
  - if agent SSH is blocked after an IP change, use `./infra/scripts/vps-connect.sh ensure-ssh`; with `MAXIM_YC_SSH_SECURITY_GROUP_ID` configured it authorizes the current `/32` or `MAXIM_YC_SSH_SOURCE_CIDR`, then runs `doctor`
  - use `./infra/scripts/vps-connect.sh shell|health|ps|logs <service>|deploy main [services...]`
  - use `./infra/scripts/vps-connect.sh monitor-readonly [duration-sec] [interval-sec]` for read-only production observation; it samples health, compose status, restart counts, public `/app/`, and filtered API role logs without reconciling webhooks or sending bot messages
  - `npm run vps -- <command>` and `npm run prod -- <command>` call the same wrapper
- GitHub Actions `Deploy` is manual-only (`workflow_dispatch`) and runs `infra/scripts/vps-pull-build-up.sh` on the VPS with optional branch/services inputs. Pushes to `main` should be validated by `CI`; use the local `vps-connect.sh deploy` wrapper for normal deployments unless GitHub-hosted runner SSH access is known to be allowed.
- If local GitHub push/fetch is blocked but the VPS can reach GitHub, use the repo-scoped deploy key on the VPS (`~/.ssh/github_maxim_deploy_ed25519`) as a fallback. First verify the VPS repo is clean and at the intended commit with `./infra/scripts/vps-connect.sh exec 'git log -1 --oneline --decorate && git status --short --branch'`, then push from the VPS with `./infra/scripts/vps-connect.sh exec 'GIT_SSH_COMMAND="ssh -i ~/.ssh/github_maxim_deploy_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new" git push git@github.com:GameclubPro/MAXIM.git main:main'`. Never print or copy private key material.
- If plain SSH stalls before the banner or times out, treat that as a Yandex Cloud access issue first. Prefer `yc compute ssh` as the recovery path and verify that the VM security group allows `22/tcp` from the current public IP.
- Keep Yandex Cloud service-account keys only in local ignored files or configured `yc` profiles, never in git.
- `maxim.play-team.ru` enters through the Yandex edge VM `maxim-site-edge-1` (`84.201.186.244`, `maxim-vps-edge`), where HAProxy TCP-proxies `80/443` to the backend VM private IP `10.130.0.29`; deploy and runtime rollback still run on the backend host (`maxim-vps`), not on edge. The edge public IP uses Yandex DDoS Protection/Qrator, so keep edge `eth0` MTU at `1450` (TCP MSS 1410 expectation) when touching network config.
- Because edge HAProxy passes TLS through at TCP level, its client/server timeouts must cover the longest public API request; path-specific exceptions belong at backend nginx, not the edge.
- The `maxim.play-team.ru` Let's Encrypt lineage intentionally covers only `maxim.play-team.ru` and `hook.maxim.play-team.ru`; do not add `www.maxim.play-team.ru` unless DNS and nginx are configured for it, because NXDOMAIN for `www` breaks renewal.
- Use `https://major-maksimov.ru/` as the primary user-facing host and `https://major-maksimov.ru/app/` as the only routine production mini app URL. Keep CDN/Object Storage/app2 logic dormant: do not publish Object Storage, adjust Yandex CDN delivery, run `app2.major-maksimov.ru` smokes, or include CDN/app2 fallback steps in routine plans.
- `major-maksimov.ru`, `www.major-maksimov.ru`, and `app.major-maksimov.ru` currently enter through the Yandex edge IP `84.201.186.244`; `app.major-maksimov.ru` should redirect to the canonical `major-maksimov.ru`. Keep `/app/` as the direct/origin mini app path and keep the root page clear of internal infrastructure details. Do not assume this edge is reachable on every restricted LTE operator: it can work on Megafon/Wi-Fi and still fail on MTS/Beeline before HTML, JS, redirects, TLS app logic, or nginx routing are usable.
- Archived CDN/app2 notes below are not active instructions. For current work, ignore CDN/app2/Object Storage paths and use only `https://major-maksimov.ru/app/` for production mini app deploy/smoke.
- Historical app2 context: `app2.major-maksimov.ru/app/` was the operator-reachable production mini app shell for restricted LTE via Yandex CDN and Object Storage. Do not deploy, publish, or smoke it for current work.
- Historical Object Storage context: the old app2 shell used `VITE_PUBLIC_BASE_PATH=/app/`, hash routing, `api-cdn.flex-craft.ru`, and Object Storage under `s3://flex-craft-canary-20260608/app/`. Do not use this path for current work.
- `api-cdn.flex-craft.ru` is a Yandex CDN API front door and only supports GET/HEAD/OPTIONS at the CDN layer. Mini app POST/PUT/PATCH/DELETE calls are expected to use the GET mutation tunnel (`apps/api/src/system/miniapp-mutation-tunnel.controller.ts`, `apps/miniapp/src/lib/api/transport-mutation-tunnel.ts`). When adding or changing a mini app write endpoint, update the tunnel allowlist and tests; otherwise it can work on direct `major-maksimov.ru` but fail through the restricted-LTE CDN path.
- CDN-shell auth uses `Authorization: InitData <initData>` and CORS must allow `authorization, content-type`. Keep this aligned in API guards, transport tests, and CDN static headers.
- Historical restricted-LTE notes are preserved only for context. Current production checks must not use app2/CDN/Object Storage; check `https://major-maksimov.ru/app/` only.
- The VK Cloud VM proxy is only a reachability test path now; do not point public DNS at it unless testing confirms that exact public IP is operator-reachable. Its nginx upstream still proxies `/app/` and `/api/` to the Yandex origin `84.201.186.244:443`. Public root assets live under `infra/www/major-maksimov/`, VK nginx config lives under `infra/vk-proxy/`, and `./infra/scripts/vk-apply-major-proxy.sh [ubuntu@ip]` reapplies it for `--resolve` checks.
- Current SSH fallback jump is `maxim-vk-jump` -> `ubuntu@94.139.246.178` with local key `~/.ssh/id_rsa_vk_maxim_proxy`; `maxim-vps-via-vk` and `maxim-vps-edge-via-vk` use it as `ProxyJump`. Keep `ConnectionAttempts` above 1 for this host because VK SSH can briefly time out during banner exchange.
- When using the VK service account file `vk codex`, never print secrets. Prefer `https://public.infra.mail.ru` endpoints for OpenStack API calls from this local network; the catalog's `infra.mail.ru` endpoints often time out here.
- The current VK Cloud service account can create a direct `internet` VM port but cannot create or update explicit `fixed_ips` on that shared network; attempts to force a `217.16.28.0/22` address require VK support/sales allocation rather than local OpenStack CLI changes.
- Create/rebuild the VK VM with OpenStack `--use-config-drive` so SSH keys and network config are injected on the direct `internet` network. VK proxy checks should use `curl --resolve major-maksimov.ru:443:<vk-ip>` unless public DNS is intentionally moved for a short test. Do not switch `major-maksimov.ru` to a VK Cloud 185.241.* IP for restricted mobile networks unless testing confirms that exact IP is operator-reachable; current production webhooks use `MAX_WEBHOOK_BASE_URL=https://major-maksimov.ru`, so do not point them at proxy/test domains unless intentionally moving webhooks.
- In this VK project, image-boot server creates can fail with `Request of image ... got BadRequest`; boot-from-volume with `block_device_mapping_v2` from the same image and `delete_on_termination=true` is the reliable VM creation pattern observed for Ubuntu jump/proxy instances.
- Before applying `infra/nginx/maxim.play-team.ru.conf`, compare it with `/etc/nginx/sites-enabled/maxim.play-team.ru.conf` on the backend VPS; the live config may include additional sibling-app routes such as `reshenie` and `karavan`, and a blind apply can remove them.
- Do not keep nginx config backups inside `/etc/nginx/sites-enabled`; nginx parses every file there as active config, so move backups under `/root` or another non-included directory before running `nginx -t`.
- Use `docker compose` only.
- Main prod stack: `infra/docker-compose.yml`
- Split/load-testing stack: `infra/docker-compose.scale.yml`
- Do not run both stacks at the same time.
- Keep postgres `shm_size` in compose comfortably above `shared_buffers` (currently `512m` for
  `shared_buffers=128MB`); reducing it can surface PostgreSQL `53100` shared-memory errors under
  admin/suggestion queries.
- Keep production API Prisma pool caps aligned with `apps/api/src/config/production-compose-prisma-pool.spec.ts`;
  for `api-action` pressure incidents, prefer lowering concurrency/batch sizes and adding governor
  checks before raising Postgres connection caps.
- Redis stores BullMQ queues, delayed jobs, locks, and runtime snapshots under `/data`; main and
  scale compose pin it to `redis_data:/data`. The scale deploy script preflights
  `infra-scale_redis_data` before stopping the main stack. Avoid routine Redis recreation unless
  the current RDB/AOF state is intentionally preserved and queues are checked first; deploy
  API-only changes with `docker compose up -d --no-deps --force-recreate ...` when Redis must stay
  untouched.
- After Redis volume restores/merges, audit schedule-driven BullMQ queues before restarting
  workers. For `night-mode-transitions`, rebuild from DB future occurrences instead of restoring
  stale due jobs blindly, verify `wait`/`active`/`failed` are empty and `delayed_due_now=0`, and
  treat persisted `NIGHT_MODE_CLOSE_NOTICE` events as the idempotency source.
- The `vps-pull-build-up*.sh` scripts are designed to run on the VPS host. From local machine, invoke them through SSH.
- If multi-service API `docker compose build` stalls after the TypeScript build while buildx/bake
  resolves provenance, build the shared API image directly on the VPS with
  `docker buildx build --load --provenance=false -t infra-api-ingress:latest -f apps/api/Dockerfile .`,
  then tag it to every `infra-api-*` role image before migrations and `--force-recreate`.
- If `/var/www/Chat_bot/.env` is missing, restore it from any running API role container before `docker compose exec` or `docker compose run`. Current scripts check role-based containers first and keep `infra-api-1` only as a legacy fallback.
- If `git pull --ff-only` is blocked by a dirty VPS worktree:
  - if current tracked contents already match `origin/<branch>`, `git stash push -> git pull --ff-only -> git stash drop` is acceptable
  - if local VPS changes differ from `origin/<branch>`, stop and report the conflict
- After a runtime deploy, always:
  - apply Prisma migrations
  - rebuild only changed services
  - recreate containers with `--force-recreate`
  - check `/api/health/live` and `/api/health/ready` locally on the VPS, and check only `/api/health/live` publicly; public `/api/health/ready` is intentionally hidden
  - check `https://major-maksimov.ru/app/` when mini app flows were touched
  - do not run CDN/app2/Object Storage mini app smokes for routine work; use only `https://major-maksimov.ru/app/`
- During API deploys, `ready` can recover later than `live` while queues drain. Treat that as a recovery window first, not an instant regression.
- If the current Major `/app/` returns `502`, check `docker compose ps miniapp-major-static` first; use `miniapp-static` for `maxim.play-team.ru/app/`.

## MAX integration

- For MAX Bot API, Mini Apps, `init_data`, webhook behavior, and deep links, verify against current official MAX docs instead of memory.
- Source priority:
  1. `https://dev.max.ru/docs/`
  2. `https://dev.max.ru/docs-api/`
  3. `https://help.max.ru/help/bots`
  4. `https://github.com/max-messenger`
- MAX API calls must send the bot token in `Authorization: <token>`. Do not use token query parameters.
- Production event delivery must use Webhook. Long Polling is for development/testing only and cannot be active with a webhook subscription.
- Keep `platform-api2.max.ru` MAX API traffic within the documented 30 rps global limit. Prefer existing queues, source tags, route priorities, and per-role env limits over ad hoc direct calls in hot paths.
- `platform-api2.max.ru` presents the Russian Trusted CA chain. The API runtime image carries the Gosuslugi Russian Trusted Root/Sub CA PEMs under `infra/certs/` and sets `NODE_EXTRA_CA_CERTS`; keep that when changing API Docker images.
- MAX admin permission snapshots are entity-type sensitive: `write` is delete-capable for messages in group chats and lets bots post to channels, but channel post edit/delete require `edit`/legacy `edit_message` and `delete`/legacy `delete_message`; do not treat `write` as enough for channel auto-post button edits.
- Managed broadcast/autoposting MAX calls should use `MAX_API_SOURCE_TAGS.MANAGED_BROADCAST`; user-triggered sends/tests use `interactive`, while scheduled/startup delivery runs use `background`. Scheduled/startup runners should honor `BackgroundRuntimeGovernorService` pause/slow decisions, and media uploads should stay on the same lane/source tag as the send.
- MAX message send timeouts are ambiguous because MAX may have accepted the message before the client timed out. Do not auto-retry sends after an attempted outbound message without a stored `remoteMessageId`; uploads/media preparation may retry transport timeouts, but message sends should wait for manual review or a quarantine/ledger path.
- VK parsing imports at most one direct HTTPS `video.files.mp4_*` URL per VK post. If `wall.get` omits direct video files, enrich the attachment through `video.get` before marking it unsupported. Do not scrape VK `player`, accept `external`/HLS as a video file, or mix photos and video in one MAX publish payload; when a supported video is present, publish video and drop photos from that post's publishable media set.
- When creating or reconciling webhook subscriptions, treat `POST /subscriptions` as the transport source of truth: public HTTPS on port 443, trusted full-chain TLS, HTTP 200 within 30 seconds, and `X-Max-Bot-Api-Secret` validation when a `secret` is configured.
- Keep required webhook event coverage aligned with `apps/api/src/max/max-webhook-subscription.constants.ts`; current product flows depend on `message_created`, `message_edited`, `message_callback`, `user_added`, `user_removed`, `bot_added`, `bot_removed`, `bot_started`, and `chat_title_changed`.
- MAX Bot API has no native poll publication endpoint; managed channel polls use callback-button
  messages. Keep callback replay dedupe bounded and per-poll pseudonymous. For `ANONYMOUS` polls,
  store only the identity hash needed for revoting/dedupe, keep raw/profile identity fields null,
  and never expose voter lists through poll APIs.
- When users format text in the MAX client, treat formatting as `message.body.markup`, not as literal markdown typed by the user. Preserve or reconstruct formatting from `markup` when importing, editing, or republishing text.
- Treat MAX `markup.from` and `markup.length` as JavaScript string offsets for the original text. Do not remap them through `Array.from(...)` or code-point indexing, especially on emoji-rich text.
- For `max://user/<id>` mentions, use the user's resolved display name, including `first_name + last_name` when MAX sends split fields. Username-only or first-name-only labels can render as plain text in MAX clients.
- For admin contact links, prefer a direct HTTP(S) `profileUrl` when MAX provides one. For profile handoff URLs with a saved display label, render `Связь с админом: [Display Name](max://user/<id>)`; without a label, fall back to the HTTP(S) handoff URL because MAX can render arbitrary-label user mentions as plain text.
- In multi-bot handoff/dialog links, use the same resolved `botId` for both signed compact start payloads/dialog tokens and the `https://max.ru/<bot>?start=...` URL; a correct-looking bot URL with a default-token signature can fail validation.
- Treat `initDataUnsafe` as convenience only. Authentication and trust must rely on validated `initData` / `WebAppData` using the MAX HMAC flow with the correct bot token.
- Keep bot tokens and webhook secrets only in VPS secrets or `.env`, never in git.
- Treat MAX mini apps as bot-scoped entry points. Do not assume the launch context identifies a managed target chat or channel on home; user-facing discovery should rely on allowlist, published snapshots, and recent `bot_added` signals.
- For comment/dialog buttons that must open an internal mini app screen, prefer bot-scoped `https://max.ru/<bot>?startapp=...` links over direct `open_app` `webApp` URLs. Keep direct `webApp` launch only as a fallback.
- In multi-bot flows, build internal mini app `startapp` links through the entry bot (`MAX_ENTRY_BOT_ID`, falling back to the default bot), not the bot currently executing the channel/chat action. Keep ordinary bot `start` links bot-specific.
- MAX `startapp` payloads are limited to 512 chars and `[A-Za-z0-9_-]`. Use `MaxBotLinkService`, `max-deep-link.util.ts`, and `apps/miniapp/src/lib/launch-route.ts` patterns instead of hand-built payloads.
- Profile/admin-contact handoff links (`pmh-` legacy and compact `pm2_`) are dedicated flows, not generic bot buttons; keep generic button schemas/sanitizers rejecting both prefixes, and keep resolved profile cache keys scoped to the route bot when the handoff URL is bot-specific.
- `MAX_REQUIRED_WEBHOOK_UPDATE_TYPES` is the product-required subscription subset of the official MAX `Update` list. When adding official-only lifecycle events such as `bot_stopped`, `dialog_removed`, or `message_removed`, add parser/queue/product handling intentionally instead of silently expanding subscriptions.
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
- Keep `APP_BASE_URL` and `MAX_WEBHOOK_BASE_URL` aligned with the intended canonical prod host; current production uses `https://major-maksimov.ru`.

## Data model and product rules

- Multi-bot chat ownership is modeled as `Chat.primaryBotId` plus `ChatBotMembership`. Treat `Chat.botId` as transitional compatibility only.
- Keep primary-bot access scoring centralized in `apps/api/src/max/max-bot-access-policy.util.ts`; routing and ownership repair should share it instead of duplicating permissions-snapshot scoring.
- In multi-bot permission audits, do not treat a weak/denied primary or a bot without rights as a chat failure when another active executable bot has the required rights. One confirmed eligible bot is enough; investigate only cases where the route candidate list is empty, every candidate is denied/action-limited, or fresh 403/backoff prevents the eligible bot from being used.
- Multi-bot UI, diagnostics, and tests should stay list-oriented. Avoid copy, caps, or assumptions that only one extra/standby bot exists.
- Multi-bot lifecycle policy lives in `apps/api/src/max/max-bot-state.util.ts`: `active` bots may execute actions, assist, and primary promotion; `draining` bots stay usable for webhooks/read/discovery only; `dormant`/`disabled` bots should not be selected for routes.
- `GET /v1/system/bots` is a read-only fleet snapshot for system admins. Keep it on local sources only: configured bot registry, cached webhook/queue/MAX API metrics, and Prisma aggregates with the same managed-entity filter as ownership foundation; do not add live MAX access checks or execution-planner refreshes there.
- Webhook event `dedupKey` values must stay bot-scoped (`botId:updateId`) so the same MAX update delivered to several bot webhooks cannot discard the owner bot delivery. Dedupe logical side effects downstream by message/update semantics instead.
- Configured runtime bots are moderation-immune: do not kick/ban/mute/delete their messages, do not add them to global spammer observations/registry, and use `MaxBotRegistryService.isKnownBotUserId` / existing wrappers for bot-user checks instead of ad hoc ID comparisons.
- Managed entities are aggregated per unique chat or channel. Do not duplicate cards per bot.
- Managed poll list endpoints must select and expose persisted `imageCount` only; raw poll `images` belong exclusively to the details endpoint.
- The public mini app should not expose internal primary, standby, or execution-owner details. Use `sanitizePublicManagedEntityHeader` for public headers and preserve only public counters/flags such as `botCount` and `hasSharedAutomation`.
- Home readiness is user-scoped. Keep user-visible completion separate from long-running global discovery completion.
- Home visibility is access-edge scoped: show managed entities only from fresh `GRANTED` `managed_entity_access_edges` for the current user and runtime bot.
- Settings/read access must stay aligned with home visibility: if a managed entity is admitted by a fresh `GRANTED` access edge and an active runtime bot membership, do not let a transient or bot-scoped MAX `403` downgrade it to `bot_denied` or prune user access before checking that edge.
- Inline repair of missing managed-entity access edges must be allowlist-backed, preserve fresh denied edge states, and queue roster validation instead of trusting published snapshots alone.
- Legacy allowlist rows can lack `primaryBotId`, `botId`, and bot memberships; keep those rows eligible for access-edge repair instead of filtering them out before repair.
- Fresh `bot_added` candidates must not appear on home until MAX confirms that both the user and at least one runtime bot have admin rights.
- `bot_added` onboarding must not deep-link users straight into managed-entity settings; settings links belong only after the `Старт`/handshake path has confirmed bot and user admin access. A successful handshake must keep the fresh `GRANTED` access edge, active `ChatBotMembership`, `chat:admin-access` cache, and user published snapshot aligned, otherwise home can hide a valid entity.
- New managed chats should reach home through `bot_added` signals, recent bootstrap, allowlist, and published snapshots. Do not reintroduce launch-context assumptions for target chat discovery.
- Managed-entities home/user refresh must not use `GET /chats` / `listBotChats` or full bot-chat scans to find a user's chats. Keep it as a local read-model from access edges, allowlist, published snapshots, recent webhook/local activity, and the exact `Старт` handshake, with MAX used only for bounded targeted candidate checks.
- When recent hydration resolves better chat metadata, keep the user-scoped published snapshot aligned so home does not linger on fallback titles like `Chat <id>`.
- Managed-entities refresh is async. Diagnose `CHAT` and `CHANNEL` separately and trust refresh state/cursor, not only the first response.
- `ChatSettings.antiSpamEnabled` is the fast per-chat sender flood guard for plain text and sticker messages. The hard threshold is `MESSAGE_RATE_LIMIT` on the 6th text/sticker message within 6 seconds; exclude photos, videos, files, voice messages, media batches, and forward-only linked messages from this counter, do not expose threshold controls, and hard-ban only matching burst senders instead of routing them through configurable message-limit escalation.
- Required subscription moderation must check every configured chat/channel, not only a hot-path prefix. Keep checks bounded by `REQUIRED_SUBSCRIPTION_LOOKUP_CONCURRENCY`, and confirm stale missing membership cache with a fresh MAX lookup before delete/sanction.
- Required subscription settings must let admins pick managed chats and channels from fresh managed-entity lists; manual refresh should refresh both entity types, with external links kept as the fallback for entities outside the admin's list.
- Required subscription settings and mass-apply must save only targets whose membership the bot can verify. Drop unverifiable targets, disable the feature if none remain, and keep hot-path moderation fail-open on terminal target access errors.
- Night mode and manual group close are chat-only features, not channel features. Keep their delete gates, transition jobs, and force-close handling scoped to `ChatEntityType.CHAT`: delete non-admin chat messages in `handleUpdate`, do not schedule/process night-mode transitions for `CHANNEL`, and do not add `listMessages` polling, per-chat sleeps, user-message-triggered bot notices, or greeting sends while the chat is closed. Night mode close/open notices are schedule-driven transition work in the background role, not reactions to user messages.
- Stop-words settings are their own section and include both `messageLimitsBlockedWords` and `messageLimitsBlockedDomains`; blocked domains match exact hosts and subdomains independently of link moderation policy, but an explicit link/domain allowlist match suppresses the blocked-domain hit for that allowed link.
- Link allowlist `DOMAIN` rules (`domain:example.com`) match the exact host and its subdomains; `EXACT` rules stay URL-specific. Mini app allowlist entry creation defaults to `DOMAIN` so host-only inputs do not become exact root links by accident.
- Moderation dashboard/feed and membership activity feed should read from maintained read models (`chat_moderation_feed_items`, `chat_moderation_affected_user_hours`, `chat_membership_activity_feed_items`) instead of rebuilding from raw events on each request.
- Global spammer fanout tracking is silent: do not send chat warnings for cross-chat mass posting; use registry/candidate signals plus enforcement or review instead.
- Global spammer registry decisions stay cautious: local admin `BLOCK`/`ALLOW` applies only to that admin scope and is only a weak global reputation signal; natural bans are capped reputation signals, and bans/kicks caused by global-spammer enforcement must not feed back as new evidence.
- In spammer dossier UX, campaign `observationsCount` is cluster-wide scale; show per-user signal counts from observations, graph signals, and campaign-member `userObservationsCount` separately from total campaign observations.
- Keep spammer review lists lightweight: use `includeProfiles=false` and `includeObservations=false` for candidate lists, then load profile/details lazily through the diagnostics sheet.
- Commercial-ad detection lives in `apps/api/src/moderation/commercial/`. Changes to scoring, suppressors, subtypes, campaign lift, or action policy should update the commercial fixtures/benchmark and keep `COMMERCIAL_AD` metadata explainable.
- Global spammer observations, scoring, suppression, graph signals, source reputation, policy diagnostics, review decisions, and expired-row archiving live in `GlobalSpammerIntelligenceService`; active `global_spammers` rows must have a future `expiresAt` because nullable legacy rows are treated as expired. Runtime sanctions should be gated by `evaluatePolicy`/active confirmed decisions, and admin review/diagnostic endpoints should stay in `ManualModerationService` instead of growing legacy `AdminService`. Use `npm run spammers:archive-expired --workspace @maxim/api -- --dry-run --json` before deleting expired registry rows.
- Developer Super Ban uses existing `global_spammers` rows with `DEVELOPER_FORCED`, not a separate blacklist table. Keep the Redis `global-spammer:developer-forced:*` fast path and warm-marker self-heal aligned with `DEVELOPER_FORCED` registry rows, but do not auto-enforce forced entries in chats where `deleteSpammersEnabled=false`; that toggle is the per-chat consent gate for global-spammer delete/kick. It should not send a separate "accepted" notice or synchronously fan out across every managed chat; handle and clean the source chat immediately, send one DB-estimated final coverage notice, and let later webhook moderation enforce the blacklist only in chats that enabled spammer deletion.
- Use `npm run moderation:audit-commercial --workspace @maxim/api -- --since <iso> --until <iso> --limit <n>` for local commercial-filter audits. On VPS run the built script inside `api-admin`, for example `docker compose -p infra -f infra/docker-compose.yml exec -T api-admin node apps/api/dist/apps/api/src/scripts/audit-commercial-filter.js --since <iso> --until <iso> --limit <n>`.
- For sanitized commercial corpus exports, pass `--export-corpus-jsonl <path>` to the audit command and add `--export-all-corpus` when validating corpus gates so stable-clear negative candidates are included. Validate with `npm run moderation:validate-commercial-corpus --workspace @maxim/api -- --input <path>`; relative inputs resolve from `apps/api`, so use `src/...` or an absolute path.
- Channel statistics should open from cached/read-model data. Use `channel_stats_bucket_rollups` for membership, posts, views, and reactions; keep raw `channel_posts` reads limited to compact top-post/top-reaction details. Do not block `GET /channels/:chatId/stats` on MAX refresh; queue stale refresh in the background and request `includeActivityPreview=false` for the mini app's first stats paint.
- Channel statistics audience graphs should plot joined/left net growth from `series.membership`; use `series.participants` only as total-audience context. Period views should use observed `viewsDelta` when it exists, with `latestTotal`/`viewsTotal` only as the no-delta fallback.
- Channel statistics screens should stay factual. Do not add "What to do next", smart recommendations, pseudo-AI advice, or coaching copy; prefer neutral metrics, freshness/source coverage, charts, top posts, and best publishing windows.
- Managed giveaway prize titles must be unique per giveaway before persistence/publication. If an admin enters repeated labels such as ten "Прикормка" prizes, normalize them to separate slots like "Прикормка 1" ... "Прикормка 10" instead of relying on client-side UI state alone.
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
