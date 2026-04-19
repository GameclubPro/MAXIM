# Agent Notes

## Purpose
- This file should accelerate work, not override the repo.
- If `AGENTS.md` conflicts with `package.json`, Docker Compose, scripts, or the current code, trust the repo and update this file.
- Keep this file short, stable, and repo-verified. Do not store temporary incidents, dated prod observations, or assumptions that will drift.

## Core workflow
- For runtime-affecting changes in `apps/api`, `apps/miniapp`, Prisma, Docker, or MAX integration, the default finish is: local validation plus VPS deploy, unless the user explicitly says not to deploy.
- Docs, `AGENTS.md`, `README.md`, test-only changes, and cleanup changes do not require VPS deploy unless the user asks for it.
- Prefer repo scripts over long manual sequences:
  - local push: `./infra/scripts/local-commit-push.sh "<message>" main`
  - VPS update: `./infra/scripts/vps-pull-build-up.sh main [services...]`
- `./infra/scripts/local-commit-push.sh` excludes `AGENTS.md` by default. Use `--include-agents` only when you intentionally want to commit agent-note changes.
- Rebuild only changed services. In practice that is usually `miniapp-static` and/or the shared API image.
- If shared API code changed, recreate every prod API role that uses that image:
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
  - `npm run typecheck --workspace @maxim/api`
  - `npm run typecheck --workspace @maxim/miniapp`
  - `npm test --workspace @maxim/api -- <spec-or-pattern>`
- If `apps/api/prisma/schema.prisma` changes, include a migration before push.

## Local development
- Quick start:
  - `docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml up -d postgres redis`
  - `npm run dev --workspace @maxim/api`
  - `npm run dev --workspace @maxim/miniapp`
- Mini app iteration:
  - `npm run emulator:miniapp -- --device iphone --reuse-server`
  - `npm run emulator:miniapp:android -- --reuse-server`
  - add `--route '<path>'` to jump directly to the screen under work
- For material UI changes, verify in the emulator or screenshots instead of judging only by code.
- Prefer checking both iPhone and Android sized previews, safe-area behavior, and keyboard behavior.
- Use screenshots after the layout is close. Local screenshot output lives under `artifacts/miniapp-screenshots/`.
- Prefer local iteration for mini app CSS/TSX work. Avoid full Docker rebuilds unless container parity is the point of the task.

## Deploy and VPS
- Primary aliases, if configured locally:
  - `ssh maxim-vps`
  - `ssh maxim-vps-edge`
  - `ssh maxim-vps-legacy`
- If plain SSH stalls before the banner or times out, treat that as a Yandex Cloud access issue first. Prefer `yc compute ssh` as the recovery path and verify that the VM security group allows `22/tcp` from the current public IP.
- Keep Yandex Cloud service-account keys only in local ignored files or configured `yc` profiles, never in git.
- Use `docker compose` only.
- Main prod stack: `infra/docker-compose.yml`
- Split/load-testing stack: `infra/docker-compose.scale.yml`
- Independent custom bots that must stay out of the main multi-bot registry should run as separate compose projects with their own env/DB/Redis. Current example: `infra/docker-compose.reshenie.yml` + `./infra/scripts/vps-pull-build-up-reshenie.sh`.
- Do not run both stacks at the same time.
- The `vps-pull-build-up*.sh` scripts are designed to run on the VPS host. From local machine, invoke them through SSH.
- If `/var/www/Chat_bot/.env` is missing, restore it from any running API role container before `docker compose exec` or `docker compose run`. Current scripts check role-based containers first and keep `infra-api-1` only as a legacy fallback.
- For standalone stacks, keep secrets in a dedicated ignored env file such as `.env.reshenie`. Do not add independent bots to `MAX_BOTS_JSON`.
- If a standalone bot uses its own `APP_BASE_URL` prefix, ship the matching prefixed mini app too, for example `/reshenie/app/` with `/reshenie/api/`.
- If `git pull --ff-only` is blocked by a dirty VPS worktree:
  - if current tracked contents already match `origin/<branch>`, `git stash push -> git pull --ff-only -> git stash drop` is acceptable
  - if local VPS changes differ from `origin/<branch>`, stop and report the conflict
- After a runtime deploy, always:
  - apply Prisma migrations
  - rebuild only changed services
  - recreate containers with `--force-recreate`
  - check `/api/health/live` and `/api/health/ready` locally and publicly
  - check `https://maxim.play-team.ru/app/` when mini app flows were touched
- For standalone bot deploys behind a path prefix, check the prefixed health endpoints too, for example `/reshenie/api/health/live` and `/reshenie/api/health/ready`.
- During API deploys, `ready` can recover later than `live` while queues drain. Treat that as a recovery window first, not an instant regression.
- If `/app/` returns `502`, check `docker compose ps miniapp-static` first.

## MAX integration
- For MAX Bot API, Mini Apps, `init_data`, webhook behavior, and deep links, verify against current official MAX docs instead of memory.
- Source priority:
  1. `https://dev.max.ru/docs/`
  2. `https://dev.max.ru/docs-api/`
  3. `https://help.max.ru/help/bots`
  4. `https://github.com/max-messenger`
- When users format text in the MAX client, treat formatting as `message.body.markup`, not as literal markdown typed by the user. Preserve or reconstruct formatting from `markup` when importing, editing, or republishing text.
- Treat MAX `markup.from` and `markup.length` as JavaScript string offsets for the original text. Do not remap them through `Array.from(...)` or code-point indexing, especially on emoji-rich text.
- Treat `initDataUnsafe` as convenience only. Authentication and trust must rely on validated `initData`.
- Keep bot tokens and webhook secrets only in VPS secrets or `.env`, never in git.
- Treat MAX mini apps as bot-scoped entry points. Do not assume the launch context identifies a managed target chat or channel on home; user-facing discovery should rely on allowlist, published snapshots, and recent `bot_added` signals.
- In hot moderation paths, prefer targeted MAX access checks such as `getCurrentChatMemberAccess` or `getChatMembersAccess` over full admin-list fetches unless the feature truly needs the full roster.
- After changing webhook host or domain, re-read `GET /subscriptions` and recreate the target subscription instead of assuming MAX updated its bound secret automatically.
- Keep `APP_BASE_URL` and `MAX_WEBHOOK_BASE_URL` aligned when the intended canonical prod host is `https://maxim.play-team.ru`.
- For MAX deep links, keep `startapp` payloads within the current documented constraints and use MAX-specific navigation only for MAX URLs.

## Data model and product rules
- Multi-bot chat ownership is modeled as `Chat.primaryBotId` plus `ChatBotMembership`. Treat `Chat.botId` as transitional compatibility only.
- Managed entities are aggregated per unique chat or channel. Do not duplicate cards per bot.
- The public mini app should not expose internal primary, standby, or execution-owner details.
- Managed-entities refresh is async. Diagnose `CHAT` and `CHANNEL` separately and trust refresh state/cursor, not only the first response.

## Repo hygiene
- Do not commit secrets, local exports, dumps, build artifacts, or one-off debug files.
- Safe cleanup targets include `dist/`, `coverage/`, screenshot artifacts, and temporary root debug exports.
- Keep local agent/tooling traces ignored. Repo-local Codex leftovers such as `.codex` must not remain tracked or untracked at handoff.
- Before finalizing work, run `git status --short` and leave the tree clean: commit intentional changes, and remove or ignore transient files.
- When runtime topology, deploy scripts, service names, or core workflows change, update this file in the same line of work.
