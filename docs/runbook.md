# Runbook

## First deployment
1. Create `.env` from `.env.example` on server.
2. Set real values for all MAX and security secrets.
3. `docker compose -f infra/docker-compose.yml up -d --build`
4. `docker compose -f infra/docker-compose.yml exec -T api npm run prisma:migrate:deploy --workspace @maxim/api`
5. Register MAX webhook URL:
   `https://maxim.play-team.ru/api/webhook/max/id613002203036_4_bot/<MAX_WEBHOOK_SECRET_PATH>`

## Health checks
- Live: `GET /api/health/live`
- Ready: `GET /api/health/ready`

## Rollback
1. `git checkout <last-stable-tag>`
2. `infra/scripts/deploy.sh`
