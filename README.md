# MAX Moderation Bot + Mini-App

Production-ready monorepo for MAX chat moderation bot and admin mini-app.

## Stack

- API: NestJS + Fastify + Prisma + BullMQ + Redis
- Mini-app: React + Vite + TypeScript
- Database: Postgres
- Infra: Docker Compose + Nginx + Certbot

## Quick start

1. Copy `.env.example` to `.env` and set secrets.
2. Install dependencies: `npm install`.
3. Start infra (db/redis) for local host access:
   `docker compose -f infra/docker-compose.yml -f infra/docker-compose.local.yml up -d postgres redis`.
4. Run API: `npm run dev --workspace @maxim/api`.
5. Run mini-app: `npm run dev --workspace @maxim/miniapp`.

The `.env.example` file now includes a multi-bot example:
- the default bot stays the primary visible bot,
- `MAX_ENTRY_BOT_ID` keeps `start` / `startapp` links on one canonical entry bot even when ownership is split across multiple bots,
- additional bots are listed in `MAX_BOTS_JSON`,
- use `state: "dormant"` for a pre-provisioned second bot that should appear in admin metadata but must not process webhooks or actions yet.

## Standalone Bot On The Same VPS

For an isolated custom bot that must not share the main multi-bot registry, use the dedicated standalone stack instead of `MAX_BOTS_JSON`:
- env template: `infra/env/reshenie.env.example`
- compose project: `infra/docker-compose.reshenie.yml`
- VPS deploy: `./infra/scripts/vps-pull-build-up-reshenie.sh main`

This stack runs the same API image as a separate single-process service with its own Postgres, Redis, webhook path, and ignored root env file `.env.reshenie`.
It also ships its own mini-app under `/reshenie/app/`, so `APP_BASE_URL=https://maxim.play-team.ru/reshenie` stays consistent.

## Mini-app mobile emulator

- iPhone preview: `npm run emulator:miniapp`
- Android preview: `npm run emulator:miniapp:android`
- Custom screen: `npm run emulator:miniapp -- --device android --route '/chat/preview-chat/settings?focus=broadcast'`

The emulator starts the Vite mini-app locally, opens `/app/?preview=1` with mock data, and applies a Playwright mobile device profile so you can inspect the mini-app in a phone-sized browser immediately.

## Role-based API runtime

- Single process (default): `APP_ROLE=all`.
- Split roles:
  - ingress: `npm run dev:ingress --workspace @maxim/api`
  - enqueue: `npm run dev:enqueue --workspace @maxim/api`
  - moderation: `npm run dev:moderation --workspace @maxim/api`
  - action: `npm run dev:action --workspace @maxim/api`

For Docker-based split runtime use `infra/docker-compose.scale.yml`.

## Security note

Never commit real bot tokens or production secrets.

## Documentation

- Detailed project description: `docs/project-description.md`
- Bot card description (Major Maksimov): `docs/bot-card-description-major-maksimov.md`
