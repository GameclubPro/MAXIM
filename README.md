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
- use `state: "dormant"` for pre-provisioned additional bots that should appear in admin metadata but must not process webhooks or actions yet.

## Prod / VPS Access From Any Device

Each local device should keep its own ignored VPS access config:

```sh
cp infra/env/vps.env.example .env.vps
$EDITOR .env.vps
./infra/scripts/vps-connect.sh doctor
```

The wrapper runs repo-standard commands on the VPS without storing secrets in git:

```sh
./infra/scripts/vps-connect.sh shell
./infra/scripts/vps-connect.sh health
./infra/scripts/vps-connect.sh deploy main miniapp-static
./infra/scripts/vps-connect.sh deploy main api-ingress api-admin api-enqueue api-moderation api-moderation-critical api-moderation-join api-moderation-realtime-b api-moderation-realtime-c api-moderation-realtime-d api-moderation-background api-action
```

`npm run vps -- <command>` and `npm run prod -- <command>` call the same wrapper. If direct SSH is unavailable, configure the optional Yandex Cloud fields in `.env.vps` and use `./infra/scripts/vps-connect.sh yc-shell` for manual recovery.

## Mini-app mobile emulator

- iPhone preview: `npm run emulator:miniapp`
- Android preview: `npm run emulator:miniapp:android`
- Custom screen: `npm run emulator:miniapp -- --device android --route '/chat/preview-chat/settings?focus=broadcast'`
- Production visual audit: `npm run audit:miniapp:visual`

The emulator starts the Vite mini-app locally, opens `/app/?preview=1` with mock data, and applies a Playwright mobile device profile so you can inspect the mini-app in a phone-sized browser immediately.

Use `--target native` for MAX-like full-screen inspection. Native emulator and native screenshots install a safe MAX Bridge shim by default: `window.MAX.WebApp`/`window.WebApp` expose preview `initData`, platform, BackButton, haptics, share/download, and native storage while recording calls in `window.__MAXIM_VISUAL_BRIDGE_EVENTS__` instead of closing or leaving the page. Pass `--no-max-bridge` to the emulator, or set `MINIAPP_SCREENSHOT_MAX_BRIDGE=0` only when you intentionally need a bridge-free browser check.

The visual audit uses the production `/app/` domains (`major-maksimov.ru` and the restricted-LTE `app2.major-maksimov.ru` shell), native-like screenshots without the preview frame, Android/iPhone/iPhone SE profiles, light/dark schemes, simulated keyboard state, the MAX Bridge shim, and strict layout assertions for blank screens, viewport overflow, fixed controls, comments safe-area, and charts. Use `MINIAPP_VISUAL_AUDIT_QUICK=1 npm run audit:miniapp:visual` for a shorter preflight.

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
