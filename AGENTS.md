# Agent Notes

## Purpose

- These notes accelerate work; the repository remains the source of truth.
- If notes conflict with code, `package.json`, Compose, or scripts, trust the repo and fix the nearest relevant `AGENTS.md`.
- Keep agent notes durable and repo-verified. Put incidents and historical infrastructure observations in docs, not active instructions.

## Scoped Instructions

- Read the nearest scoped notes before editing:
  - `apps/api/AGENTS.md`: API architecture, Prisma, MAX integration, and domain invariants.
  - `apps/miniapp/AGENTS.md`: MAX mini app UI, bridge, WebView, CSS, and visual validation.
  - `apps/admin/AGENTS.md`: closed Safety Desk UI and its authentication boundary.
  - `packages/contracts/AGENTS.md`: shared contract exports and consumer impact.
  - `infra/AGENTS.md`: Compose, nginx, VPS deploy, rollback, stateful services, and production smokes.
- A deeper scoped file supplements this root file. Root workflow and safety rules still apply.

## Project Shape

- npm workspaces:
  - `apps/api`: NestJS/Fastify, Prisma, BullMQ, Postgres, and Redis.
  - `apps/miniapp`: React 19/Vite MAX mini app served under `/app/`.
  - `apps/admin`: closed React/Vite Safety Desk; it is not a MAX mini app.
  - `packages/contracts`: shared Zod schemas and API types.
- Production uses one API image split by `APP_ROLE` and `APP_SERVICE_NAME`, plus `miniapp-major-static` and `admin-static`.
- `https://major-maksimov.ru/app/` is the only routine production mini app URL. CDN, Object Storage, and app2 delivery are paused.

## Core Workflow

- Unless the user says not to deploy, runtime changes in API, mini app, contracts, Prisma, Docker, or MAX integration finish with local validation and the scoped VPS deploy.
- Docs, agent notes, README, test-only changes, and cleanup do not require VPS deploy unless requested.
- Prefer focused checks while iterating, then broaden in proportion to the change:
  - `npm run typecheck:contracts`
  - `npm run check:api`
  - `npm run check:prisma`
  - `npm run check:miniapp`
  - `npm run typecheck:admin && npm run test:admin`
  - `npm run check:refactor-guards`
  - `npm run check` for broad or risky work
- Public API validation scripts now serialize generated-contract and Prisma work. Do not bypass them with `*:unlocked` or `*:source` commands unless a repo script intentionally owns the lock.
- Use Node 24 LTS. Root `.nvmrc` pins `24`; Docker dependency layers must remain lockfile-based with `npm ci`.
- Local start:
  - `docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml up -d postgres redis`
  - `npm run dev:all`, or `npm run dev:api`, `npm run dev:miniapp`, and `npm run dev:admin`

## Impact Guide

- `node scripts/agent/plan.mjs --worktree` is the read-only human/JSON planner for checks, migrations, deploy components, and manual operations. VPS deploy uses the checked-in Bash classifier generated from the same `config/change-impact.json`; `npm run check:infra` rejects a stale generated mapping.
- API runtime files map to the shared API image and every role; API specs/tests alone do not deploy.
- Contract runtime files map to contracts plus API, mini app, and Safety Desk consumers.
- Prisma schema/migration files map to shared API validation/deploy and require the migration review described in API notes.
- Mini app runtime/assets map to `miniapp-major-static`; mini app tests alone do not deploy.
- Safety Desk runtime maps to `admin-static`; admin tests alone do not deploy.
- Root dependency lock/build config changes can affect every image and require broad validation.
- Nginx changes are manual site operations, not a substitute for container deploy.
- Unknown new paths fail closed in both planners with full validation and all active deploy components selected for review.
- Renames affect both old and new scopes; do not classify only the destination.

## Delivery Rules

- Prefer repo wrappers:
  - commit/push: `./infra/scripts/local-commit-push.sh "<message>" main`
  - deploy: `./infra/scripts/vps-connect.sh deploy main [services|--plan|--auto|--full]`
  - immutable component rollback: `./infra/scripts/vps-connect.sh rollback-release <release-id> [components...]`
  - API ref-based fallback rollback: `./infra/scripts/vps-connect.sh rollback-runtime <git-ref> [services...]`
