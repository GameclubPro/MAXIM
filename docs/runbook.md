# Runbook

## First deployment

1. Create `.env` from `.env.example` on server.
2. Set real values for all MAX and security secrets.
3. `docker compose -f infra/docker-compose.yml up -d --build`
4. `docker compose -f infra/docker-compose.yml exec -T api npm run prisma:migrate:deploy --workspace @maxim/api`
5. Register MAX webhook URL:
   `https://maxim.play-team.ru/api/webhook/max/id613070470872_9_bot/<MAX_WEBHOOK_SECRET_PATH>`

## Health checks

- Live: `GET /api/health/live`
- Ready: `GET /api/health/ready`

## Local access to production

1. On each device, copy `infra/env/vps.env.example` to root `.env.vps`.
2. Fill either the SSH target/key settings or the Yandex Cloud fallback fields.
3. Check access with `./infra/scripts/vps-connect.sh doctor`.
4. Use `./infra/scripts/vps-connect.sh shell`, `health`, `ps`, `logs <service>`, or `deploy main [services...]`.

## Rollback

1. `git checkout <last-stable-tag>`
2. `./infra/scripts/vps-connect.sh deploy main`
