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
3. Start infra (db/redis): `docker compose -f infra/docker-compose.yml up -d postgres redis`.
4. Run API: `npm run dev --workspace @maxim/api`.
5. Run mini-app: `npm run dev --workspace @maxim/miniapp`.

## Security note
Never commit real bot tokens or production secrets.