- `local-commit-push.sh` is staged-only by default, validates only the staged impact, commits, and pushes the exact resulting `HEAD`. Use `--all` only when broad staging is intentional.
- Every `AGENTS.md` is excluded from `--all` unless `--include-agents` is present. The helper also refuses already-staged agent notes without that flag.
- Local production deploy requires successful `Required` and `Analyze JavaScript and TypeScript` checks from GitHub Actions for the exact selected commit, then verifies that the synchronized VPS `HEAD` is the same SHA. Emergency bypass requires an explicit reason.
- Active release components use full-SHA image refs and component manifests under `/var/lib/maxim-deploy`. The deploy records a new current manifest only after strict smokes; static-only deploys do not run Prisma migrations.
- Never bypass the deploy disk preflight for a clean shared API build with less than 20 GiB free on `/var/lib/docker`. The API build plus migrations can temporarily consume more than 15 GiB even when the final image is much smaller; reclaim only unused cache/images, otherwise expand the disk or preload a reviewed immutable image.
- Shared API or contract changes must recreate every production API role because all roles use one image; the exact list lives in `infra/AGENTS.md` and `infra/scripts/lib/deploy-topology.sh`.
- Routine mini app work deploys and smokes `miniapp-major-static` at `https://major-maksimov.ru/app/`; never add CDN/app2/Object Storage fallback steps.
- Safety Desk UI deploys `admin-static`; server/API authentication changes also deploy the shared API roles.
- Rebuild only affected components. Do not recreate Postgres or Redis as part of an ordinary application deploy.

## Cross-Workspace Boundaries

- Contract changes normally require contracts, API, mini app, and admin validation plus corresponding runtime deploys.
- Keep contract subpath exports, root TypeScript paths, and API Jest mappers aligned.
- Keep `apps/api/src/runtime/runtime-topology.ts`, Compose `APP_ROLE`/`APP_SERVICE_NAME`, and deploy topology aligned.
- Refactor guards track real `*.legacy` implementations. Import public facade modules; only thin facade files may import `.legacy` modules.
- Runtime hot paths use focused boundaries: `WebhookIngestionService`, `ModerationExecutionService`, `MaxActionDispatchService`, and `ManagedEntitiesDiscoveryService`.
- Admin runtime entry points use focused facades where available: `ManagedEntitiesService`, `AdminSettingsService`, `ManagedBroadcastService`, `ManualModerationService`, `ChannelDialogService`, and `ManagedGiveawayService`.

## Change Discipline

- Keep edits within the ownership boundary implied by the request; avoid unrelated refactors and metadata churn.
- Work with a dirty tree: preserve unrelated user and agent changes, stage only owned files, and never revert another change incidentally.
- Do not use destructive Git commands unless explicitly requested.
- Do not commit secrets, dumps, local exports, generated build output, screenshots, or one-off debug files.
- Keep local agent/tool traces ignored. Remove transient `.codex`, build, coverage, and debug artifacts at handoff when they are yours.
- Before handoff, inspect `git status --short` and report validation or deployment that could not be run.
- Run `git diff --check` on owned edits before handoff.
- Do not format the whole repository during a scoped task; format only owned files when required.

## Durable Knowledge

- After each task, make a short self-learning pass:
  - fix small in-scope issues exposed by the work when low risk;
  - add only stable commands, service names, product invariants, integration quirks, or validation shortcuts to the nearest scoped notes;
  - encode narrow invariants as tests, types, helpers, or code comments instead of growing agent notes;
  - never record secrets, guesses, one-off output, personal notes, or temporary production state.
- Prefix new sensitive-zone comments with `FLAG:`. Before editing a flagged block, read the invariant twice; do not remove flags incidentally.
- When topology, deploy scripts, service names, or core workflows change, update the relevant scoped notes and active runbooks in the same work.
