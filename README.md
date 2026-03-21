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
