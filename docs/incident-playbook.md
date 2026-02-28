# Incident Playbook

## Webhook 403 spike
- Verify `MAX_WEBHOOK_SECRET_PATH` and `MAX_WEBHOOK_HEADER_SECRET` in `.env`.
- Check reverse proxy preserves `x-max-secret` header.

## Queue backlog
- Inspect Redis and queue depth.
- Scale API replicas if needed.
- Verify MAX API availability.

## False-positive moderation
- Review `moderation_events` records.
- Lower profanity/caps thresholds in mini-app for affected chat.
- Add domain exceptions where needed.
