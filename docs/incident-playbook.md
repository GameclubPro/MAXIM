# Incident Playbook

## Webhook 403 spike
- Verify `MAX_WEBHOOK_SECRET_PATH` and `MAX_WEBHOOK_HEADER_SECRET` in `.env`.
- Check reverse proxy preserves `x-max-bot-api-secret` header.

## Queue backlog
- Inspect Redis and queue depth.
- Scale API replicas if needed.
- Verify MAX API availability.
- Use `GET /api/health/ready` and inspect `checks.queueLag`:
  - `oldestQueuedEventId`, `oldestQueuedCreatedAt`,
  - `oldestReceivedEventId`, `oldestReceivedCreatedAt`.
- If `effectiveLagSec` grows and `QUEUED` is stale:
  1. Check DB statuses:
     - `select status,count(*) from webhook_events group by status order by status;`
  2. Check failed jobs:
     - `docker compose -f infra/docker-compose.yml exec -T api node -e "/* bullmq getJobCounts/getFailed */"`
  3. Apply operational policy for stale events:
     - quarantine (set `FAILED`, `next_enqueue_at=null`) for explicitly approved IDs, or
     - reprocess after root-cause fix.
  4. Re-check `ready` and confirm `effectiveLagSec` returns to `0`.

## Domain allowlist drift (legacy path/query rows)
- Canonicalization SQL (idempotent):
  - deduplicate by normalized `host[:port]`,
  - keep one active row per domain,
  - remove legacy path/query duplicates.

## False-positive moderation
- Review `moderation_events` records.
- Lower profanity thresholds in mini-app for affected chat.
- Add domain exceptions where needed.
