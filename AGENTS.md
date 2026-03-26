# Agent Notes

## Core workflow
- For runtime-affecting changes in `apps/api`, `apps/miniapp`, Prisma, Docker, MAX integration, default finish is: local validation plus deploy to VPS.
- Docs, `AGENTS.md`, `README.md`, test-only changes, debug cleanup, and other non-runtime repo maintenance do not require VPS deploy unless the user asks for it.
- Prefer repo scripts over long manual sequences:
  - Local push: `./infra/scripts/local-commit-push.sh "<message>" main`
  - VPS update: `./infra/scripts/vps-pull-build-up.sh main [services...]`
- Rebuild only changed services. In this repo that is usually `api` and/or `miniapp-static`.

## VPS
- SSH alias: `ssh maxim-vps`
- `maxim-vps` should use SSH multiplexing: `ControlMaster auto`, `ControlPersist 10m`, `Compression yes`.
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
  - check `live` and `ready` health locally and publicly.

## MAX
- For MAX Bot API, Mini Apps, `init_data`, webhook, and `open_app`, verify against current official MAX docs instead of memory.
- Source priority:
  1. `https://dev.max.ru/docs/`
  2. `https://dev.max.ru/docs-api/`
  3. `https://help.max.ru/help/bots`
  4. `https://github.com/max-messenger`
- When onboarding, moderation entry flows, or webhook behavior are in scope, inspect `GET /subscriptions`.
- Minimum expected webhook events are `message_created`, `user_added`, `bot_added`; in practice also check `bot_started`.

## Managed entities diagnostics
- The mini app shows only the intersection where the user is admin and the bot also has admin access to the same chat/channel.
- Counts for `Чаты` and `Каналы` can differ because the UI uses `chat_admin_allowlist` plus progressive refresh, not an instant full MAX snapshot.
- Diagnose `CHAT` and `CHANNEL` separately.
- Full refresh is complete only when the Redis cursor becomes `-1`.
- For visibility problems, check:
  - `chat_admin_allowlist` rows for the `user_id`,
  - Redis keys `chat:managed-refresh-cursor:v1:<entityType>:<userId>` and `chat:managed-refresh-backoff:v1:<entityType>:<userId>`,
  - refreshed `AdminService.listChats(..., { refresh: true })` or `AdminService.listChannels(..., { refresh: true })`.

## Mini app UI work
- For material UI changes, verify the result in preview or screenshots instead of judging only by code.
- Prefer the newest screenshots in `artifacts/miniapp-screenshots/<timestamp>`.
- If local Playwright/browser deps are unavailable, use the VPS flow:
  - `cd /var/www/Chat_bot && ./infra/scripts/vps-miniapp-preview-screenshots.sh`

## Repo hygiene
- Keep the repo root focused on source, docs, infra, and stable config.
- Do not commit local exports, dumps, one-off debug files, or build artifacts.
- Safe cleanup targets are generated outputs such as `dist/`, `coverage/`, screenshot artifacts, root debug exports like `rostov-*`, `autorinok-users.txt`, and temporary files like `TEST_COMMIT.txt`.
