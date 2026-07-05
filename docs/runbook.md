# Runbook

## First deployment

1. Create `.env` from `.env.example` on server.
2. Set real values for all MAX and security secrets.
3. `docker compose -f infra/docker-compose.yml up -d --build`
4. `docker compose -f infra/docker-compose.yml exec -T api npm run prisma:migrate:deploy --workspace @maxim/api`
5. Let the ingress reconciler create MAX webhook subscriptions from `MAX_WEBHOOK_BASE_URL`.
   For the current production host the fallback manual URL is
   `https://major-maksimov.ru/api/webhook/max/<bot-id>/<MAX_WEBHOOK_SECRET_PATH>`.

## Health checks

- Public live: `GET /api/health/live`
- Local-on-VPS ready: `GET http://127.0.0.1:3001/api/health/ready`
  (and `http://127.0.0.1:3002/api/health/ready` for `api-admin`).
  The public `/api/health/ready` endpoint is intentionally hidden.

## Local access to production

1. On each device, copy `infra/env/vps.env.example` to root `.env.vps`.
2. Fill either the SSH target/key settings or the Yandex Cloud fallback fields.
3. Check access with `./infra/scripts/vps-connect.sh doctor`.
4. Use `./infra/scripts/vps-connect.sh shell`, `health`, `ps`, `logs <service>`, or `deploy main [services...]`.

## Rollback

1. `git checkout <last-stable-tag>`
2. `./infra/scripts/vps-connect.sh deploy main`
